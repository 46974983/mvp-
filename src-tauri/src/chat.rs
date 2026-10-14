//! 模型请求（OpenAI 兼容接口）
//!
//! 技术方案第 5 节的 `ModelProvider` 在这里落地：`test_connection` + `stream_chat` + 取消。
//!
//! 三条纪律：
//! 1. **系统提示词与用户消息分开组装。** `ChatRequest` 里它们是两个字段，
//!    只有拼请求体的那一刻才合到一起，且 system 永远是独立的一条。
//! 2. **Key 只在请求头里出现一次**，不进任何错误信息、不进日志。
//! 3. **请求由 Rust 发出。** 前端的 WebView 不需要网络权限，
//!    这也是「API Key 不留在浏览器里」的实现方式。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};
use crate::models::OperationResult;

/// 检查取消标记的间隔。太大会让「停止」按下去没反应，太小是白转
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// 连接超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 单次读取超时：流式响应正常的间隔是毫秒级，60 秒没动静就是出问题了
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 本地校验用的最小 Key 长度，和前端表单保持一致
const MIN_API_KEY_LENGTH: usize = 8;

const USER_AGENT: &str = "desktop-ai-assistant/0.2";

// ---------------------------------------------------------------------------
// 请求 / 响应类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// 一次对话请求。
/// `system_prompt` 和 `messages` 是两个字段 —— 这是刻意的：
/// 给它们混在一个数组里的机会，就等于放弃了对这两类输入的区分。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub model: String,
    pub system_prompt: String,
    pub messages: Vec<ChatTurn>,
}

/// 通过 Tauri Channel 推给前端的增量事件
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// 累计至今的完整文本（不是增量片段），前端直接覆盖渲染即可
    Delta { text: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamResult {
    /// complete | aborted
    pub outcome: String,
    pub text: String,
}

// ---------------------------------------------------------------------------
// 纯函数部分（可单测，不碰网络）
// ---------------------------------------------------------------------------

/// 把用户填的地址和接口路径拼起来
pub fn endpoint(base: &str, path: &str) -> AppResult<String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::Invalid("请填写 API 地址。".to_string()));
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(AppError::Invalid(
            "API 地址需要以 http:// 或 https:// 开头。".to_string(),
        ));
    }
    Ok(format!("{trimmed}/{path}"))
}

/// 组装请求体。
/// system 提示词在这里被放到最前面，作为独立的一条 system 消息；
/// 用户消息按原顺序跟在后面。
pub fn build_payload(request: &ChatRequest) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(request.messages.len() + 1);

    if !request.system_prompt.trim().is_empty() {
        messages.push(serde_json::json!({
            "role": "system",
            "content": request.system_prompt,
        }));
    }
    for turn in &request.messages {
        messages.push(serde_json::json!({
            "role": turn.role,
            "content": turn.content,
        }));
    }

    serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
    })
}

/// 一行 SSE 解析出来的结果
#[derive(Debug, PartialEq, Eq)]
pub enum SseLine {
    /// 拿到了一个内容片段
    Delta(String),
    /// 服务端说「说完了」
    Done,
    /// 与本应用无关的行（注释、心跳、事件名等）
    Ignore,
}

/// 解析一行 SSE。
///
/// OpenAI 兼容接口的流式格式是每行 `data: {json}`，最后一行 `data: [DONE]`。
/// 解析失败的 JSON 一律当作无关行忽略 —— 流式解析不能因为一行看不懂就整段垮掉。
pub fn parse_sse_line(line: &str) -> SseLine {
    let line = line.trim();
    let Some(payload) = line.strip_prefix("data:") else {
        return SseLine::Ignore;
    };
    let payload = payload.trim();

    if payload.is_empty() {
        return SseLine::Ignore;
    }
    if payload == "[DONE]" {
        return SseLine::Done;
    }

    match serde_json::from_str::<serde_json::Value>(payload) {
        Ok(value) => extract_delta(&value)
            .map(SseLine::Delta)
            .unwrap_or(SseLine::Ignore),
        Err(_) => SseLine::Ignore,
    }
}

/// 从一条 chunk 里取出 `choices[0].delta.content`
fn extract_delta(value: &serde_json::Value) -> Option<String> {
    let content = value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()?;
    if content.is_empty() {
        return None;
    }
    Some(content.to_string())
}

