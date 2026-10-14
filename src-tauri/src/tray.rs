//! 系统托盘
//!
//! 托盘是「常驻型助手」的入口：窗口藏起来之后，用户还能从这里把它叫回来，
//! 也能从这里真正退出。所以托盘菜单里必须同时有「显示」和「退出」——
//! 少任何一个，用户都会被困在一个看不见的进程里。
//!
//! 实现走的是 Tauri 的核心 tray API（Cargo.toml 里的 `tray-icon` feature），
//! **不是插件**。这一点直接影响权限：托盘完全在 Rust 侧建立和响应，
//! 前端没有拿到任何新命令，capabilities 里也没有多出任何权限。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::commands::AppState;

/// 托盘图标 id。留成常量，方便以后按 id 取回实例改图标或提示
pub const TRAY_ID: &str = "main-tray";

/// 托盘菜单项的 id
mod menu_id {
    pub const SHOW: &str = "tray.show";
    pub const HIDE: &str = "tray.hide";
    pub const QUIT: &str = "tray.quit";
}

/// 建立托盘图标。
///
/// 返回 `false` 表示没建起来。调用方**必须**据此关闭「隐藏到托盘」的能力，
/// 否则窗口一旦被藏起来，用户就再也找不回来了。
pub fn build(app: &AppHandle) -> bool {
    match build_inner(app) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("托盘图标创建失败，将退回「关闭窗口即退出」：{error}");
            false
        }
    }
}

fn build_inner(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, menu_id::SHOW, "显示主窗口", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let hide = MenuItem::with_id(app, menu_id::HIDE, "隐藏到托盘", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, menu_id::QUIT, "退出", true, None::<&str>)
        .map_err(|error| error.to_string())?;

    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])
        .map_err(|error| error.to_string())?;

    // 托盘图标用应用自身的图标。拿不到就当作创建失败 ——
    // Windows 上给托盘一个空的图标，用户会看到一个看不见的点，比没有更糟。
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "应用图标缺失，无法创建托盘".to_string())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("桌面 AI 助手")
        .menu(&menu)
        // 左键不弹菜单：把左键让给「双击恢复窗口」，右键才出菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            menu_id::SHOW => show_main_window(app),
            menu_id::HIDE => hide_main_window(app),
            menu_id::QUIT => quit_app(app),
            other => log::debug!("托盘菜单收到未处理的项：{other}"),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    log::info!("托盘图标已就绪");
    Ok(())
}

/// 把主窗口显示出来并置于前台。
/// 三个动作缺一不可：只 show() 的话，窗口可能还停在最小化状态、或者在别的窗口后面。
pub fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("找不到主窗口，无法显示");
        return;
    };

    if let Err(error) = window.show() {
        log::warn!("显示窗口失败：{error}");
        return;
    }
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn hide_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("找不到主窗口，无法隐藏");
        return;
    };
    if let Err(error) = window.hide() {
        log::warn!("隐藏窗口失败：{error}");
    }
}

/// 真正退出。
/// 先立起 quitting 标记，否则退出流程里触发的关闭事件会被「隐藏到托盘」再拦一次，
/// 结果就是点了退出却退不掉。
fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.window.mark_quitting();
    }
    app.exit(0);
}
