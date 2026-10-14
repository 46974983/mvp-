//! 系统通知
//!
//! 阶段 C 引入的第一个 Tauri 插件（`tauri-plugin-notification`）。
//!
//! ## 为什么插件只在 Rust 侧用
//!
//! 插件自带一套前端 JS API，但我们**没有**给前端开它。原因是这一项最有价值的
//! 判断恰恰在 Rust 侧：**窗口正在前台时不该弹通知**。
//! 前端不知道窗口可见性和焦点状态（知道了也得再开一条命令去问），
//! 所以策略放在这里，前端只说一句「回复完成了」。
//!
//! 另一个好处是权限：前端拿到的是下面这两条窄命令，
//! `capabilities/default.json` 里**没有**增加任何权限。
//!
//! ## 为什么没有权限处理分支
//!
//! 桌面端不需要请求通知权限 —— 插件自己的文档就这么写的，
//! `permission_state()` 与 `request_permission()` 在桌面实现里恒返回 `Granted`。
//! 照着 Web 的思路写一套「查询 → 请求 → 再查询」的流程，在 Windows 上就是死代码，
//! 还会让读代码的人以为这里真的有一个授权步骤。
//!
//! 真正控制通知开关的地方是 Windows 的「设置 → 系统 → 通知」，逐应用生效，
//! 应用自己查不到也改不了。所以界面上如实这样说，而不是给一个点了没用的按钮。

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::MAIN_WINDOW_LABEL;
use crate::models::NotifyOutcome;

/// 打扰判定：窗口正在前台**且**处于聚焦状态时才跳过。
///
/// 抽成纯函数是因为它是这条链路里唯一值得推敲的地方，而它的错法很难发现：
/// 判反了不会报错，只会让用户在用的时候莫名收到一条通知，或者切走了却什么都没收到。
///
/// 为什么是「且」：
/// - 可见 + 聚焦 = 用户正盯着屏幕看回复，再弹一条是纯打扰；
/// - 可见但没聚焦 = 窗口被别的程序挡住了（或用户点了别处），用户看不到，该通知；
/// - 不可见（已缩到托盘）= 最典型的场景，必须通知。
pub fn should_notify(window_visible: bool, window_focused: bool) -> bool {
    !(window_visible && window_focused)
}

/// 主窗口的（可见, 聚焦）。窗口取不到时按「不可见」处理。
///
/// 取不到窗口几乎是不会发生的事，真发生了也应该**宁可多发一条通知**，
/// 也不要让用户在后台一直等一个永远不会来的提醒。
fn main_window_state(app: &AppHandle) -> (bool, bool) {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => (
            window.is_visible().unwrap_or(false),
            window.is_focused().unwrap_or(false),
        ),
        None => (false, false),
    }
}

/// 通知标题为空时退化成这个
const FALLBACK_TITLE: &str = "桌面 AI 助手";
const MAX_TITLE_CHARS: usize = 64;
const MAX_BODY_CHARS: usize = 200;

/// 按字符截断，不按字节 —— 按字节切会把一个汉字劈成两半，变成乱码。
fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let kept: String = value.chars().take(limit.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// 规范化通知内容。
///
/// 两件事：空标题退化成应用名（标题为空的 toast 在 Windows 上显示很奇怪），
/// 以及限长（回复可能很长，整段塞进通知既看不完也没意义）。
///
/// 刻意**不做脱敏**：这段内容是用户自己的对话，原样显示给他看是本意；
/// 而且脱敏规则会把 `sk-` 开头之类的正常文本也抹掉，在这里反而像 bug。
/// 真正需要脱敏的是错误信息，那条路径走的是 `redact::redact_sensitive`。
pub fn normalize_notification(title: &str, body: &str) -> (String, String) {
    let trimmed_title = title.trim();
    let title = if trimmed_title.is_empty() {
        FALLBACK_TITLE
    } else {
        trimmed_title
    };

    (
        truncate_chars(title, MAX_TITLE_CHARS),
        truncate_chars(body.trim(), MAX_BODY_CHARS),
    )
}

/// 发一条系统通知。
///
/// `force = false`（回复完成的正常路径）：先过打扰判定。
/// `force = true`（设置页的「发一条测试通知」）：用户明确要求看到它，不做判定。
pub fn deliver(app: &AppHandle, title: &str, body: &str, force: bool) -> NotifyOutcome {
    if !force {
        let (visible, focused) = main_window_state(app);
        if !should_notify(visible, focused) {
            log::debug!("窗口在前台，跳过通知");
            return NotifyOutcome {
                delivered: false,
                reason: "窗口正在前台，已跳过通知。".to_string(),
            };
        }
    }

    let (title, body) = normalize_notification(title, body);

    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => {
            log::info!("已发送系统通知");
            NotifyOutcome {
                delivered: true,
                reason: "已发送系统通知。".to_string(),
            }
        }
        Err(error) => {
            // 失败原因来自插件，可能包含路径之类的环境信息，统一过一遍脱敏再往外说
            let reason = crate::redact::redact_sensitive(&format!("发送通知失败：{error}"));
            log::warn!("{reason}");
            NotifyOutcome {
                delivered: false,
                reason,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifies_when_window_is_hidden() {
        // 缩到托盘之后收到回复 —— 这是通知存在的全部理由
        assert!(should_notify(false, false));
    }

    #[test]
    fn notifies_when_window_is_visible_but_not_focused() {
        // 窗口被别的程序挡住 / 用户点了别处，看不到回复
        assert!(should_notify(true, false));
        assert!(should_notify(false, true));
    }

    #[test]
    fn skips_only_when_window_is_visible_and_focused() {
        assert!(!should_notify(true, true));
    }

    #[test]
    fn the_skip_condition_is_exactly_one_of_four_combinations() {
        // 真值表写全：四种组合里只有一种跳过。
        // 这条用例的价值在于——以后谁想改判定逻辑，必须先想清楚另外三种怎么办。
        let combinations = [(false, false), (false, true), (true, false), (true, true)];
        let notify_count = combinations
            .iter()
            .filter(|(visible, focused)| should_notify(*visible, *focused))
            .count();
        assert_eq!(notify_count, 3, "四种组合里应当只有「可见且聚焦」一种跳过");
    }

    #[test]
    fn empty_title_falls_back_to_the_app_name() {
        let (title, _) = normalize_notification("   ", "回复好了");
        assert_eq!(title, FALLBACK_TITLE);
    }

    #[test]
    fn notification_text_is_trimmed() {
        let (title, body) = normalize_notification("  会话 A  ", "  回复好了  ");
        assert_eq!(title, "会话 A");
        assert_eq!(body, "回复好了");
    }

    #[test]
    fn long_text_is_truncated_by_characters_not_bytes() {
        let (title, body) = normalize_notification(&"标".repeat(200), &"正".repeat(500));

        assert!(title.chars().count() <= MAX_TITLE_CHARS);
        assert!(body.chars().count() <= MAX_BODY_CHARS);
        // 汉字按字节截会变成乱码，这里必须还是合法的汉字 + 省略号
        assert!(title.ends_with('…'));
        assert!(body.ends_with('…'));
        assert!(title.starts_with('标'));
    }

    #[test]
    fn short_text_is_left_alone() {
        let (title, body) = normalize_notification("会话 A", "回复好了");
        assert_eq!(title, "会话 A");
        assert_eq!(body, "回复好了");
        assert!(!title.ends_with('…'));
    }
}