/// 校验本地就能判断的部分，避免把明显有问题的配置发出去
pub fn validate_api_key(api_key: &str) -> AppResult<()> {
    if api_key.trim().is_empty() {
        return Err(AppError::Invalid(
            "尚未保存 API Key，请先在设置里填写。".to_string(),
        ));
    }
    if api_key.trim().len() < MIN_API_KEY_LENGTH {
        return Err(AppError::Invalid(
            "API Key 看起来太短了，请检查是否复制完整。".to_string(),
        ));
    }
    Ok(())
}

fn build_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| AppError::Internal(format!("无法初始化网络客户端：{error}")))
}

// ---------------------------------------------------------------------------
// 测试连接
// ---------------------------------------------------------------------------

/// 用「列出模型」这个只读接口验证连通性和凭据。
/// 选它而不是发一次最小对话：不消耗额度、语义明确、任何 OpenAI 兼容服务都实现了。
pub async fn test_connection(
    api_url: &str,
    api_key: &str,
    model_name: &str,
) -> AppResult<OperationResult> {
    validate_api_key(api_key)?;
    let url = endpoint(api_url, "models")?;

    let response = build_client()?
        .get(&url)
        .bearer_auth(api_key.trim())
        .send()
        .await
        .map_err(|error| AppError::from_reqwest(&error))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::from_http_status(status.as_u16(), &body));
    }

    let body = response.text().await.unwrap_or_default();
    Ok(OperationResult {
        ok: true,
        message: describe_models(&body, model_name),
    })
}

/// 把「列出模型」的响应翻成一句给用户看的话。
/// 只说结论和事实，不回显任何服务端原文。
fn describe_models(body: &str, model_name: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return "连接成功，凭据有效。服务端返回的不是标准模型列表，已按 OpenAI 兼容接口处理。"
            .to_string();
    };

    let Some(models) = value.get("data").and_then(|data| data.as_array()) else {
        return "连接成功，凭据有效。服务端返回的不是标准模型列表，已按 OpenAI 兼容接口处理。"
            .to_string();
    };

    let names: Vec<&str> = models
        .iter()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .collect();

    let wanted = model_name.trim();
    if wanted.is_empty() {
        return format!(
            "连接成功，凭据有效。服务端报告 {} 个可用模型。",
            names.len()
        );
    }
    if names.iter().any(|name| *name == wanted) {
        format!(
            "连接成功，凭据有效。服务端报告 {} 个可用模型，其中包含「{wanted}」。",
            names.len()
        )
    } else {
        format!(
            "连接成功，凭据有效。但服务端报告 {} 个可用模型里没有「{wanted}」，请确认模型名称。",
            names.len()
        )
    }
}

// ---------------------------------------------------------------------------
// 流式对话
// ---------------------------------------------------------------------------

