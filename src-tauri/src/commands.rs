//! Tauri 命令层 —— 前端能碰到的全部能力，就是这个文件的全部内容
//!
//! 设计原则（技术方案第 3 节「前端只能调用窄接口」）：
//!   - 每个命令只做一件明确的事，参数里**没有 shell、没有 URL 白名单需要维护**。
//!   - 数据库和文件操作一律 `spawn_blocking`：两者都是阻塞的，不能占住异步运行时的线程。
//!   - 所有错误转成「一句话」，直接给用户看；转换发生在 `AppError::to_string()`，
//!     而 `AppError` 的构造处都过了脱敏。
//!
//! ## 关于文件读取（阶段 D）
//!
//! 唯一能碰到文件系统的命令是 `read_authorized_file` 与 `list_authorized_directory`，
//! 而它们的参数是**相对授权目录的路径**，不是绝对路径 ——
//! 前端连表达「读 D:\别的地方」这件事的能力都没有。真正的检查在
//! `file_access::resolve_within_root`，那里修了三条路径逃逸防线。
//!
//! 键鼠模拟（技术方案第 6 节第 5 项）还没有做。

use std::sync::Arc;
use std::sync::atomic::Ordering;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::chat::{self, ChatRequest, StreamEvent, StreamResult};
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::file_access::ReadAudit;
use crate::models::{
    AppSettings, AppendMessageInput, AutostartStatus, Conversation, CreateConversationInput,
    FileAccessSettings, FileAccessStatus, FileContent, FileEntry, GlobalShortcutStatus, Message,
    MessagePatch, ModelConfig, NotifyOutcome, OperationResult, PermissionSettings, PersonaConfig,
    RecentRead, Screenshot, ShortcutSettings, StorageLocation, WindowSettings,
};
use crate::secrets::SecretStore;
use crate::window::WindowRuntime;

/// 应用运行期状态：数据库、凭据存储、当前请求的取消标记、窗口开关、读取记录。
pub struct AppState {
    pub db: Database,
    pub secrets: SecretStore,
    /// 同一时刻只允许一个流式请求（前端也这么约束）。
    /// 用原子布尔而不是 CancellationToken：只需要一个「请停下」的旗子。
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    /// 「关闭窗口时缩到托盘」等窗口状态，兼作数据库的缓存
    pub window: WindowRuntime,
    /// 最近的读取记录。**只在内存里**，见 file_access.rs 的说明。
    pub read_audit: ReadAudit,
}

/// 把阻塞的数据库操作挪到阻塞线程池，并把 `AppError` 翻成面向用户的字符串
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error.to_string()),
        Err(error) => Err(format!("后台任务执行失败：{error}")),
    }
}

/// 把文件系统操作挪到阻塞线程池。
///
/// 单独一个函数是因为返回类型不同：文件操作直接给用户可读的字符串错误，
/// 不经过 `AppError`。而且文件 I/O 可能很慢（网络盘、大目录），
/// 放在异步运行时的线程上会拖住别的命令。
async fn blocking_fs<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(format!("后台任务执行失败：{error}")),
    }
}

/// 取当前授权的根目录；没授权就返回一句能看懂的话。
async fn require_root(db: Database) -> Result<std::path::PathBuf, String> {
    let settings = blocking(move || db.get_settings()).await?;
    let directory = settings.file_access.directory;

    if directory.trim().is_empty() {
        return Err("还没有授权任何目录。请先在设置里的「本地文件」中选一个文件夹。".to_string());
    }

    let root = std::path::PathBuf::from(&directory);
    if !root.is_dir() {
        return Err(format!(
            "授权的目录现在打不开了：{directory}。它可能被删掉或改名了，请重新授权。"
        ));
    }

    Ok(root)
}

