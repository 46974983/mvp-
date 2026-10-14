//! Tauri 命令层 —— 前端能碰到的全部能力，就是这个文件的全部内容
//!
//! 设计原则（技术方案第 3 节「前端只能调用窄接口」）：
//!   - 每个命令只做一件明确的事，参数里**没有路径**、没有 shell、没有 URL 白名单需要维护。
//!   - 数据库操作一律 `spawn_blocking`：SQLite 是阻塞的，不能占住异步运行时的线程。
//!   - 所有错误转成「一句话」，直接给用户看；转换发生在 `AppError::to_string()`，
//!     而 `AppError` 的构造处都过了脱敏。
//!
//! 这里没有任何一条命令能读任意文件、执行命令或访问网络地址之外的东西 ——
//! 文件读取、截屏、键鼠模拟属于技术方案第 6 节里更靠后的阶段，本阶段不开放。

use std::sync::Arc;
use std::sync::atomic::Ordering;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::chat::{self, ChatRequest, StreamEvent, StreamResult};
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::models::{
    AppSettings, AppendMessageInput, AutostartStatus, Conversation, CreateConversationInput,
    Message, MessagePatch, ModelConfig, NotifyOutcome, OperationResult, PersonaConfig,
    StorageLocation, WindowSettings,
};
use crate::secrets::SecretStore;
use crate::window::WindowRuntime;

/// 应用运行期状态。四个字段就够：数据库、凭据存储、当前请求的取消标记、窗口开关。
pub struct AppState {
    pub db: Database,
    pub secrets: SecretStore,
    /// 同一时刻只允许一个流式请求（前端也这么约束）。
    /// 用原子布尔而不是 CancellationToken：只需要一个「请停下」的旗子。
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    /// 「关闭窗口时缩到托盘」等窗口状态，兼作数据库的缓存
    pub window: WindowRuntime,
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
pub async fn reset_all_data(state: State<'_, AppState>) -> Result<(), String> {
    let secrets = state.secrets.clone();
    let db = state.db.clone();
    blocking(move || {
        // 先清数据再清凭据：中途失败时，宁可留下一个「多余的 Key」（用户能再点一次清除），
        // 也不要出现「会话没了但 Key 还在」这种更难解释的状态
        db.reset_all()?;
        secrets.delete()?;
        Ok(())
    })
    .await
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
    crate::tray::hide_main_window(&app);
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