/// 发起流式对话。
///
/// `on_event` 用来把增量推到前端；`cancel` 由 `cancel_chat` 命令置位。
/// 取消不是错误，所以取消时返回 `outcome = "aborted"` 而不是 Err ——
/// 前端要保留已经生成的部分，而不是弹一个错误条。
pub async fn stream_chat(
    api_url: &str,
    api_key: &str,
    request: ChatRequest,
    cancel: Arc<AtomicBool>,
    on_event: &Channel<StreamEvent>,
) -> AppResult<StreamResult> {
    validate_api_key(api_key)?;
    let url = endpoint(api_url, "chat/completions")?;
    let payload = build_payload(&request);

    let response = build_client()?
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&payload)
        .send()
        .await
        .map_err(|error| AppError::from_reqwest(&error))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::from_http_status(status.as_u16(), &body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut accumulated = String::new();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(StreamResult {
                outcome: "aborted".to_string(),
                text: accumulated,
            });
        }

        // 带超时地等下一块：这样「停止」最多迟 200ms 生效，
        // 而不是要等到模型吐出下一个 token 才可能被看见
        let next = match tokio::time::timeout(CANCEL_POLL_INTERVAL, stream.next()).await {
            Ok(Some(chunk)) => chunk.map_err(|error| AppError::from_reqwest(&error))?,
            Ok(None) => break,
            Err(_) => continue,
        };

        buffer.push_str(&String::from_utf8_lossy(&next));

        // SSE 以行为单位，但一行可能被拆在两个 chunk 里，所以要留着残余等下一块
        while let Some(position) = buffer.find('\n') {
            let line: String = buffer[..position].trim_end_matches('\r').to_string();
            buffer.drain(..=position);

            match parse_sse_line(&line) {
                SseLine::Delta(text) => {
                    accumulated.push_str(&text);
                    // 推累计全文：前端不需要自己维护拼接状态
                    let _ = on_event.send(StreamEvent::Delta {
                        text: accumulated.clone(),
                    });
                }
                SseLine::Done => {
                    return Ok(StreamResult {
                        outcome: "complete".to_string(),
                        text: accumulated,
                    });
                }
                SseLine::Ignore => {}
            }
        }
    }

    // 有些服务端不发 [DONE]，直接断流。这时按「说完了」处理。
    Ok(StreamResult {
        outcome: if cancel.load(Ordering::Relaxed) {
            "aborted".to_string()
        } else {
            "complete".to_string()
        },
        text: accumulated,
    })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ChatRequest {
        ChatRequest {
            model: "gpt-4o-mini".into(),
            system_prompt: "你是一个简洁的助手。".into(),
            messages: vec![
                ChatTurn {
                    role: "user".into(),
                    content: "你好".into(),
                },
                ChatTurn {
                    role: "assistant".into(),
                    content: "你好，有什么可以帮你的？".into(),
                },
                ChatTurn {
                    role: "user".into(),
                    content: "帮我看看这段代码".into(),
                },
            ],
        }
    }

    #[test]
    fn endpoint_appends_path_and_trims_slash() {
        assert_eq!(
            endpoint("https://api.example.com/v1", "models").unwrap(),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            endpoint("  https://api.example.com/v1/  ", "models").unwrap(),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn endpoint_rejects_empty_and_relative_urls() {
        assert!(endpoint("", "models").is_err());
        assert!(endpoint("api.example.com/v1", "models").is_err());
        assert!(endpoint("ftp://api.example.com", "models").is_err());
    }

    #[test]
    fn payload_puts_system_prompt_in_its_own_message() {
        let payload = build_payload(&request());
        let messages = payload["messages"].as_array().unwrap();

        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "你是一个简洁的助手。");
        // 用户消息里不该带上系统提示词
        for message in messages.iter().skip(1) {
            let content = message["content"].as_str().unwrap();
            assert!(!content.contains("你是一个简洁的助手。"));
        }
        assert_eq!(messages.len(), 4);
    }

    #[test]
    fn payload_requests_streaming() {
        assert_eq!(build_payload(&request())["stream"], true);
        assert_eq!(build_payload(&request())["model"], "gpt-4o-mini");
    }

    #[test]
    fn payload_omits_empty_system_prompt() {
        let mut request = request();
        request.system_prompt = "   ".into();
        let payload = build_payload(&request);
        let messages = payload["messages"].as_array().unwrap();
        assert!(messages.iter().all(|message| message["role"] != "system"));
    }

    #[test]
    fn parses_a_delta_line() {
        let line = r#"data: {"choices":[{"delta":{"content":"你好"},"index":0}]}"#;
        assert_eq!(parse_sse_line(line), SseLine::Delta("你好".to_string()));
    }

    #[test]
    fn parses_done_marker() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseLine::Done);
    }

    #[test]
    fn ignores_comments_and_other_events() {
        assert_eq!(parse_sse_line(": ping"), SseLine::Ignore);
        assert_eq!(parse_sse_line("event: message"), SseLine::Ignore);
        assert_eq!(parse_sse_line(""), SseLine::Ignore);
        assert_eq!(parse_sse_line("data: "), SseLine::Ignore);
    }

    #[test]
    fn ignores_unparseable_and_contentless_chunks() {
        assert_eq!(parse_sse_line("data: {not json}"), SseLine::Ignore);
        // 只有 role 的第一条 chunk，没有内容，不该产生空增量
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(parse_sse_line(line), SseLine::Ignore);
    }

    #[test]
    fn rejects_missing_or_too_short_api_key() {
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("   ").is_err());
        assert!(validate_api_key("short").is_err());
        assert!(validate_api_key("sk-abcdef123456").is_ok());
    }

    #[test]
    fn model_list_messages_never_echo_the_body() {
        let body = r#"{"data":[{"id":"gpt-4o-mini"},{"id":"gpt-4o"}]}"#;
        let message = describe_models(body, "gpt-4o-mini");
        assert!(message.contains("包含"));
        assert!(message.contains("gpt-4o-mini"));

        let missing = describe_models(body, "gpt-5");
        assert!(missing.contains("没有"));

        let weird = describe_models("not json", "gpt-4o-mini");
        assert!(weird.contains("连接成功"));
    }
}
