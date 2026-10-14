//! 全局快捷键
//!
//! 用 `tauri-plugin-global-shortcut`。这是阶段 C 引入的第四个插件，
//! 同样**只在 Rust 侧使用**：前端拿到的是两条窄命令，
//! `capabilities/default.json` 里没有增加任何权限。
//!
//! ## 这一项的难点不在注册，在「注册失败」
//!
//! 全局快捷键是抢系统资源的：同一个组合键全系统只有一个程序能占住。
//! 用户想设 `Ctrl+Shift+Space`，很可能已经被输入法、截图工具或者别的助手占了。
//! 那时 `register` 会返回错误，而**用户看到的只是「按了没反应」** ——
//! 他不会想到是键被占了，只会觉得软件坏了。
//!
//! 所以这里做三件事：
//!   1. 注册失败时把「可能被别的程序占用」明确说出来，而不是抛原始错误；
//!   2. 换键时先把旧键注销掉，避免新旧都占着；
//!   3. 拒绝「没有修饰键」的组合 —— 那会把用户在全系统范围内的按键都吃掉。
//!
//! ## 一次按键会来两个事件
//!
//! `on_shortcut` 的回调在按下和松开时都会触发。两个都当切换用，
//! 按一次键窗口就会闪两下。所以只认 `Pressed`。

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::models::{GlobalShortcutStatus, OperationResult};

/// 认识的修饰键写法（Tauri 的 accelerator 语法）
const MODIFIERS: &[&str] = &[
    "commandorcontrol",
    "cmdorctrl",
    "control",
    "ctrl",
    "alt",
    "option",
    "shift",
    "super",
    "command",
    "cmd",
    "meta",
];

/// 校验一个 accelerator 字符串。
///
/// 只允许「一个或多个修饰键 + 一个按键」，且**必须有修饰键**。
/// 单独一个 `A` 也是合法 accelerator，但注册上去之后用户在任何程序里打字都会被它截走 ——
/// 这不是一个小失误，是能把系统弄得没法用。所以在这一层直接拒掉。
pub fn validate(accelerator: &str) -> Result<(), String> {
    let parts: Vec<&str> = accelerator
        .trim()
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();

    if parts.is_empty() {
        return Err("快捷键不能为空。".to_string());
    }
    if parts.len() < 2 {
        return Err("快捷键至少要有一个修饰键加一个按键，例如 Ctrl+Shift+Space。".to_string());
    }

    let (modifiers, keys) = parts.split_at(parts.len() - 1);

    if !modifiers
        .iter()
        .all(|modifier| MODIFIERS.contains(&modifier.to_ascii_lowercase().as_str()))
    {
        return Err("快捷键里出现了不认识的修饰键，请重新录一次。".to_string());
    }

    // 最后那一段必须是**真正的按键**，不能还是修饰键。
    // `Ctrl+Alt` 这种「全是修饰键」的写法语法上成立，但注册出去是没有意义的，
    // 而且底层库大概率会报一个用户看不懂的解析错误。
    if keys[0].is_empty() || MODIFIERS.contains(&keys[0].to_ascii_lowercase().as_str()) {
        return Err("快捷键只有修饰键，还缺一个实际按键（例如 K、F5、Space）。".to_string());
    }

    Ok(())
}

/// 当前注册状态：存的值是什么、到底有没有注册上。
pub fn status(app: &AppHandle, accelerator: &str) -> GlobalShortcutStatus {
    let trimmed = accelerator.trim();
    GlobalShortcutStatus {
        accelerator: trimmed.to_string(),
        // 空串表示用户没设快捷键，那就不存在「注册没注册」这回事
        registered: !trimmed.is_empty() && app.global_shortcut().is_registered(trimmed),
    }
}

