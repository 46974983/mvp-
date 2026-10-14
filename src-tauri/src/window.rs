//! 主窗口的显示 / 隐藏，以及「关闭窗口时到底该做什么」的判定
//!
//! 这一小段逻辑值得单独一个文件、单独一组测试，因为它是**静默失效**的典型：
//! 判定写错时，用户点了窗口右上角的叉，窗口没关、也没退出，而且没有任何报错。
//! 他只会觉得「这软件坏了」。
//!
//! 所以判定被抽成纯函数 [`decide_close_action`]，三个输入、两个结果，
//! 每个分支都有用例；运行期的三个开关放在 [`WindowRuntime`] 里。

use std::sync::atomic::{AtomicBool, Ordering};

/// 用户按下窗口关闭按钮时，应该发生什么
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// 真的退出应用
    Exit,
    /// 拦下这次关闭，把窗口隐藏到托盘
    HideToTray,
}

/// 关闭行为的判定。
///
/// 三个输入里，`tray_available` 最容易被忽略：如果托盘图标没建起来
/// （图标缺失、系统限制等），把窗口藏起来就等于让应用**彻底失联** ——
/// 用户找不到窗口，也找不到托盘入口。这种情况下必须退回「直接退出」，
/// 让用户至少能用重新打开的方式恢复。
pub fn decide_close_action(
    quitting: bool,
    close_to_tray_enabled: bool,
    tray_available: bool,
) -> CloseAction {
    if quitting || !close_to_tray_enabled || !tray_available {
        CloseAction::Exit
    } else {
        CloseAction::HideToTray
    }
}

/// 窗口相关的运行期开关。
///
/// 为什么用内存里的原子布尔而不是每次查库：窗口关闭事件可能被连续触发
/// （用户连点、系统重发），而为了一次判断去开一次数据库连接不值得。
/// 数据库是权威，这里是它的缓存；只有 `set_close_to_tray` 命令会同时改两边。
#[derive(Debug)]
pub struct WindowRuntime {
    /// 用户已经点了「退出」，后续的关闭请求不要再拦
    quitting: AtomicBool,
    /// 托盘图标是否真的建起来了
    tray_available: AtomicBool,
    /// 「关闭窗口时缩到托盘」的用户选择
    close_to_tray: AtomicBool,
}

impl WindowRuntime {
    pub fn new(close_to_tray: bool) -> Self {
        Self {
            quitting: AtomicBool::new(false),
            // 先假设不可用：托盘建成功之后才置为 true。
            // 反过来（默认可用）会出现一个短暂窗口期，用户正好在这时关窗口就会被藏起来。
            tray_available: AtomicBool::new(false),
            close_to_tray: AtomicBool::new(close_to_tray),
        }
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }

    /// 标记「这次是真的要退出」，让关闭事件不再被拦截
    pub fn mark_quitting(&self) {
        self.quitting.store(true, Ordering::Relaxed);
    }

    pub fn tray_available(&self) -> bool {
        self.tray_available.load(Ordering::Relaxed)
    }

    pub fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, Ordering::Relaxed);
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_close_to_tray(&self, enabled: bool) {
        self.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_to_tray_when_enabled_and_available() {
        assert_eq!(
            decide_close_action(false, true, true),
            CloseAction::HideToTray
        );
    }

    #[test]
    fn exits_when_user_turned_the_option_off() {
        assert_eq!(decide_close_action(false, false, true), CloseAction::Exit);
    }

    #[test]
    fn exits_when_tray_is_not_available() {
        // 托盘不可用时藏窗口 = 让应用彻底失联，必须退回退出
        assert_eq!(decide_close_action(false, true, false), CloseAction::Exit);
    }

    #[test]
    fn exits_when_already_quitting() {
        // 托盘菜单点了「退出」之后，窗口关闭请求不该再被拦下来
        assert_eq!(decide_close_action(true, true, true), CloseAction::Exit);
        assert_eq!(decide_close_action(true, false, false), CloseAction::Exit);
    }

    #[test]
    fn quitting_flag_is_one_way() {
        let runtime = WindowRuntime::new(true);
        assert!(!runtime.is_quitting());
        runtime.mark_quitting();
        assert!(runtime.is_quitting());
    }

    #[test]
    fn tray_starts_as_unavailable_until_confirmed() {
        // 默认必须是「不可用」：宁可多一次「关闭就退出」，也不要藏起窗口却找不到入口
        let runtime = WindowRuntime::new(true);
        assert!(!runtime.tray_available());

        runtime.set_tray_available(true);
        assert!(runtime.tray_available());
        assert!(runtime.close_to_tray());
    }

    #[test]
    fn close_to_tray_setting_is_mutable_at_runtime() {
        let runtime = WindowRuntime::new(true);
        runtime.set_close_to_tray(false);
        assert!(!runtime.close_to_tray());

        assert_eq!(
            decide_close_action(
                runtime.is_quitting(),
                runtime.close_to_tray(),
                runtime.tray_available()
            ),
            CloseAction::Exit
        );
    }
}