/// 取这次请求要用的 Key：优先用前端刚填的，其次用系统凭据存储里已经保存的
fn resolve_api_key(state: &AppState, provided: &str) -> AppResult<String> {
    if !provided.trim().is_empty() {
        return Ok(provided.trim().to_string());
    }
    match state.secrets.load()? {
        Some(stored) => Ok(stored),
        None => Err(AppError::Invalid(
            "尚未保存 API Key，请先在设置里填写。".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// 存储：位置
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn storage_location(state: State<'_, AppState>) -> Result<StorageLocation, String> {
    Ok(state.db.location())
}

// ---------------------------------------------------------------------------
// 存储：会话
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    let db = state.db.clone();
    blocking(move || db.list_conversations()).await
}

#[tauri::command]
pub async fn get_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<Conversation>, String> {
    let db = state.db.clone();
    blocking(move || db.get_conversation(&id)).await
}

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    input: CreateConversationInput,
) -> Result<Conversation, String> {
    let db = state.db.clone();
    blocking(move || db.create_conversation(input)).await
}

#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<Option<Conversation>, String> {
    let db = state.db.clone();
    blocking(move || db.rename_conversation(&id, &title)).await
}

#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.clone();
    blocking(move || db.delete_conversation(&id)).await
}

#[tauri::command]
pub async fn touch_conversation(
    state: State<'_, AppState>,
    id: String,
    at: Option<i64>,
) -> Result<(), String> {
    let db = state.db.clone();
    blocking(move || db.touch_conversation(&id, at)).await
}

// ---------------------------------------------------------------------------
// 存储：消息
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Message>, String> {
    let db = state.db.clone();
    blocking(move || db.list_messages(&conversation_id)).await
}

#[tauri::command]
pub async fn append_message(
    state: State<'_, AppState>,
    input: AppendMessageInput,
) -> Result<Message, String> {
    let db = state.db.clone();
    blocking(move || db.append_message(input)).await
}

#[tauri::command]
pub async fn update_message(
    state: State<'_, AppState>,
    id: String,
    patch: MessagePatch,
) -> Result<Option<Message>, String> {
    let db = state.db.clone();
    blocking(move || db.update_message(&id, patch)).await
}

// ---------------------------------------------------------------------------
// 设置（非敏感部分）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let db = state.db.clone();
    blocking(move || db.get_settings()).await
}

/// 保存人格配置与非敏感模型设置。
/// 参数类型 `AppSettings` 里没有 api_key 字段，所以这条命令写不出凭据。
#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    let db = state.db.clone();
    let close_to_tray = settings.window.close_to_tray;
    blocking(move || {
        db.save_persona(&settings.persona)?;
        db.save_model_projection(&settings.model)?;
        db.save_window_settings(&settings.window)?;
        db.save_notification_settings(&settings.notification)?;
        // 刻意**不写** settings.shortcut：全局快捷键有副作用（要注册到系统），
        // 必须走 set_global_shortcut 那条命令一次做完「注册 + 落盘」。
        // 这里顺手写一下的话，会出现「库里存着但没注册」的状态。
        Ok(())
    })
    .await?;

    // 内存缓存同步跟上，否则关闭窗口时用的还是旧值
    state.window.set_close_to_tray(close_to_tray);
    Ok(())
}

#[tauri::command]
pub async fn save_persona(
    state: State<'_, AppState>,
    persona: PersonaConfig,
) -> Result<AppSettings, String> {
    let db = state.db.clone();
    blocking(move || {
        db.save_persona(&persona)?;
        db.get_settings()
    })
    .await
}

/// 保存模型配置：非敏感部分入库，API Key 交给系统凭据存储。
///
/// 这个命令是「分家」发生的地方 —— 一个对象进来，两条路出去，
/// 而其中一条路上根本没有可以让 Key 落地的地方。
#[tauri::command]
pub async fn save_model_config(
    state: State<'_, AppState>,
    config: ModelConfig,
) -> Result<(), String> {
    if config.api_key.trim().is_empty() {
        // 只改地址和模型名时不该把已保存的 Key 弄丢
        let db = state.db.clone();
        let projection = config.projection();
        return blocking(move || db.save_model_projection(&projection)).await;
    }

    let secrets = state.secrets.clone();
    let provided = config.api_key.clone();
    blocking(move || secrets.save(&provided)).await?;

    let db = state.db.clone();
    let projection = config.projection();
    blocking(move || db.save_model_projection(&projection)).await
}

