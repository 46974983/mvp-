//! 桌面外壳（阶段 B）
//!
//! 技术方案第 3 节的分层在这里收口：
//!
//! ```text
//! React Renderer
//!   └── PlatformService / ModelProvider / StorageService 抽象
//!           ↓  Tauri invoke 边界
//! Rust Core
//!   ├── SQLite 数据访问        (db)
//!   ├── API Key 加密存储        (secrets)
//!   ├── 模型请求与流式事件       (chat)
//!   └── 窄命令接口              (commands)
//! ```
//!
//! 这个文件只做三件事：开数据库、装状态、注册命令。
//! 具体逻辑都在各自模块里，是为了让「外壳」看起来就是外壳 ——
//! 想查什么能力被开放了，看 `invoke_handler` 那一份清单就够了。

mod chat;
mod commands;
mod db;
mod error;
mod models;
mod redact;
mod secrets;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use tauri::Manager;

use crate::commands::AppState;
use crate::db::Database;
use crate::secrets::SecretStore;

/// 数据库文件名。放在系统给的应用数据目录下，而不是应用安装目录 ——
/// 后者在 Program Files 里通常没有写权限。
const DATABASE_FILE: &str = "assistant.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let database = Database::open(&data_dir.join(DATABASE_FILE))?;

            // 只记路径，不记任何配置内容 —— 日志文件是明文的，
            // 「日志里没有秘密」这条得靠写日志时的不写，而不是靠脱敏的运气
            log::info!("本地数据库就绪：{}", database.location().database_path);

            app.manage(AppState {
                db: database,
                secrets: SecretStore::new(),
                cancel: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 数据位置
            commands::storage_location,
            // 会话
            commands::list_conversations,
            commands::get_conversation,
            commands::create_conversation,
            commands::rename_conversation,
            commands::delete_conversation,
            commands::touch_conversation,
            // 消息
            commands::list_messages,
            commands::append_message,
            commands::update_message,
            // 设置（非敏感）
            commands::get_settings,
            commands::save_settings,
            commands::save_persona,
            // 凭据
            commands::save_model_config,
            commands::api_key_status,
            commands::clear_api_key,
            commands::credential_storage_status,
            // 数据重置
            commands::reset_all_data,
            // 模型请求
            commands::test_connection,
            commands::stream_chat,
            commands::cancel_chat,
        ])
        .run(tauri::generate_context!())
        .expect("启动桌面应用失败");
}
