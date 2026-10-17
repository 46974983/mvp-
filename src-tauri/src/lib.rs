//! 桌面外壳（阶段 B-D）
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
//!   ├── 系统托盘与窗口开关       (tray / window)
//!   └── 窄命令接口              (commands)
//! ```
//!
//! 这个文件只做四件事：开数据库、装状态、建托盘、注册命令与窗口事件。
//! 具体逻辑都在各自模块里，是为了让「外壳」看起来就是外壳 ——
//! 想查什么能力被开放了，看 `invoke_handler` 那一份清单就够了。

mod automation;
mod autostart;
mod chat;
mod commands;
mod db;
mod error;
mod file_access;
mod models;
mod notify;
mod permissions;
mod redact;
mod screenshot;
mod secrets;
mod shortcut;
mod tray;
mod window;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use crate::commands::AppState;
use crate::db::Database;
use crate::file_access::ReadAudit;
use crate::secrets::SecretStore;
use crate::window::WindowRuntime;

/// 数据库文件名。放在系统给的应用数据目录下，而不是应用安装目录 ——
/// 后者在 Program Files 里通常没有写权限。
const DATABASE_FILE: &str = "assistant.db";

/// 主窗口的 label。
///
/// 托盘、通知都要靠它去取窗口，写错的表现是**静默失效**：
/// 托盘「显示主窗口」点了没反应，或者窗口在前台还照样弹通知。
/// 所以只留这一个出处，并有契约测试比对它与 tauri.conf.json 里的值。
pub const MAIN_WINDOW_LABEL: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        // 阶段 C 引入的插件。都在 Rust 侧使用（见各自模块的说明），
        // 所以 capabilities 里没有为它们增加任何权限。
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            // Windows 上这个参数会被忽略，只在 macOS 上有意义
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 只为「选择文件夹」这一个动作用，而且只在 Rust 侧 —— 前端拿到的是 pick_directory
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let database = Database::open(&data_dir.join(DATABASE_FILE))?;

            // 只记路径，不记任何配置内容 —— 日志文件是明文的，
            // 「日志里没有秘密」这条得靠写日志时的不写，而不是靠脱敏的运气
            log::info!("本地数据库就绪：{}", database.location().database_path);

            // 关闭行为要用到这个设置，所以启动时读一次，缓存进内存
            let settings = database.get_settings()?;

            app.manage(AppState {
                db: database,
                secrets: SecretStore::new(),
                cancel: Arc::new(AtomicBool::new(false)),
                window: WindowRuntime::new(settings.window.close_to_tray),
                read_audit: ReadAudit::default(),
                automation_cancel: Arc::new(AtomicBool::new(false)),
                automation_report: Arc::new(Mutex::new(None)),
                automation_lock: Arc::new(Mutex::new(())),
                permissions_lock: Arc::new(Mutex::new(())),
            });

            // 托盘必须在 state 之后建：菜单里的「退出」要能改 state
            let tray_available = tray::build(app.handle());
            app.state::<AppState>()
                .window
                .set_tray_available(tray_available);

            if !tray_available {
                log::warn!("托盘不可用：关闭窗口将直接退出（藏起来会让应用失联）");
            }

            // 把上次设置的全局快捷键注册回来。
            // 走的是和界面改键同一条 apply 路径，所以校验和失败提示都是一致的；
            // 注册失败只记日志 —— 用户没在设置页，弹什么都看不到，
            // 等他自己打开设置页时 global_shortcut_status 会如实显示「没注册上」。
            let saved_shortcut = settings.shortcut.toggle_window.trim().to_string();
            if !saved_shortcut.is_empty() {
                let outcome = shortcut::apply(app.handle(), "", Some(&saved_shortcut));
                if !outcome.ok {
                    log::warn!("启动时注册全局快捷键失败：{}", outcome.message);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };

            let state = window.state::<AppState>();

            let (quitting, close_to_tray, tray_available) = (

                state.window.is_quitting(),

                state.window.close_to_tray(),

                state.window.tray_available(),

            );

            let action = crate::window::decide_close_action(quitting, close_to_tray, tray_available);


            // 记一记判定结果。这一条是验收时补的：只靠「窗口有没有消失」分不清

            // 「判定成退出」和「压根没收到关闭事件」—— 这两种情况的修法完全不同。

            log::info!(

                "收到关闭请求：退出中={quitting} 缩到托盘={close_to_tray} 托盘可用={tray_available} → {action:?}"

            );

            if action == crate::window::CloseAction::HideToTray {
                // 拦下这次关闭，改成隐藏。
                // 注意不是 minimize()：最小化还占着任务栏，用户会以为应用还开着；
                // 隐藏才是真正的「退到托盘」。
                api.prevent_close();
                match window.hide() {
                    Ok(()) => log::info!("窗口已隐藏到托盘"),
                    // 隐藏失败时窗口保持原样 —— 这是安全的失败方向：
                    // 用户看得见窗口，总比窗口不见了、又找不到托盘入口强
                    Err(error) => log::warn!("隐藏窗口失败：{error}"),
                }
            }
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
            // 平台能力与窗口（阶段 C）
            commands::platform_capabilities,
            commands::hide_to_tray,
            commands::close_to_tray_enabled,
            commands::set_close_to_tray,
            // 通知（阶段 C）
            commands::notify,
            // 开机自启（阶段 C）
            commands::autostart_status,
            commands::set_autostart,
            // 全局快捷键（阶段 C）
            commands::global_shortcut_status,
            commands::set_global_shortcut,
            // 本地文件读取（阶段 D）
            commands::file_access_status,
            commands::pick_directory,
            commands::authorize_directory,
            commands::revoke_directory,
            commands::list_authorized_directory,
            commands::read_authorized_file,
            commands::recent_file_reads,
            // 自动化（阶段 D）
            commands::set_input_simulation_enabled,
            commands::run_automation,
            commands::stop_automation,
            commands::automation_last_run,
            // 截屏（阶段 D）
            commands::set_screenshot_enabled,
            commands::take_screenshot,
        ])
        .run(tauri::generate_context!())
        .expect("启动桌面应用失败");
}
