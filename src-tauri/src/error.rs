//! 统一错误类型
//!
//! 两条规矩：
//! 1. 每个变体都带**一句面向用户的话**，因为它的 `Display` 会直接进到前端的错误条里。
//! 2. 任何可能带上响应体 / 请求头的分支，都必须先过 `redact`，
//!    保证 API Key 不可能经由错误信息漏出去。

use crate::redact::safe_excerpt;

/// 错误信息里附带的响应体片段最长多少字
const EXCERPT_LIMIT: usize = 300;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("本地数据库操作失败：{0}")]
    Database(#[from] rusqlite::Error),

    #[error("无法打开本地数据库：{0}")]
    DatabaseOpen(String),

    #[error("凭据存储不可用：{0}")]
    Secret(String),

    #[error("连接模型服务失败：{0}")]
    Transport(String),

    #[error("{0}")]
    Model(String),

    #[error("{0}")]
    Invalid(String),

    #[error("内部错误：{0}")]
    Internal(String),
}

impl AppError {
    /// 网络层错误 → 面向用户的一句话。
    /// 只报「连不上 / 超时 / 证书问题」，不带 URL 里的查询串，也不带 headers。
    pub fn from_reqwest(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            return AppError::Transport("请求超时，模型服务没有在预期时间内响应。".into());
        }
        if error.is_connect() {
            return AppError::Transport(
                "无法连接到模型服务，请检查 API 地址是否正确、网络是否可达。".into(),
            );
        }
        if error.is_decode() {
            return AppError::Transport("模型服务返回的内容无法解析。".into());
        }
        AppError::Transport("请求模型服务时出错，请稍后重试。".into())
    }

    /// 非 2xx 响应 → 面向用户的一句话。
    ///
    /// 只对状态码说事，附带的响应体片段单独走 `safe_excerpt`：
    /// 既可能包含凭据，也可能把整段请求回显出来。
    pub fn from_http_status(status: u16, body: &str, api_key: &str) -> Self {
        let hint = match status {
            400 => "请求被拒绝，请检查模型名称是否正确。",
            401 | 403 => "认证失败，请检查 API Key 是否有效。",
            404 => "接口不存在，请确认地址是否为 OpenAI 兼容接口（通常以 /v1 结尾）。",
            429 => "触发限流，请稍后重试。",
            500..=599 => "模型服务端出错，请稍后重试。",
            _ => "模型服务返回了错误状态。",
        };

        let api_key = api_key.trim();
        let redacted_body = if api_key.is_empty() {
            body.to_string()
        } else {
            let mask = if api_key.starts_with("sk-") {
                "sk-***"
            } else {
                "***"
            };
            body.replace(api_key, mask)
        };
        let excerpt = safe_excerpt(&redacted_body, EXCERPT_LIMIT);
        if excerpt.is_empty() {
            AppError::Model(format!("{hint}（HTTP {status}）"))
        } else {
            AppError::Model(format!("{hint}（HTTP {status}）服务端说明：{excerpt}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failure_points_at_the_key() {
        let error = AppError::from_http_status(401, "", "");
        assert!(error.to_string().contains("API Key"));
    }

    #[test]
    fn wrong_path_points_at_the_url() {
        let error = AppError::from_http_status(404, "", "");
        assert!(error.to_string().contains("/v1"));
    }

    #[test]
    fn error_text_never_carries_a_secret() {
        let body = r#"{"error":"bad key sk-abcdef1234567890 rejected"}"#;
        let error = AppError::from_http_status(401, body, "sk-abcdef1234567890");
        let text = error.to_string();
        assert!(!text.contains("sk-abcdef1234567890"));
        assert!(text.contains("sk-***"));
    }

    #[test]
    fn error_text_redacts_unrecognized_api_key_formats() {
        let api_key = "custom-provider-key-123456";
        let body = format!("Provider rejected the credential {api_key}");
        let error = AppError::from_http_status(401, &body, api_key);

        assert!(!error.to_string().contains(api_key));
        assert!(error.to_string().contains("***"));
    }

    #[test]
    fn long_bodies_are_excerpted() {
        let body = "x".repeat(2000);
        let error = AppError::from_http_status(500, &body, "");
        // 300 字上限 + 提示语 + 省略号，远超就说明没截断
        assert!(error.to_string().chars().count() < 400);
    }
}
