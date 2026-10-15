//! 高风险能力的统一门禁（阶段 D）
//!
//! 技术方案第 6 节的原话是「**键鼠模拟和截屏**增加明确的设置开关、失败提示和权限说明，
//! 默认关闭高风险自动化能力」。截屏是第一个落地的，这一段就是那套模式本身 ——
//! 键鼠模拟照着同样四件事抄。
//!
//! ## 四件事
//!
//! 1. **默认关闭。** 不是「默认开着但给个提示」，是真的关着、调不动。
//! 2. **Rust 侧把门。** 见下面那段说明 —— 这是最容易做错的一步。
//! 3. **失败说人话。** 拒绝、失败都要给一句用户能看懂的、知道下一步做什么的话。
//! 4. **每次使用都留痕。** 日志记一条，界面上能看到最近一次用了什么。
//!
//! ## 为什么门必须设在 Rust 侧
//!
//! 前端那个开关表达的是「用户意图」，不是「权限」。命令是**可以被直接调用的** ——
//! 打开 devtools 手动 invoke 就行，不需要走我们写的任何界面逻辑。
//! 所以「开关关着就不许用」这个判断必须发生在 Rust，界面上把按钮禁掉只是体验，
//! 不是约束。
//!
//! 同理，前端不显示按钮、按钮 disabled、甚至干脆不渲染这张卡片，
//! 都不能替代这里的 `ensure_enabled`。

/// 高风险能力的默认状态：一律关闭。
///
/// 技术方案第 6 节要求默认关闭，不是「默认开着但界面上提示一下」。
pub const DEFAULT_HIGH_RISK_ENABLED: bool = false;

/// 关着的时候给用户看的话。
///
/// 要包含三件事：这是什么能力、现在为什么不能用、去哪里开。
/// 只写「未启用」等于把问题丢回给用户。
pub fn disabled_message(subject: &str) -> String {
    format!("{subject}还没有开启。这是一个需要你明确同意的能力，请先到设置的对应卡片里打开开关。")
}

/// 统一的门禁检查。开着的放行，关着的返回一句能直接显示给用户的话。
pub fn ensure_enabled(enabled: bool, subject: &str) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err(disabled_message(subject))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_disabled() {
        // 这条断言的存在意义：以后谁把默认值改成 true，必须在这里改一次，
        // 而改的时候会看到上面「技术方案第 6 节要求默认关闭」那段说明
        assert!(!DEFAULT_HIGH_RISK_ENABLED);
    }

    #[test]
    fn allows_when_enabled() {
        assert!(ensure_enabled(true, "截屏").is_ok());
    }

    #[test]
    fn refuses_when_disabled_with_an_actionable_message() {
        let message = ensure_enabled(false, "截屏").unwrap_err();

        // 三件事都要有：能力名、为什么不行、去哪里开
        assert!(message.contains("截屏"), "要说清是哪个能力：{message}");
        assert!(
            message.contains("同意"),
            "要说清这是需要用户同意的：{message}"
        );
        assert!(message.contains("设置"), "要给出下一步：{message}");
    }

    #[test]
    fn subject_appears_in_the_message() {
        // 复用这套模式的能力名字不同，提示也要跟着变，不能写死「截屏」
        assert!(disabled_message("键鼠模拟").contains("键鼠模拟"));
    }
}