/// 本机是否已经保存过 API Key。
/// 只回一个布尔值，不回 Key 本身 —— 前端没有拿到凭据的必要。
#[tauri::command]
pub async fn api_key_status(state: State<'_, AppState>) -> Result<bool, String> {
    let secrets = state.secrets.clone();
    blocking(move || secrets.has()).await
}

/// 清掉已保存的 API Key（界面上的「清除」用）
#[tauri::command]
pub async fn clear_api_key(state: State<'_, AppState>) -> Result<(), String> {
    let secrets = state.secrets.clone();
    blocking(move || secrets.delete()).await
}

/// 系统凭据存储是否可用。
///
/// 返回 `Ok(OperationResult)` 而不是 Err：不可用是一种**正常的状态**，
/// 界面要把它当成一条信息显示出来，而不是弹一个红色错误。
/// 否则用户会在「保存成功」的假象里反复填 Key。
#[tauri::command]
pub async fn credential_storage_status(
    state: State<'_, AppState>,
) -> Result<OperationResult, String> {
    let secrets = state.secrets.clone();
    blocking(move || {
        Ok(match secrets.ensure_available() {
            Ok(()) => OperationResult {
                ok: true,
                message: "系统凭据存储可用（Windows 凭据管理器）。".to_string(),
            },
            Err(error) => OperationResult {
                ok: false,
                message: error.to_string(),
            },
        })
    })
    .await
}

#[tauri::command]
pub async fn reset_all_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let secrets = state.secrets.clone();
    let db = state.db.clone();

    // 清库之前先把「系统里那些跟着设置走的东西」收回来。
    //
    // 不这么做的话会出现一种很难解释的状态：设置页里快捷键是空的、关闭行为是默认的，
    // 但那个热键**仍然生效**、关闭窗口**仍然缩到托盘** —— 因为这两件事的实际效果
    // 由系统和我们内存里的缓存决定，不是由数据库决定的。
    // 用户会说「我明明重置了」。
    let previous_shortcut = state.db.get_settings().map(|s| s.shortcut.toggle_window);
    blocking(move || {
        // 先清数据再清凭据：中途失败时，宁可留下一个「多余的 Key」（用户能再点一次清除），
        // 也不要出现「会话没了但 Key 还在」这种更难解释的状态
        db.reset_all()?;
        secrets.delete()?;
        Ok(())
    })
    .await?;

    // 撤销系统层面的副作用，让实际行为和「已重置」一致
    if let Ok(previous) = previous_shortcut {
        crate::shortcut::apply(&app, &previous, None);
    }
    let defaults = crate::models::AppSettings::default();
    state
        .window
        .set_close_to_tray(defaults.window.close_to_tray);

    Ok(())
}

// ---------------------------------------------------------------------------
// 模型请求
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    config: ModelConfig,
) -> Result<OperationResult, String> {
    let api_key = resolve_api_key(&state, &config.api_key).map_err(|error| error.to_string())?;
    chat::test_connection(&config.api_url, &api_key, &config.model_name)
        .await
        .map_err(|error| error.to_string())
}

