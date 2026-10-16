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

use std::future::Future;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{
    StreamExt,
    future::{Either, select},
};
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

const USER_AGENT: &str = "desktop-ai-assistant/0.3";

// ---------------------------------------------------------------------------
// 请求 / 响应类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
    /// 这一轮带的附件。不带这个字段的老调用方也合法。
    #[serde(default)]
    pub attachments: Vec<crate::models::ChatAttachment>,
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
pub fn validate_api_url(base: &str) -> AppResult<reqwest::Url> {
    let trimmed = base.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("请填写 API 地址。".to_string()));
    }

    let url = reqwest::Url::parse(trimmed).map_err(|_| {
        AppError::Invalid("API 地址格式不正确，请填写完整的 http:// 或 https:// 地址。".into())
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Invalid(
            "API 地址只支持 http:// 或 https://。".to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::Invalid(
            "API 地址里不能包含用户名或密码，请把凭据填在 API Key 栏。".to_string(),
        ));
    }
    if url.fragment().is_some() {
        return Err(AppError::Invalid(
            "API 地址不能包含片段（# 后面的内容），请填写服务地址本身。".to_string(),
        ));
    }
    if url.query_pairs().any(|(name, _)| {
        let normalized = name
            .chars()
            .filter(|character| !matches!(character, '_' | '-' | '.'))
            .flat_map(char::to_lowercase)
            .collect::<String>();
        matches!(
            normalized.as_str(),
            "key"
                | "apikey"
                | "xapikey"
                | "accesskey"
                | "accesskeyid"
                | "awsaccesskeyid"
                | "token"
                | "accesstoken"
                | "refreshtoken"
                | "securitytoken"
                | "authorization"
                | "auth"
                | "credential"
                | "credentials"
                | "secret"
                | "clientsecret"
                | "password"
                | "passphrase"
                | "signature"
                | "sig"
        ) || ["apikey", "token", "credential", "secret", "signature"]
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
    }) {
        return Err(AppError::Invalid(
            "API 地址查询参数不能包含 Key、token 或其他凭据，请把凭据填在 API Key 栏。".to_string(),
        ));
    }
    if url.scheme() == "http" {
        let host = url
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let is_loopback = host.eq_ignore_ascii_case("localhost")
            || IpAddr::from_str(host)
                .map(|address| address.is_loopback())
                .unwrap_or(false);
        if !is_loopback {
            return Err(AppError::Invalid(
                "为避免 API Key 明文传输，HTTP 只允许本机地址；远程服务请使用 HTTPS。".to_string(),
            ));
        }
    }
    Ok(url)
}

/// 把用户填的地址和接口路径拼起来
pub fn endpoint(base: &str, path: &str) -> AppResult<String> {
    let mut url = validate_api_url(base)?;

    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AppError::Invalid("API 地址格式不正确，请检查服务地址。".to_string()))?;
        segments.pop_if_empty();
        for segment in path.split('/') {
            segments.push(segment);
        }
    }

    Ok(url.to_string())
}

/// 组装一条消息的 `content`。
///
/// 没有附件时返回**字符串** —— 和加附件能力之前完全一样。
/// 这样改动的面最小：绝大多数请求走的还是这条路径，原有测试也继续有意义。
///
/// 有附件时才变成数组（OpenAI 的多模态格式）：
///   - 文件本来就是文本，拼进同一个 text part 即可，任何模型都能收；
///   - 截图是图片，单独一个 `image_url` part，只有支持视觉的模型收得下。
///
/// ## 顺序：附件在前，用户的话在后
///
/// 长文件接在问题后面的话，模型读完问题还要再啃一大段内容才轮到回答；
/// 把附件放在前面、用户的话放在最后，模型最后读到的是那个问题。
/// 这是刻意的选择，不是随手拼的。
fn build_content(turn: &ChatTurn) -> serde_json::Value {
    use crate::models::ChatAttachment;

    if turn.attachments.is_empty() {
        return serde_json::Value::String(turn.content.clone());
    }

    let mut parts: Vec<serde_json::Value> = Vec::new();
    let mut text = String::new();

    for attachment in &turn.attachments {
        if let ChatAttachment::File {
            name,
            relative_path,
            content,
            truncated,
            ..
        } = attachment
        {
            text.push_str(&format!(
                "--- 附件：{name}（{relative_path}）---\n{content}\n"
            ));
            if *truncated {
                text.push_str("（以上只是这个文件的开头部分，内容较长已被截断）\n");
            }
            text.push('\n');
        }
    }

    if !turn.content.trim().is_empty() {
        if text.is_empty() {
            text = turn.content.clone();
        } else {
            text.push_str(&format!("--- 我的问题 ---\n{}", turn.content));
        }
    }

    // 空 text part 有些服务端不收，所以只有确实有文字时才放
    if !text.trim().is_empty() {
        parts.push(serde_json::json!({ "type": "text", "text": text }));
    }

    for attachment in &turn.attachments {
        if let ChatAttachment::Screenshot { data_url, .. } = attachment {
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": data_url },
            }));
        }
    }

    serde_json::Value::Array(parts)
}

