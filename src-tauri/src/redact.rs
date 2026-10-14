//! 敏感信息脱敏
//!
//! 技术方案第 5 节：日志中禁止输出 API Key、完整请求头和敏感响应。
//!
//! 这里的实现刻意不引正则库：规则只有两条，手写扫描反而更容易看清边界，
//! 而脱敏代码最怕的就是「看起来对了」。规则宁可多杀一点，也不要漏。

/// 判断是否属于 token 字符（API Key 的字符集）
fn is_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || ch == '-'
        || ch == '_'
        || ch == '.'
        || ch == '~'
        || ch == '+'
        || ch == '/'
}

/// 需要至少这么长的 token 才值得脱敏。
/// 太短的（例如 `sk-123`）大概率不是凭据，误杀只会让错误信息变得难读。
const MIN_TOKEN_LEN: usize = 6;

/// 把文本里像凭据的片段替换成掩码。
///
/// 覆盖两种形状：
/// - `sk-...`（OpenAI 风格的 key）
/// - `Bearer ...`（Authorization 头里的 token）
pub fn redact_sensitive(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut rest = input;

    loop {
        let next = [rest.find("sk-"), rest.find("Bearer ")]
            .into_iter()
            .flatten()
            .min();

        let Some(index) = next else {
            result.push_str(rest);
            break;
        };

        let is_bearer = rest[index..].starts_with("Bearer ");
        let prefix = if is_bearer { "Bearer " } else { "sk-" };

        let after_prefix = &rest[index + prefix.len()..];
        let mut token_bytes = 0usize;
        for ch in after_prefix.chars() {
            if is_token_char(ch) {
                token_bytes += ch.len_utf8();
            } else {
                break;
            }
        }
        let token_len = after_prefix[..token_bytes].chars().count();

        if token_len < MIN_TOKEN_LEN {
            // 不像凭据，原样保留，继续往后找
            result.push_str(&rest[..index + prefix.len()]);
            rest = &rest[index + prefix.len()..];
            continue;
        }

        result.push_str(&rest[..index]);
        result.push_str(if is_bearer { "Bearer ***" } else { "sk-***" });
        rest = &rest[index + prefix.len() + token_bytes..];
    }

    result
}

/// 把一段文本裁到指定字符数以内，用于错误信息里附带的响应体片段。
/// 之所以要裁：模型服务的报错可能很长，也可能把请求内容原样回显。
pub fn truncate_for_message(input: &str, max_chars: usize) -> String {
    let trimmed = input.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max_chars).collect();
    format!("{head}…")
}

/// 先脱敏再截断。给错误信息用，顺序不能反 ——
/// 先截断的话，一个跨过截断点的 key 会被切成半截，两条规则都会失效。
pub fn safe_excerpt(input: &str, max_chars: usize) -> String {
    truncate_for_message(&redact_sensitive(input), max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_openai_style_key() {
        assert_eq!(
            redact_sensitive("失败：sk-abcdef1234567890 无效"),
            "失败：sk-*** 无效"
        );
    }

    #[test]
    fn redacts_bearer_token() {
        let cleaned = redact_sensitive("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc");
        assert!(!cleaned.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(cleaned.contains("***"));
    }

    #[test]
    fn keeps_short_words_intact() {
        assert_eq!(redact_sensitive("sk-123"), "sk-123");
    }

    #[test]
    fn keeps_plain_text_intact() {
        let text = "无法连接到 api.example.com，请检查地址和网络。";
        assert_eq!(redact_sensitive(text), text);
    }

    #[test]
    fn redacts_multiple_secrets_in_one_pass() {
        let cleaned = redact_sensitive("a sk-aaaaaa111 b sk-bbbbbb222 c");
        assert_eq!(cleaned, "a sk-*** b sk-*** c");
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        // 中文一个字 3 字节，按字节截断会截出半个字
        assert_eq!(truncate_for_message("中文内容", 2), "中文…");
        assert_eq!(truncate_for_message("短", 5), "短");
    }

    #[test]
    fn redacts_before_truncating() {
        let text = "错误详情：sk-abcdefghijklmnop 后面还有很长的说明文字";
        let excerpt = safe_excerpt(text, 12);
        assert!(!excerpt.contains("sk-abcdefghijklmnop"));
    }
}