/// 流式对话。增量通过 `on_event` 这个 Channel 推给前端。
///
/// 注意这里**没有 api_key 参数**：Key 从系统凭据存储里取，
/// 前端从头到尾不参与凭据的搬运。
#[tauri::command]
pub async fn stream_chat(
    state: State<'_, AppState>,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
) -> Result<StreamResult, String> {
    let secrets = state.secrets.clone();
    let api_key = blocking(move || secrets.load()).await?.ok_or_else(|| {
        AppError::Invalid("尚未保存 API Key，请先在设置里填写。".to_string()).to_string()
    })?;

    let db = state.db.clone();
    let settings = blocking(move || db.get_settings()).await?;

    // 前端传来的模型名优先（用户在表单里刚改过），否则用保存的
    let model = if request.model.trim().is_empty() {
        settings.model.model_name
    } else {
        request.model.clone()
    };
    let effective = ChatRequest { model, ..request };

    // 每次开新请求前先复位取消标记，避免上一次的「停止」把这一次也停了
    state.cancel.store(false, Ordering::Relaxed);

    chat::stream_chat(
        &settings.model.api_url,
        &api_key,
        effective,
        state.cancel.clone(),
        &on_event,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_chat(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

// ---------------------------------------------------------------------------
// 平台能力与窗口（阶段 C）
// ---------------------------------------------------------------------------

/// 当前**真正可用**的平台能力。
///
/// 关键点：这个清单由 Rust 在运行时回答，前端不写死一份。
/// 「托盘到底建起来了没有」只有 Rust 知道 —— 前端若写死「托盘可用」，
/// 一旦托盘创建失败，用户点「隐藏到托盘」就会让窗口消失且再也找不回来。
#[tauri::command]
pub async fn platform_capabilities(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    // 通知与开机自启都由编译进来的插件提供，程序能跑起来就说明可用 —— 不需要运行时探测
    let mut capabilities = vec!["notification".to_string(), "autostart".to_string()];

    // 托盘不一样：图标可能建失败，必须问运行期状态
    if state.window.tray_available() {
        capabilities.push("tray".to_string());
    }

    Ok(capabilities)
}

/// 把主窗口隐藏到托盘。
/// 前端在「隐藏」之后就不再需要结果了，所以这里只做动作、不返回窗口状态。
#[tauri::command]
pub async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    crate::window::hide_main_window(&app);
    Ok(())
}

/// 读取「关闭窗口时缩到托盘」的当前值
#[tauri::command]
pub async fn close_to_tray_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.window.close_to_tray())
}