/// 请求里有没有图片附件。
///
/// 用来在「模型没标记成支持图片」时拦住这次请求 —— 见 `stream_chat` 命令里的门禁。
pub fn contains_screenshot(request: &ChatRequest) -> bool {
    use crate::models::ChatAttachment;

    request
        .messages
        .iter()
        .any(|turn| turn.attachments.iter().any(ChatAttachment::is_screenshot))
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
            "content": build_content(turn),
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

#[derive(Default)]
struct SseDecoder {
    pending: Vec<u8>,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<SseLine> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();

        while let Some(position) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=position).collect();
            line.pop();
            lines.push(parse_sse_bytes(&line));
        }

        lines
    }

    fn finish(&mut self) -> Option<SseLine> {
        if self.pending.is_empty() {
            return None;
        }
        Some(parse_sse_bytes(&std::mem::take(&mut self.pending)))
    }
}

fn parse_sse_bytes(bytes: &[u8]) -> SseLine {
    let line = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    match std::str::from_utf8(line) {
        Ok(line) => parse_sse_line(line),
        Err(_) => SseLine::Ignore,
    }
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

async fn wait_for_cancel(cancel: Arc<AtomicBool>) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
    }
}

async fn race_with_cancel<F, T>(operation: F, cancel: Arc<AtomicBool>) -> Result<T, ()>
where
    F: Future<Output = T>,
{
    if cancel.load(Ordering::Relaxed) {
        return Err(());
    }

    match select(Box::pin(operation), Box::pin(wait_for_cancel(cancel))).await {
        Either::Left((value, _)) => Ok(value),
        Either::Right(((), _)) => Err(()),
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
        // API Key 不应跟随服务端重定向发往另一地址或被降级到 HTTP。
        .redirect(reqwest::redirect::Policy::none())
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
        return Err(AppError::from_http_status(status.as_u16(), &body, api_key));
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

    let send = build_client()?
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&payload)
        .send();

    let response = match race_with_cancel(send, cancel.clone()).await {
        Ok(response) => response.map_err(|error| AppError::from_reqwest(&error))?,
        Err(()) => {
            return Ok(StreamResult {
                outcome: "aborted".to_string(),
                text: String::new(),
            });
        }
    };

    if cancel.load(Ordering::Relaxed) {
        return Ok(StreamResult {
            outcome: "aborted".to_string(),
            text: String::new(),
        });
    }

    let status = response.status();
    if !status.is_success() {
        let body = match race_with_cancel(response.text(), cancel.clone()).await {
            Ok(body) => body.unwrap_or_default(),
            Err(()) => {
                return Ok(StreamResult {
                    outcome: "aborted".to_string(),
                    text: String::new(),
                });
            }
        };
        return Err(AppError::from_http_status(status.as_u16(), &body, api_key));
    }

    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
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

        // 先按字节找行边界，不能对每个网络 chunk 单独做 UTF-8 解码：
        // chunk 可能刚好切在一个汉字中间。
        for line in decoder.push(&next) {
            if apply_sse_line(line, &mut accumulated, on_event) {
                return Ok(StreamResult {
                    outcome: "complete".to_string(),
                    text: accumulated,
                });
            }
        }
    }

    // 最后一行 SSE 允许没有换行符，EOF 时也要处理它。
    if let Some(line) = decoder.finish()
        && apply_sse_line(line, &mut accumulated, on_event)
    {
        return Ok(StreamResult {
            outcome: "complete".to_string(),
            text: accumulated,
        });
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

fn apply_sse_line(
    line: SseLine,
    accumulated: &mut String,
    on_event: &Channel<StreamEvent>,
) -> bool {
    match line {
        SseLine::Delta(text) => {
            accumulated.push_str(&text);
            // 推累计全文：前端不需要自己维护拼接状态
            let _ = on_event.send(StreamEvent::Delta {
                text: accumulated.clone(),
            });
            false
        }
        SseLine::Done => true,
        SseLine::Ignore => false,
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChatAttachment;

    fn turn(role: &str, content: &str) -> ChatTurn {
        ChatTurn {
            role: role.into(),
            content: content.into(),
            attachments: Vec::new(),
        }
    }

    fn file_attachment(name: &str, content: &str) -> ChatAttachment {
        ChatAttachment::File {
            name: name.into(),
            relative_path: name.into(),
            content: content.into(),
            bytes: content.len() as u64,
            truncated: false,
        }
    }

    fn screenshot_attachment() -> ChatAttachment {
        ChatAttachment::Screenshot {
            name: "屏幕截图".into(),
            data_url: "data:image/png;base64,AAAA".into(),
            width: 2560,
            height: 1440,
            bytes: 1024,
        }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            model: "gpt-4o-mini".into(),
            system_prompt: "你是一个简洁的助手。".into(),
            messages: vec![
                turn("user", "你好"),
                turn("assistant", "你好，有什么可以帮你的？"),
                turn("user", "帮我看看这段代码"),
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
        assert_eq!(
            endpoint("https://api.example.com/v1?tenant=demo", "models").unwrap(),
            "https://api.example.com/v1/models?tenant=demo"
        );
    }

    #[test]
    fn endpoint_rejects_empty_and_relative_urls() {
        assert!(endpoint("", "models").is_err());
        assert!(endpoint("api.example.com/v1", "models").is_err());
        assert!(endpoint("ftp://api.example.com", "models").is_err());
    }

    #[test]
    fn endpoint_allows_http_only_for_local_model_services() {
        assert_eq!(
            endpoint("http://localhost:11434/v1", "models").unwrap(),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            endpoint("http://127.0.0.2:11434/v1", "models").unwrap(),
            "http://127.0.0.2:11434/v1/models"
        );
        assert!(endpoint("http://api.example.com/v1", "models").is_err());
    }

    #[test]
    fn endpoint_does_not_accept_credentials_embedded_in_the_url() {
        assert!(endpoint("https://user:password@api.example.com/v1", "models").is_err());
    }

    #[test]
    fn endpoint_rejects_credentials_in_query_or_fragment() {
        assert!(endpoint("https://api.example.com/v1?api_key=secret", "models").is_err());
        assert!(endpoint("https://api.example.com/v1?access-token=secret", "models").is_err());
        assert!(endpoint("https://api.example.com/v1?X-API-Key=secret", "models").is_err());
        assert!(endpoint("https://api.example.com/v1?client_secret=secret", "models").is_err());
        assert!(
            endpoint(
                "https://api.example.com/v1?X-Amz-Signature=secret",
                "models"
            )
            .is_err()
        );
        assert!(endpoint("https://api.example.com/v1#secret", "models").is_err());
    }

    #[test]
    fn endpoint_allows_non_sensitive_query_parameters() {
        assert_eq!(
            endpoint("https://api.example.com/v1?tenant=demo", "models").unwrap(),
            "https://api.example.com/v1/models?tenant=demo"
        );
    }

    #[test]
    fn endpoint_allows_ipv6_loopback_for_local_http_services() {
        assert_eq!(
            endpoint("http://[::1]:11434/v1", "models").unwrap(),
            "http://[::1]:11434/v1/models"
        );
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
    fn sse_decoder_preserves_utf8_split_across_network_chunks() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n";
        let bytes = line.as_bytes();
        let split = line.find("你").unwrap() + 1;
        let mut decoder = SseDecoder::default();

        assert!(decoder.push(&bytes[..split]).is_empty());
        assert_eq!(
            decoder.push(&bytes[split..]),
            vec![SseLine::Delta("你好".to_string())]
        );
    }

    #[test]
    fn sse_decoder_processes_a_final_line_without_a_newline() {
        let mut decoder = SseDecoder::default();
        let line = r#"data: {"choices":[{"delta":{"content":"最后一段"}}]}"#;
        assert_eq!(decoder.push(line.as_bytes()), Vec::<SseLine>::new());
        assert_eq!(
            decoder.finish(),
            Some(SseLine::Delta("最后一段".to_string()))
        );
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_pending_network_operation() {
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            signal.store(true, Ordering::Relaxed);
        });

        let result = race_with_cancel(std::future::pending::<()>(), cancel).await;
        assert_eq!(result, Err(()));
    }

    #[tokio::test]
    async fn cancellation_race_returns_a_completed_operation() {
        let result =
            race_with_cancel(std::future::ready(42), Arc::new(AtomicBool::new(false))).await;
        assert_eq!(result, Ok(42));
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
    fn turn_with(role: &str, content: &str, attachments: Vec<ChatAttachment>) -> ChatTurn {
        ChatTurn {
            role: role.into(),
            content: content.into(),
            attachments,
        }
    }

    #[test]
    fn a_turn_without_attachments_still_sends_a_plain_string() {
        // 这条是在保「改动面最小」：绝大多数请求没有附件，
        // 它们必须继续走和以前完全一样的格式，否则等于把所有请求都动了。
        let payload = build_payload(&request());
        let messages = payload["messages"].as_array().unwrap();

        assert_eq!(messages[1]["content"], "你好");
        assert!(
            messages[1]["content"].is_string(),
            "没有附件时 content 应当还是字符串"
        );
    }

    #[test]
    fn a_file_attachment_is_folded_into_the_text_part() {
        let mut request = request();
        request.messages = vec![turn_with(
            "user",
            "这个文件有什么问题",
            vec![file_attachment("笔记.md", "# 标题\n正文")],
        )];

        let payload = build_payload(&request);
        let content = &payload["messages"][1]["content"];

        assert!(content.is_array(), "带附件时 content 应当变成数组");
        let parts = content.as_array().unwrap();
        assert_eq!(parts.len(), 1, "文件是文本，不需要额外的 part");
        assert_eq!(parts[0]["type"], "text");

        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.contains("附件"), "要标出这是附件：{text}");
        assert!(text.contains("笔记.md"), "要带上文件名：{text}");
        assert!(text.contains("# 标题"), "要有文件内容：{text}");
        assert!(
            text.contains("这个文件有什么问题"),
            "用户的话不能被丢掉：{text}"
        );
    }

    #[test]
    fn the_users_question_comes_after_the_attachment() {
        let mut request = request();
        request.messages = vec![turn_with(
            "user",
            "这段话什么意思",
            vec![file_attachment("长文.txt", "很长的一段内容")],
        )];

        let payload = build_payload(&request);
        let text = payload["messages"][1]["content"][0]["text"]
            .as_str()
            .unwrap();

        // 长文接在问题后面的话，模型读完问题还要再啃一大段才轮到回答。
        // 把问题放最后，模型最后读到的才是它要回答的东西。
        let attachment_at = text.find("很长的一段内容").unwrap();
        let question_at = text.find("这段话什么意思").unwrap();
        assert!(attachment_at < question_at, "附件应当在问题之前：{text}");
    }

    #[test]
    fn a_screenshot_becomes_an_image_url_part() {
        let mut request = request();
        request.messages = vec![turn_with(
            "user",
            "这个报错什么意思",
            vec![screenshot_attachment()],
        )];

        let payload = build_payload(&request);
        let parts = payload["messages"][1]["content"].as_array().unwrap();

        assert_eq!(parts.len(), 2, "文字一段 + 图片一段");
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn files_and_screenshots_can_coexist() {
        let mut request = request();
        request.messages = vec![turn_with(
            "user",
            "帮我看看",
            vec![
                file_attachment("日志.txt", "错误信息"),
                screenshot_attachment(),
            ],
        )];

        let payload = build_payload(&request);
        let parts = payload["messages"][1]["content"].as_array().unwrap();

        assert_eq!(parts.len(), 2, "两个文件 part 会合并成一个 text part");
        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.contains("错误信息"), "文件内容在 text part 里：{text}");
        assert_eq!(parts[1]["type"], "image_url");
    }

    #[test]
    fn a_turn_with_only_an_attachment_has_no_empty_text_part() {
        // 空 text part 有些服务端不收，所以只发图的时候不该带一个空字符串段
        let mut request = request();
        request.messages = vec![turn_with("user", "", vec![screenshot_attachment()])];

        let payload = build_payload(&request);
        let parts = payload["messages"][1]["content"].as_array().unwrap();

        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image_url");
    }

    #[test]
    fn truncated_files_say_so() {
        // 截断过却不说，模型会把「开头」当成全文来回答
        let mut request = request();
        request.messages = vec![turn_with(
            "user",
            "看看",
            vec![ChatAttachment::File {
                name: "大日志.txt".into(),
                relative_path: "大日志.txt".into(),
                content: "开头".into(),
                bytes: 999_999,
                truncated: true,
            }],
        )];

        let payload = build_payload(&request);
        let text = payload["messages"][1]["content"][0]["text"]
            .as_str()
            .unwrap();

        assert!(text.contains("截断"), "要说明这是被截断的开头：{text}");
    }

    #[test]
    fn detects_screenshots_anywhere_in_the_request() {
        let mut clean = request();
        assert!(!contains_screenshot(&clean));

        clean
            .messages
            .push(turn_with("user", "", vec![screenshot_attachment()]));
        assert!(contains_screenshot(&clean));

        // 只有文件时不算 —— 文件是文本，不需要多模态
        let mut files_only = request();
        files_only.messages = vec![turn_with("user", "看", vec![file_attachment("a.txt", "x")])];
        assert!(!contains_screenshot(&files_only));
    }
}