/// 应用一次快捷键变更。
///
/// `previous` 是**当前已经生效**的那个（空串表示没有），`next` 是用户新设的
/// （`None` 或空串表示关闭）。
///
/// ## 为什么先注册新的、成功了再撤旧的
///
/// 直觉写法是「先注销旧键，再注册新键」。但那样一旦新键被别的程序占用而注册失败，
/// 用户会掉进一个很糟的状态：**一个快捷键都不生效，而界面上还显示着旧的那个**。
///
/// 反过来做就没有这个问题 —— 注册失败时旧键原封不动，界面显示的和实际生效的始终一致。
/// 这类「失败路径上的状态一致性」是这个功能里最值得较真的地方，
/// 因为用户对「按了没反应」没有任何排查手段。
pub fn apply(app: &AppHandle, previous: &str, next: Option<&str>) -> OperationResult {
    let manager = app.global_shortcut();
    let previous = previous.trim();

    let next = next
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let Some(next) = next else {
        if !previous.is_empty()
            && let Err(error) = manager.unregister(previous)
        {
            log::warn!("注销全局快捷键失败：{error}");
        }
        log::info!("全局快捷键已关闭");
        return OperationResult {
            ok: true,
            message: "已关闭全局快捷键。".to_string(),
        };
    };

    if let Err(reason) = validate(&next) {
        return OperationResult {
            ok: false,
            message: reason,
        };
    }

    // 先注册新的
    let registered = manager.on_shortcut(next.as_str(), |app, _shortcut, event| {
        // 按下和松开都会回调，只认按下 —— 两个都处理会让窗口按一次闪两下
        if event.state == ShortcutState::Pressed {
            crate::window::toggle_main_window(app);
        }
    });

    match registered {
        Ok(()) => {
            // 新的已经生效，这时候撤掉旧的才安全
            if !previous.is_empty() && previous != next {
                if let Err(error) = manager.unregister(previous) {
                    log::warn!("旧快捷键注销失败，它可能仍然生效：{error}");
                }
            }

            log::info!("全局快捷键已注册");
            OperationResult {
                ok: true,
                message: format!(
                    "已注册全局快捷键 {next}。按下它能把窗口叫到前台，再按一次收起来。"
                ),
            }
        }
        Err(error) => {
            // 最常见的失败原因是键被别的程序占了。原始错误只有一句 OS 层面的提示，
            // 用户看不懂，所以这里直接给出可执行的下一步。
            log::warn!("全局快捷键注册失败：{error}");
            OperationResult {
                ok: false,
                message: format!(
                    "注册 {next} 失败。这个组合键可能已被别的程序占用，换一个再试；\
                     如果换了几个都不行，可能是当前系统的热键资源已满。"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_normal_combination() {
        assert!(validate("CommandOrControl+Shift+Space").is_ok());
        assert!(validate("Ctrl+Alt+K").is_ok());
        assert!(validate("Alt+F4").is_ok());
    }

    #[test]
    fn tolerates_spaces_and_extra_plus_signs() {
        // 前端拼串时可能带上空格，不该因此判为非法
        assert!(validate(" Ctrl + Shift + K ").is_ok());
        assert!(validate("Ctrl++Shift+K").is_ok());
    }

    #[test]
    fn rejects_a_bare_key() {
        // 这是最危险的一种：注册上去之后用户在任何程序里打这个键都会被截走
        let error = validate("K").unwrap_err();
        assert!(
            error.contains("修饰键"),
            "错误信息要讲清为什么不行：{error}"
        );
    }

    #[test]
    fn rejects_a_lone_modifier() {
        assert!(validate("Shift").is_err());
        // 「全是修饰键」也是不行的 —— 语法成立但没有任何意义
        assert!(validate("Ctrl+Alt").is_err());
        assert!(validate("Ctrl+Shift+Alt+Super").is_err());
    }

    #[test]
    fn rejects_unknown_modifiers() {
        // 把不认识的词当修饰键会让用户以为自己设的是 Ctrl+K，实际却不是
        assert!(validate("Hyper+K").is_err());
        assert!(validate("随便+X").is_err());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
    }

    #[test]
    fn accepts_all_the_modifier_spellings_we_claim_to_support() {
        // 这个断言的作用是：以后谁往 MODIFIERS 里加了新写法，都必须在这里过一次，
        // 逼着人想清楚它到底会不会被 Tauri 认
        for modifier in MODIFIERS {
            let accelerator = format!("{modifier}+K");
            assert!(validate(&accelerator).is_ok(), "{accelerator} 应当被接受");
        }
    }
}