/// 修改「关闭窗口时缩到托盘」。
///
/// 必须同时做两件事：写库（下次启动仍然生效）和改内存缓存（这次关闭就生效）。
/// 只做前者会出现「保存成功但按关闭还是退出」，只做后者会出现「这次生效、重启就丢」。
#[tauri::command]
pub async fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let db = state.db.clone();
    blocking(move || {
        db.save_window_settings(&WindowSettings {
            close_to_tray: enabled,
        })
    })
    .await?;

    state.window.set_close_to_tray(enabled);
    log::info!(
        "关闭行为已更新：{}",
        if enabled {
            "缩到托盘"
        } else {
            "退出应用"
        }
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 系统通知（阶段 C）
// ---------------------------------------------------------------------------

/// 发一条系统通知。
///
/// 打扰判定（窗口正在前台就不弹）在 Rust 侧做，因为只有这里知道窗口的可见性与焦点。
/// 前端只说「回复完成了」，不需要也不应该自己判断该不该打扰用户。
///
/// `force` 只给设置页的「发一条测试通知」用 —— 那时用户明确要求看到它。
#[tauri::command]
pub async fn notify(
    app: AppHandle,
    title: String,
    body: String,
    force: bool,
) -> Result<NotifyOutcome, String> {
    Ok(crate::notify::deliver(&app, &title, &body, force))
}

// ---------------------------------------------------------------------------
// 开机自启（阶段 C）
// ---------------------------------------------------------------------------

/// 读取开机自启的当前状态。
///
/// 状态来自**系统**（注册表 + 任务管理器的开关），不来自我们的设置表 ——
/// 用户随时可能在任务管理器里把它关掉，我们存副本必然对不上。
#[tauri::command]
pub async fn autostart_status(app: AppHandle) -> Result<AutostartStatus, String> {
    Ok(crate::autostart::status(&app))
}

/// 开启 / 关闭开机自启
#[tauri::command]
pub async fn set_autostart(app: AppHandle, enabled: bool) -> Result<OperationResult, String> {
    Ok(crate::autostart::set_enabled(&app, enabled))
}

// ---------------------------------------------------------------------------
// 全局快捷键（阶段 C）
// ---------------------------------------------------------------------------

/// 读取全局快捷键的状态：用户设的是什么、到底有没有注册上。
///
/// 两件事要分开看 —— 键被别的程序占着的时候，设置里存着 `Ctrl+Shift+Space`
/// 而它其实没生效。界面必须能同时看到这两点。
#[tauri::command]
pub async fn global_shortcut_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GlobalShortcutStatus, String> {
    let db = state.db.clone();
    let settings = blocking(move || db.get_settings()).await?;
    Ok(crate::shortcut::status(
        &app,
        &settings.shortcut.toggle_window,
    ))
}

/// 设置全局快捷键。`accelerator` 传 null 或空串表示关闭。
///
/// **只有注册成功才落盘。** 注册失败还存下来的话，下次启动会拿同一个注定失败的键
/// 再试一遍，用户就会一直看到一个用不了的快捷键，而且不知道问题出在哪。
#[tauri::command]
pub async fn set_global_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    accelerator: Option<String>,
) -> Result<OperationResult, String> {
    let db = state.db.clone();
    let settings = blocking({
        let db = db.clone();
        move || db.get_settings()
    })
    .await?;

    let outcome = crate::shortcut::apply(
        &app,
        &settings.shortcut.toggle_window,
        accelerator.as_deref(),
    );

    if outcome.ok {
        let stored = accelerator.unwrap_or_default().trim().to_string();
        blocking(move || {
            db.save_shortcut_settings(&ShortcutSettings {
                toggle_window: stored,
            })
        })
        .await?;
    }

    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 本地文件读取（阶段 D）
//
// 这是全项目权限最重的一组命令，所以把边界写在这里：
//   - **参数是相对路径，不是绝对路径。** 前端连「指定别处」这件事都表达不出来。
//   - **读取范围由用户显式授权的一个目录决定**，没授权就什么都读不到。
//   - **每一次读取都留痕**（最近若干条，只在内存里），用户能看见「它读了我的什么」。
// ---------------------------------------------------------------------------

/// 当前的文件访问状态：授权了哪个目录、它现在还能不能打开。
#[tauri::command]
pub async fn file_access_status(state: State<'_, AppState>) -> Result<FileAccessStatus, String> {
    let db = state.db.clone();
    let directory = blocking(move || db.get_settings())
        .await?
        .file_access
        .directory;

    // 目录可能在授权之后被删掉或改名，这时候要如实显示为不可用
    let available = !directory.trim().is_empty() && std::path::Path::new(&directory).is_dir();

    Ok(FileAccessStatus {
        directory,
        available,
    })
}

/// 弹出系统的「选择文件夹」对话框，返回用户选的绝对路径。
///
/// 走 dialog 插件，但**只在 Rust 侧使用** —— 前端拿到的是这一条命令，
/// 插件的权限没有放开任何一项。
#[tauri::command]
pub async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.display().to_string()))
}

/// 授权一个目录用于读取。
///
/// 这里就是「确认」这一步：用户明确指定了目录，我们校验它真实存在且确实是目录，
/// 并把**规范化后的绝对路径**存下来，作为之后所有路径检查的唯一基准。
#[tauri::command]
pub async fn authorize_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<OperationResult, String> {
    let root = match crate::file_access::validate_authorized_root(&path) {
        Ok(root) => root,
        Err(reason) => {
            return Ok(OperationResult {
                ok: false,
                message: reason,
            });
        }
    };

    let warning = crate::file_access::broad_scope_warning(&root);
    let stored = root.display().to_string();

    let db = state.db.clone();
    let to_save = stored.clone();
    blocking(move || db.save_file_access_settings(&FileAccessSettings { directory: to_save }))
        .await?;

    // 换了目录就清掉旧的读取记录：那是上一个目录里的事，留着会让人误以为读过新目录
    state.read_audit.clear();

    log::info!(
        "本地文件访问的授权目录已更新（范围过宽提醒：{}）",
        warning.is_some()
    );

    Ok(OperationResult {
        ok: true,
        message: match warning {
            Some(warning) => format!("已授权读取 {stored}。提醒：{warning}"),
            None => format!("已授权读取 {stored}。助手只能读这个目录里的文件。"),
        },
    })
}

