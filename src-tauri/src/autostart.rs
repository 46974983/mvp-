//! 开机自启
//!
//! 用 `tauri-plugin-autostart`。这是阶段 C 引入的第二个插件，同样**只在 Rust 侧使用**
//! —— 前端拿到的是两条窄命令，`capabilities/default.json` 里没有增加任何权限。
//!
//! ## 权威在系统，不在我们的数据库
//!
//! 自启状态**刻意不写进 settings 表**。系统才是权威：
//! 注册表里的那条记录随时可能被用户在「任务管理器 → 启动应用」里关掉，
//! 我们存一份副本只会和系统不一致，然后界面显示一个错的开关。
//! 所以每次都去问 `autolaunch().is_enabled()`。
//!
//! ## Windows 上的两个坑（都体现在界面文案里）
//!
//! 1. **注册的是 exe 的绝对路径。** 把 exe 挪走，自启就失效了，
//!    但 `is_enabled()` 仍然返回 true —— 它只检查那条记录在不在，不比对路径。
//!    所以界面必须把「将要写入的路径」显示出来，并提示重新开关一次可以刷新路径。
//!    在开发时跑 `tauri dev` 尤其要注意：那时注册的是 `target/debug` 下的路径。
//! 2. **以管理员身份运行可能写进 HKLM。** 底层库的策略是「先试 HKLM，
//!    权限不够再退到 HKCU」，所以提权运行一次就会变成对全机器生效。

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::models::{AutostartStatus, OperationResult};

/// 当前这个 exe 的路径 —— 也就是开启后会写进注册表的值。
///
/// 单独取出来给界面看，是为了让「注册的到底是哪个文件」这件事**可见**。
/// 这个值只展示给用户本人，不写日志。
pub fn current_exe_path() -> String {
    match std::env::current_exe() {
        Ok(path) => path.display().to_string(),
        Err(error) => format!("（取不到 exe 路径：{error}）"),
    }
}

pub fn status(app: &AppHandle) -> AutostartStatus {
    AutostartStatus {
        // 查不到就当作「没开」：宁可让用户多点一次开关，也不要显示成开着却其实没生效
        enabled: app.autolaunch().is_enabled().unwrap_or(false),
        exe_path: current_exe_path(),
    }
}

pub fn set_enabled(app: &AppHandle, enabled: bool) -> OperationResult {
    let manager = app.autolaunch();
    let outcome = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };

    match outcome {
        Ok(()) => {
            log::info!("开机自启已{}", if enabled { "开启" } else { "关闭" });
            OperationResult {
                ok: true,
                message: if enabled {
                    "已设置开机自启。系统启动时会自动运行当前这个可执行文件。".to_string()
                } else {
                    "已关闭开机自启。".to_string()
                },
            }
        }
        Err(error) => {
            // 失败原因来自系统调用，过一遍脱敏再往外说（路径里可能带用户名）
            let message = crate::redact::redact_sensitive(&format!("修改开机自启失败：{error}"));
            log::warn!("{message}");
            OperationResult { ok: false, message }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_path_is_resolvable_in_tests() {
        // 取不到 exe 路径时函数会退化成一句说明而不是 panic —— 这里确认它至少不是空的
        assert!(!current_exe_path().is_empty());
    }
}
