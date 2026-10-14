//! 本地数据库（SQLite）
//!
//! 技术方案第 8 节把「SQLite 迁移」列入阶段 B。这里的做法：
//!   - 连接由 `Arc<Mutex<Connection>>` 持有。SQLite 的写是串行的，一把锁足够了，
//!     不需要连接池；桌面应用不会有并发写入的压力。
//!   - 所有阻塞操作都由命令层放进 `spawn_blocking`，不占住异步运行时线程。
//!   - 迁移按版本号顺序执行，跑过的记在 `schema_migrations` 里，重复执行是安全的。
//!
//! 有一条纪律写死在表结构里：**没有 api_key 相关的列或键**。
//! 凭据走 `secrets` 模块，交给系统凭据存储。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{
    AppendMessageInput, AppSettings, Conversation, CreateConversationInput,
    DEFAULT_CONVERSATION_TITLE, Message, MessagePatch, PersistedModelConfig, PersonaConfig,
    StorageLocation, derive_title_from_message, normalize_title,
};

/// 迁移脚本按版本号排列，只增不改：已经跑过的版本在用户机器上不会再跑一次。
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/0001_init.sql"))];

/// 当前时间戳（毫秒）
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    path: String,
}

impl Database {
    /// 打开（必要时创建）数据库文件，并把迁移跑到最新
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AppError::DatabaseOpen(format!("无法创建数据目录：{error}")))?;
        }

        let conn = Connection::open(path)
            .map_err(|error| AppError::DatabaseOpen(format!("无法打开数据库文件：{error}")))?;

        let database = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: path.to_string_lossy().to_string(),
        };
        database.prepare_connection()?;
        database.migrate()?;
        Ok(database)
    }

    /// 内存库，仅用于测试
    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|error| AppError::DatabaseOpen(error.to_string()))?;
        let database = Self {
            conn: Arc::new(Mutex::new(conn)),
            path: ":memory:".to_string(),
        };
        database.prepare_connection()?;
        database.migrate()?;
        Ok(database)
    }

    pub fn location(&self) -> StorageLocation {
        StorageLocation {
            database_path: self.path.clone(),
            driver: "SQLite（Rust 侧，rusqlite bundled）".to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // 基础设施
    // -----------------------------------------------------------------------

    fn with_conn<T>(&self, action: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| AppError::Internal("数据库连接状态异常，请重启应用。".to_string()))?;
        action(&guard)
    }

    fn prepare_connection(&self) -> AppResult<()> {
        self.with_conn(|conn| {
            // 外键约束默认是关的，而消息的级联删除完全依赖它
            conn.pragma_update(None, "foreign_keys", "ON")?;
            conn.pragma_update(None, "busy_timeout", 5000)?;
            // journal_mode 会返回一行结果，所以用 query_row 而不是 execute
            let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
            Ok(())
        })
    }

    fn migrate(&self) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (
                     version    INTEGER PRIMARY KEY,
                     applied_at INTEGER NOT NULL
                 );",
            )?;

            let applied: i64 = conn.query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )?;

            for (version, sql) in MIGRATIONS {
                if *version <= applied {
                    continue;
                }
                // 每个版本一个事务：要么整步生效，要么整步不生效，
                // 不会出现「表建了一半」这种没法收场的中场状态
                let transaction = conn.unchecked_transaction()?;
                transaction.execute_batch(sql)?;
                transaction.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                    params![version, now_ms()],
                )?;
                transaction.commit()?;
            }
            Ok(())
        })
    }

    /// 已应用的最高迁移版本号（测试用）
    #[cfg(test)]
    pub fn applied_version(&self) -> AppResult<i64> {
        self.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )?)
        })
    }

    // -----------------------------------------------------------------------
    // conversations
    // -----------------------------------------------------------------------

    pub fn list_conversations(&self) -> AppResult<Vec<Conversation>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, title, created_at, updated_at, archived
                 FROM conversations
                 ORDER BY updated_at DESC, created_at DESC",
            )?;
            let rows = statement.query_map([], map_conversation)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    pub fn get_conversation(&self, id: &str) -> AppResult<Option<Conversation>> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, title, created_at, updated_at, archived
                     FROM conversations WHERE id = ?1",
                    params![id],
                    map_conversation,
                )
                .optional()?)
        })
    }

    pub fn create_conversation(
        &self,
        input: CreateConversationInput,
    ) -> AppResult<Conversation> {
        let now = now_ms();
        let conversation = Conversation {
            id: new_id("conv"),
            title: normalize_title(input.title.as_deref().unwrap_or(DEFAULT_CONVERSATION_TITLE)),
            created_at: input.created_at.unwrap_or(now),
            updated_at: input.created_at.unwrap_or(now),
            archived: input.archived.unwrap_or(false),
        };

        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at, archived)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    conversation.id,
                    conversation.title,
                    conversation.created_at,
                    conversation.updated_at,
                    i64::from(conversation.archived)
                ],
            )?;
            Ok(())
        })?;

        Ok(conversation)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> AppResult<Option<Conversation>> {
        let updated = self.with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, normalize_title(title), now_ms()],
            )?;
            Ok(changed)
        })?;

        if updated == 0 {
            return Ok(None);
        }
        self.get_conversation(id)
    }

    /// 删除会话。消息由外键 ON DELETE CASCADE 一并删除 ——
    /// 这条依赖连接上的 `PRAGMA foreign_keys = ON`，两处必须同时成立。
    pub fn delete_conversation(&self, id: &str) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
            Ok(())
        })
    }

    pub fn touch_conversation(&self, id: &str, at: Option<i64>) -> AppResult<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
                params![id, at.unwrap_or_else(now_ms)],
            )?;
            Ok(())
        })
    }

    // -----------------------------------------------------------------------
    // messages
    // -----------------------------------------------------------------------

    pub fn list_messages(&self, conversation_id: &str) -> AppResult<Vec<Message>> {
        self.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, conversation_id, role, content, status, created_at
                 FROM messages WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC",
            )?;
            let rows = statement.query_map(params![conversation_id], map_message)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// 追加一条消息。
    /// 三件事必须一起发生，所以放在一个事务里：
    ///   1. 插入消息
    ///   2. 推进会话的 updated_at（列表排序靠它）
    ///   3. 首条用户消息升格为会话标题
    pub fn append_message(&self, input: AppendMessageInput) -> AppResult<Message> {
        let now = now_ms();
        let message = Message {
            id: new_id("msg"),
            conversation_id: input.conversation_id.clone(),
            role: input.role.clone(),
            content: input.content.clone(),
            status: input.status.unwrap_or_else(|| "complete".to_string()),
            created_at: now,
        };

        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;

            let title: Option<String> = transaction
                .query_row(
                    "SELECT title FROM conversations WHERE id = ?1",
                    params![input.conversation_id],
                    |row| row.get(0),
                )
                .optional()?;

            let Some(title) = title else {
                return Err(AppError::Invalid("会话不存在，消息未能写入。".to_string()));
            };

            transaction.execute(
                "INSERT INTO messages (id, conversation_id, role, content, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    message.id,
                    message.conversation_id,
                    message.role,
                    message.content,
                    message.status,
                    message.created_at
                ],
            )?;

            if input.role == "user" && title == DEFAULT_CONVERSATION_TITLE {
                transaction.execute(
                    "UPDATE conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
                    params![
                        input.conversation_id,
                        derive_title_from_message(&input.content),
                        now
                    ],
                )?;
            } else {
                transaction.execute(
                    "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
                    params![input.conversation_id, now],
                )?;
            }

            transaction.commit()?;
            Ok(())
        })?;

        Ok(message)
    }

    pub fn update_message(&self, id: &str, patch: MessagePatch) -> AppResult<Option<Message>> {
        if patch.content.is_none() && patch.status.is_none() {
            return self.get_message(id);
        }

        // 闭包的返回值是「这条消息在不在」，而不是「有没有更新成功」——
        // 消息不存在不是错误，是调用方要区分的一种结果
        let found = self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;

            let conversation_id: Option<String> = transaction
                .query_row(
                    "SELECT conversation_id FROM messages WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;

            let Some(conversation_id) = conversation_id else {
                return Ok(false);
            };

            if let Some(content) = &patch.content {
                transaction.execute(
                    "UPDATE messages SET content = ?2 WHERE id = ?1",
                    params![id, content],
                )?;
            }
            if let Some(status) = &patch.status {
                transaction.execute(
                    "UPDATE messages SET status = ?2 WHERE id = ?1",
                    params![id, status],
                )?;
            }
            transaction.execute(
                "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
                params![conversation_id, now_ms()],
            )?;

            transaction.commit()?;
            Ok(true)
        })?;

        if !found {
            return Ok(None);
        }
        self.get_message(id)
    }

    fn get_message(&self, id: &str) -> AppResult<Option<Message>> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, conversation_id, role, content, status, created_at
                     FROM messages WHERE id = ?1",
                    params![id],
                    map_message,
                )
                .optional()?)
        })
    }

    // -----------------------------------------------------------------------
    // settings（只放非敏感项）
    // -----------------------------------------------------------------------

    pub fn get_settings(&self) -> AppResult<AppSettings> {
        let stored: Vec<(String, String)> = self.with_conn(|conn| {
            let mut statement = conn.prepare("SELECT key, value FROM settings")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })?;

        let lookup = |key: &str| -> Option<String> {
            stored
                .iter()
                .find(|(stored_key, _)| stored_key == key)
                .map(|(_, value)| value.clone())
        };

        // 缺失的键用默认值补齐：这样将来加了新的设置项，
        // 老用户的数据库不需要写迁移脚本
        let defaults = AppSettings::default();
        Ok(AppSettings {
            persona: PersonaConfig {
                assistant_name: lookup(crate::models::setting_keys::PERSONA_ASSISTANT_NAME)
                    .unwrap_or(defaults.persona.assistant_name),
                user_name: lookup(crate::models::setting_keys::PERSONA_USER_NAME)
                    .unwrap_or(defaults.persona.user_name),
                system_prompt: lookup(crate::models::setting_keys::PERSONA_SYSTEM_PROMPT)
                    .unwrap_or(defaults.persona.system_prompt),
            },
            model: PersistedModelConfig {
                api_url: lookup(crate::models::setting_keys::MODEL_API_URL)
                    .unwrap_or(defaults.model.api_url),
                model_name: lookup(crate::models::setting_keys::MODEL_NAME)
                    .unwrap_or(defaults.model.model_name),
            },
        })
    }

    pub fn save_persona(&self, persona: &PersonaConfig) -> AppResult<()> {
        self.write_settings(&[
            (crate::models::setting_keys::PERSONA_ASSISTANT_NAME, persona.assistant_name.trim()),
            (crate::models::setting_keys::PERSONA_USER_NAME, persona.user_name.trim()),
            (crate::models::setting_keys::PERSONA_SYSTEM_PROMPT, persona.system_prompt.trim()),
        ])
    }

    /// 只写非敏感投影。这个函数的参数类型里没有 Key，所以它写不出 Key。
    pub fn save_model_projection(&self, model: &PersistedModelConfig) -> AppResult<()> {
        self.write_settings(&[
            (crate::models::setting_keys::MODEL_API_URL, model.api_url.trim()),
            (crate::models::setting_keys::MODEL_NAME, model.model_name.trim()),
        ])
    }

    fn write_settings(&self, entries: &[(&str, &str)]) -> AppResult<()> {
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            for (key, value) in entries {
                transaction.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    // -----------------------------------------------------------------------
    // 重置
    // -----------------------------------------------------------------------

    /// 清空业务数据，保留 schema_migrations（表结构不是用户数据）
    pub fn reset_all(&self) -> AppResult<()> {
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction()?;
            transaction.execute("DELETE FROM messages", [])?;
            transaction.execute("DELETE FROM conversations", [])?;
            transaction.execute("DELETE FROM settings", [])?;
            transaction.commit()?;
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

fn map_conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        archived: row.get::<_, i64>(4)? != 0,
    })
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
    })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Database {
        Database::open_in_memory().expect("内存库应该能打开")
    }

    fn user_message(conversation_id: &str, content: &str) -> AppendMessageInput {
        AppendMessageInput {
            conversation_id: conversation_id.to_string(),
            role: "user".to_string(),
            content: content.to_string(),
            status: None,
        }
    }

    #[test]
    fn migration_runs_once_and_is_idempotent() {
        let database = database();
        assert_eq!(database.applied_version().unwrap(), 1);

        // 再跑一次不应该报错，也不应该重复插入记录
        database.migrate().unwrap();
        database.migrate().unwrap();
        assert_eq!(database.applied_version().unwrap(), 1);
    }

    #[test]
    fn tables_from_the_plan_exist() {
        let database = database();
        let columns: Vec<String> = database
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                )?;
                let rows = statement.query_map([], |row| row.get(0))?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .unwrap();

        for expected in ["conversations", "messages", "settings", "schema_migrations"] {
            assert!(columns.iter().any(|name| name == expected), "缺少表 {expected}");
        }
    }

    #[test]
    fn new_conversation_uses_default_title() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();
        assert_eq!(conversation.title, DEFAULT_CONVERSATION_TITLE);
        assert_eq!(conversation.created_at, conversation.updated_at);
        assert!(!conversation.archived);
    }

    #[test]
    fn conversations_are_ordered_by_last_update() {
        let database = database();
        let first = database
            .create_conversation(CreateConversationInput {
                title: Some("第一个".into()),
                ..Default::default()
            })
            .unwrap();
        let second = database
            .create_conversation(CreateConversationInput {
                title: Some("第二个".into()),
                ..Default::default()
            })
            .unwrap();

        database.touch_conversation(&first.id, Some(now_ms() + 10_000)).unwrap();

        let list = database.list_conversations().unwrap();
        assert_eq!(list[0].id, first.id);
        assert_eq!(list[1].id, second.id);
    }

    #[test]
    fn rename_normalizes_and_reports_missing() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();

        let renamed = database
            .rename_conversation(&conversation.id, "  讨论计划  ")
            .unwrap()
            .unwrap();
        assert_eq!(renamed.title, "讨论计划");

        let blanked = database
            .rename_conversation(&conversation.id, "   ")
            .unwrap()
            .unwrap();
        assert_eq!(blanked.title, crate::models::UNNAMED_CONVERSATION_TITLE);

        assert!(database.rename_conversation("conv_missing", "x").unwrap().is_none());
    }

    #[test]
    fn deleting_a_conversation_cascades_to_its_messages() {
        let database = database();
        let doomed = database.create_conversation(Default::default()).unwrap();
        let kept = database.create_conversation(Default::default()).unwrap();

        database.append_message(user_message(&doomed.id, "会被删掉")).unwrap();
        database.append_message(user_message(&kept.id, "要留着")).unwrap();

        database.delete_conversation(&doomed.id).unwrap();

        assert!(database.get_conversation(&doomed.id).unwrap().is_none());
        assert!(database.list_messages(&doomed.id).unwrap().is_empty());
        assert_eq!(database.list_messages(&kept.id).unwrap().len(), 1);
    }

    #[test]
    fn first_user_message_becomes_the_title() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();

        database
            .append_message(user_message(&conversation.id, "帮我梳理一下流程\n第二行"))
            .unwrap();
        database
            .append_message(user_message(&conversation.id, "第二句"))
            .unwrap();

        let updated = database.get_conversation(&conversation.id).unwrap().unwrap();
        assert_eq!(updated.title, "帮我梳理一下流程");
    }

    #[test]
    fn assistant_messages_do_not_become_the_title() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();

        database
            .append_message(AppendMessageInput {
                conversation_id: conversation.id.clone(),
                role: "assistant".into(),
                content: "你好呀".into(),
                status: Some("streaming".into()),
            })
            .unwrap();

        let updated = database.get_conversation(&conversation.id).unwrap().unwrap();
        assert_eq!(updated.title, DEFAULT_CONVERSATION_TITLE);
    }

    #[test]
    fn appending_to_a_missing_conversation_is_rejected() {
        let database = database();
        let error = database
            .append_message(user_message("conv_missing", "你好"))
            .unwrap_err();
        assert!(error.to_string().contains("会话不存在"));
    }

    #[test]
    fn invalid_role_is_rejected_by_the_schema() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();
        let error = database
            .append_message(AppendMessageInput {
                conversation_id: conversation.id,
                role: "system".into(),
                content: "不该写进来".into(),
                status: None,
            })
            .unwrap_err();
        // 约束兜底：证明「合法取值」是数据库说了算，不是靠调用方自觉
        assert!(format!("{error:?}").to_lowercase().contains("check"));
    }

    #[test]
    fn update_message_changes_content_and_status() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();
        let message = database
            .append_message(AppendMessageInput {
                conversation_id: conversation.id.clone(),
                role: "assistant".into(),
                content: String::new(),
                status: Some("streaming".into()),
            })
            .unwrap();

        let patched = database
            .update_message(
                &message.id,
                MessagePatch {
                    content: Some("半句话".into()),
                    status: Some("aborted".into()),
                },
            )
            .unwrap()
            .unwrap();

        assert_eq!(patched.status, "aborted");
        assert_eq!(patched.content, "半句话");
        assert!(database
            .update_message("msg_missing", MessagePatch { content: Some("x".into()), status: None })
            .unwrap()
            .is_none());
    }

    #[test]
    fn messages_come_back_in_insertion_order() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();
        for content in ["第一条", "第二条", "第三条"] {
            database.append_message(user_message(&conversation.id, content)).unwrap();
        }

        let texts: Vec<String> = database
            .list_messages(&conversation.id)
            .unwrap()
            .into_iter()
            .map(|message| message.content)
            .collect();
        assert_eq!(texts, vec!["第一条", "第二条", "第三条"]);
    }

    #[test]
    fn settings_fall_back_to_defaults_when_missing() {
        let database = database();
        let settings = database.get_settings().unwrap();
        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn settings_round_trip() {
        let database = database();

        database
            .save_persona(&PersonaConfig {
                assistant_name: "阿枢".into(),
                user_name: "老大".into(),
                system_prompt: "先给结论。".into(),
            })
            .unwrap();
        database
            .save_model_projection(&PersistedModelConfig {
                api_url: "https://api.example.com/v1".into(),
                model_name: "gpt-4o-mini".into(),
            })
            .unwrap();

        let settings = database.get_settings().unwrap();
        assert_eq!(settings.persona.assistant_name, "阿枢");
        assert_eq!(settings.model.api_url, "https://api.example.com/v1");
    }

    #[test]
    fn no_stored_setting_value_looks_like_a_credential() {
        let database = database();
        database
            .save_model_projection(&PersistedModelConfig {
                api_url: "https://api.example.com/v1".into(),
                model_name: "gpt-4o-mini".into(),
            })
            .unwrap();

        let keys: Vec<String> = database
            .with_conn(|conn| {
                let mut statement = conn.prepare("SELECT key FROM settings")?;
                let rows = statement.query_map([], |row| row.get(0))?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .unwrap();

        // settings 表里不该出现任何「key」语义的键
        for key in keys {
            assert!(
                !key.contains("api_key") && !key.contains("apikey") && !key.contains("token"),
                "settings 表出现了可疑的键名：{key}"
            );
        }
    }

    #[test]
    fn reset_clears_data_but_keeps_the_schema_version() {
        let database = database();
        let conversation = database.create_conversation(Default::default()).unwrap();
        database.append_message(user_message(&conversation.id, "你好")).unwrap();
        database
            .save_persona(&PersonaConfig {
                assistant_name: "改过的".into(),
                user_name: "老大".into(),
                system_prompt: "改过的".into(),
            })
            .unwrap();

        database.reset_all().unwrap();

        assert!(database.list_conversations().unwrap().is_empty());
        assert_eq!(database.get_settings().unwrap(), AppSettings::default());
        assert_eq!(database.applied_version().unwrap(), 1);
    }
}