/// 撤销授权。撤销后立刻读不到任何文件，已经记下的读取记录也一并清掉。
#[tauri::command]
pub async fn revoke_directory(state: State<'_, AppState>) -> Result<OperationResult, String> {
    let db = state.db.clone();
    blocking(move || {
        db.save_file_access_settings(&FileAccessSettings {
            directory: String::new(),
        })
    })
    .await?;

    state.read_audit.clear();
    log::info!("本地文件访问的授权已撤销");

    Ok(OperationResult {
        ok: true,
        message: "已撤销文件读取授权。助手现在读不到任何本地文件。".to_string(),
    })
}

/// 列出授权目录里某一层的内容。`relativeDir` 为空表示目录本身。
#[tauri::command]
pub async fn list_authorized_directory(
    state: State<'_, AppState>,
    relative_dir: String,
) -> Result<Vec<FileEntry>, String> {
    let root = require_root(state.db.clone()).await?;
    blocking_fs(move || crate::file_access::list_directory(&root, &relative_dir)).await
}

/// 读一个文本文件。`relativePath` 是相对授权目录的路径。
#[tauri::command]
pub async fn read_authorized_file(
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<FileContent, String> {
    let root = require_root(state.db.clone()).await?;
    let audit_path = relative_path.trim().to_string();

    let content = blocking_fs({
        let root = root.clone();
        move || crate::file_access::read_text_file(&root, &relative_path)
    })
    .await?;

    // 成功读取才留痕 —— 失败的尝试不进列表，那会让「它读过什么」变得嘈杂
    state.read_audit.record(&audit_path, content.bytes);

    Ok(content)
}

/// 最近的读取记录，新的在前。界面用它回答「它刚才读了我的什么」。
#[tauri::command]
pub async fn recent_file_reads(state: State<'_, AppState>) -> Result<Vec<RecentRead>, String> {
    Ok(state.read_audit.recent())
}

// ---------------------------------------------------------------------------
// 截屏（阶段 D）
//
// 高风险能力的样板：默认关闭、Rust 侧把门、每次留痕。
// 键鼠模拟照着这一组抄就行 —— 模式写在 permissions 模块里。
// ---------------------------------------------------------------------------

/// 开启 / 关闭截屏能力。
///
/// 开关本身不是敏感信息，存 settings 表；但**判断发生在 Rust 侧**，
/// 因为命令可以被直接调用，界面上的按钮禁用只是体验，不是约束。
#[tauri::command]
pub async fn set_screenshot_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<OperationResult, String> {
    let db = state.db.clone();
    blocking(move || {
        db.save_permission_settings(&PermissionSettings {
            screenshot: enabled,
        })
    })
    .await?;

    log::info!("截屏能力已{}", if enabled { "开启" } else { "关闭" });

    Ok(OperationResult {
        ok: true,
        message: if enabled {
            "已开启截屏。助手现在可以抓取主屏画面；截图只在内存里传递，不会写到磁盘上。".to_string()
        } else {
            "已关闭截屏。助手现在抓不到屏幕内容。".to_string()
        },
    })
}

/// 抓一张主屏截图。
///
/// **不落盘**：图片编码成 data URL 直接回给前端，用完就没了。
#[tauri::command]
pub async fn take_screenshot(state: State<'_, AppState>) -> Result<Screenshot, String> {
    let enabled = blocking({
        let db = state.db.clone();
        move || db.get_settings()
    })
    .await?
    .permission
    .screenshot;

    // 门在 Rust 侧：界面不显示按钮、或者按钮被禁用，都不代表这个命令调不动
    crate::permissions::ensure_enabled(enabled, "截屏")?;

    blocking_fs(crate::screenshot::capture).await
}
