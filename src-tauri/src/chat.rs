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
    /// 助手这一轮发起的工具调用。有它时 role 必须是 assistant。
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// 这是一条「工具结果」，回答的是哪一次调用。
    /// 有它时 role 必须是 tool，而且 `tool_call_id` 必须对上前面 assistant 的 id。
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

/// 模型发起的一次工具调用。
///
/// `arguments` **保持成一段原始 JSON 文本**，不在这里解析成结构 ——
/// 我们不猜模型会传什么形状的参数。真正要紧的东西（比如读取路径）
/// 由 Rust 侧的命令独立校验，不依赖这段文本的可信度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// 提供给模型的工具定义。
///
/// **只提供调用方点名要的那几个**：能力没开（比如截屏关着）时，
/// 前端不会把对应的工具名传上来，模型也就不知道有这么个东西存在 ——
/// 这比「先给它、执行时再拒」对用户更友好。
pub fn tool_definitions(names: &[String]) -> serde_json::Value {
    let mut tools = Vec::new();

    for name in names {
        let definition = match name.as_str() {
            "read_file" => serde_json::json!({
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "读取用户已授权目录里的一个文件。\
                                    每次读取都会先请用户确认。只能读相对路径，不能超出授权目录。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "相对授权目录的路径，例如 notes/todo.md"
                            }
                        },
                        "required": ["path"]
                    }
                }
            }),
            "take_screenshot" => serde_json::json!({
                "type": "function",
                "function": {
                    "name": "take_screenshot",
                    "description": "抓取用户的主屏画面。每次抓取都会先请用户确认。\
                                    返回的文字里只有尺寸信息，图片会作为一条消息附在后面。",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            }),
            // 不认识的名字直接跳过：多传了不该传的，不该让它变成可用的工具
            _ => continue,
        };
        tools.push(definition);
    }

    serde_json::Value::Array(tools)
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
    /// 这次请求允许模型使用哪些工具。
    ///
    /// 空数组表示不开工具调用 —— 请求体和加工具之前完全一样。
    /// 前端按「哪些能力真的开着」来决定传什么，所以能力关着时
    /// 模型连这个工具存在都不知道。
    #[serde(default)]
    pub tools: Vec<String>,
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
    /// 这一轮模型发起的工具调用。空表示它没要求什么。
    ///
    /// 注意：**有工具调用不代表 text 一定有内容** ——
    /// 模型可以只发调用不说话，那种情况下 text 是空串。
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
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
        messages.push(build_turn(turn));
    }

    let mut payload = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
    });

    // 只在调用方点名要了工具时才带 tools —— 不带的话，请求体和加工具之前完全一样
    let tools = tool_definitions(&request.tools);
    if let Some(array) = tools.as_array()
        && !array.is_empty()
    {
        payload["tools"] = tools;
    }

    payload
}

/// 组装一条消息。
///
/// 三种形态，优先级从高到低：
///   1. 助手发起的工具调用 → `{role:"assistant", content, tool_calls}`
///   2. 工具结果 → `{role:"tool", tool_call_id, content}`
///   3. 普通消息 → 走 `build_content`（没有附件时是字符串，有附件时是数组）
///
/// 第 1、2 种必须成对出现且 id 对得上 —— 这是协议的要求，
/// 对不上的话服务端会直接拒绝整次请求。
fn build_turn(turn: &ChatTurn) -> serde_json::Value {
    if !turn.tool_calls.is_empty() {
        let calls: Vec<serde_json::Value> = turn
            .tool_calls
            .iter()
            .map(|call| {
                serde_json::json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments },
                })
            })
            .collect();

        return serde_json::json!({
            "role": "assistant",
            // 只发调用不说话时 content 用 null：有些服务端不接受空字符串
            "content": if turn.content.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(turn.content.clone())
            },
            "tool_calls": calls,
        });
    }

    if let Some(tool_call_id) = &turn.tool_call_id {
        // 工具结果只能是文本：图片走不通这条路（见 README 里关于截图的说明）
        return serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": turn.content,
        });
    }

    serde_json::json!({
        "role": turn.role,
        "content": build_content(turn),
    })
}

/// 一行 SSE 解析出来的结果
#[derive(Debug, PartialEq, Eq)]
pub enum SseLine {
    /// 拿到了一个内容片段
    Delta(String),
    /// 一次工具调用的一个片段
    ToolCall(ToolCallDelta),
    /// 服务端说「说完了」
    Done,
}

/// 工具调用的一个片段。
///
/// 协议把一次调用拆得很碎：第一片带 `id` 和 `name`，之后每一片只带
/// 一小段 `arguments` 的字符串。所以要按下标攒起来，最后才是一段完整 JSON。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallDelta {
    /// 同一次响应里第几个调用。多个调用会并行流式返回，靠它区分。
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// 把碎片攒成完整的工具调用。
///
/// 单独拎出来是因为它是有状态、有顺序的：片可能乱序到、可能重复带 name，
/// 而且**一个 chunk 里可能同时有 content 和 tool_calls** —— 这些都得测。
#[derive(Default)]
pub struct ToolCallAccumulator {
    calls: Vec<PartialToolCall>,
}

#[derive(Clone)]
struct PartialToolCall {
    index: usize,
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAccumulator {
    pub fn push(&mut self, delta: &ToolCallDelta) {
        if let Some(slot) = self.calls.iter_mut().find(|call| call.index == delta.index) {
            if let Some(id) = &delta.id {
                slot.id = id.clone();
            }
            if let Some(name) = &delta.name {
                slot.name = name.clone();
            }
            if let Some(arguments) = &delta.arguments {
                slot.arguments.push_str(arguments);
            }
            return;
        }

        self.calls.push(PartialToolCall {
            index: delta.index,
            id: delta.id.clone().unwrap_or_default(),
            name: delta.name.clone().unwrap_or_default(),
            arguments: delta.arguments.clone().unwrap_or_default(),
        });
    }

    /// 收尾成一串完整调用。
    ///
    /// 丢掉 name 为空的：有些服务端会在末尾补一个纯占位的空调用。
    /// id 缺失时补一个确定的占位 —— 不然前端拿不到能对应回去的 id。
    pub fn finish(&self) -> Vec<ToolCall> {
        let mut calls = self.calls.clone();
        calls.sort_by_key(|call| call.index);

        calls
            .into_iter()
            .filter(|call| !call.name.is_empty())
            .map(|call| ToolCall {
                id: if call.id.is_empty() {
                    format!("call_{}", call.index)
                } else {
                    call.id
                },
                name: call.name,
                arguments: call.arguments,
            })
            .collect()
    }
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
            lines.extend(parse_sse_bytes(&line));
        }

        lines
    }

    fn finish(&mut self) -> Vec<SseLine> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        parse_sse_bytes(&std::mem::take(&mut self.pending))
    }
}

fn parse_sse_bytes(bytes: &[u8]) -> Vec<SseLine> {
    let line = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    match std::str::from_utf8(line) {
        Ok(line) => parse_sse_line(line),
        Err(_) => Vec::new(),
    }
}

/// 解析一行 SSE。
///
/// OpenAI 兼容接口的流式格式是每行 `data: {json}`，最后一行 `data: [DONE]`。
/// 解析失败的 JSON 一律当作无关行忽略 —— 流式解析不能因为一行看不懂就整段垮掉。
pub fn parse_sse_line(line: &str) -> Vec<SseLine> {
    let line = line.trim();
    let Some(payload) = line.strip_prefix("data:") else {
        return Vec::new();
    };
    let payload = payload.trim();

    if payload.is_empty() {
        return Vec::new();
    }
    if payload == "[DONE]" {
        return vec![SseLine::Done];
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Vec::new();
    };

    // 返回一个列表而不是单个值：一个 chunk 里**可能同时有 content 和 tool_calls**。
    // 只取其中一种的话，另一种会被静默丢掉。
    let mut lines = Vec::new();

    if let Some(text) = extract_delta(&value) {
        lines.push(SseLine::Delta(text));
    }
    lines.extend(extract_tool_call_deltas(&value));

    lines
}

/// 取出这一段里的工具调用碎片。
fn extract_tool_call_deltas(value: &serde_json::Value) -> Vec<SseLine> {
    let calls = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("tool_calls"))
        .and_then(|calls| calls.as_array());

    let Some(calls) = calls else {
        return Vec::new();
    };

    calls
        .iter()
        .enumerate()
        .map(|(position, call)| {
            let function = call.get("function");
            SseLine::ToolCall(ToolCallDelta {
                // 有些服务端不发 index，那种情况用它在数组里的位置
                index: call
                    .get("index")
                    .and_then(|value| value.as_u64())
                    .map(|value| value as usize)
                    .unwrap_or(position),
                id: call
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                name: function
                    .and_then(|function| function.get("name"))
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                arguments: function
                    .and_then(|function| function.get("arguments"))
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
        })
        .collect()
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
                tool_calls: Vec::new(),
            });
        }
    };

    if cancel.load(Ordering::Relaxed) {
        return Ok(StreamResult {
            outcome: "aborted".to_string(),
            text: String::new(),
            tool_calls: Vec::new(),
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
                    tool_calls: Vec::new(),
                });
            }
        };
        return Err(AppError::from_http_status(status.as_u16(), &body, api_key));
    }

    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut accumulated = String::new();
    let mut tool_calls = ToolCallAccumulator::default();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(StreamResult {
                outcome: "aborted".to_string(),
                text: accumulated,
                tool_calls: tool_calls.finish(),
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
            if apply_sse_line(line, &mut accumulated, &mut tool_calls, on_event) {
                return Ok(StreamResult {
                    outcome: "complete".to_string(),
                    text: accumulated,
                    tool_calls: tool_calls.finish(),
                });
            }
        }
    }

    // 最后一行 SSE 允许没有换行符，EOF 时也要处理它。
    for line in decoder.finish() {
        if apply_sse_line(line, &mut accumulated, &mut tool_calls, on_event) {
            return Ok(StreamResult {
                outcome: "complete".to_string(),
                text: accumulated,
                tool_calls: tool_calls.finish(),
            });
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
        tool_calls: tool_calls.finish(),
    })
}

fn apply_sse_line(
    line: SseLine,
    accumulated: &mut String,
    tool_calls: &mut ToolCallAccumulator,
    on_event: &Channel<StreamEvent>,
) -> bool {
    match line {
        SseLine::ToolCall(delta) => {
            // 工具调用**不推给前端**：它要等整段参数收完才有意义，
            // 半截 JSON 推上去只会让界面显示一堆乱码。整段在收尾时一起返回。
            tool_calls.push(&delta);
            false
        }
        SseLine::Delta(text) => {
            accumulated.push_str(&text);
            // 推累计全文：前端不需要自己维护拼接状态
            let _ = on_event.send(StreamEvent::Delta {
                text: accumulated.clone(),
            });
            false
        }
        SseLine::Done => true,
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
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }

    fn tool_call(id: &str, name: &str, arguments: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
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
            tools: Vec::new(),
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
        assert_eq!(
            parse_sse_line(line),
            vec![SseLine::Delta("你好".to_string())]
        );
    }

    #[test]
    fn parses_done_marker() {
        assert_eq!(parse_sse_line("data: [DONE]"), vec![SseLine::Done]);
    }

    #[test]
    fn ignores_comments_and_other_events() {
        // 与本应用无关的行产出空列表 —— 以前是一个 Ignore 变体，
        // 现在改成空列表：更少的枚举变体意味着调用方少一处要处理的分支
        assert!(parse_sse_line(": ping").is_empty());
        assert!(parse_sse_line("event: message").is_empty());
        assert!(parse_sse_line("").is_empty());
        assert!(parse_sse_line("data: ").is_empty());
    }

    #[test]
    fn ignores_unparseable_and_contentless_chunks() {
        assert!(parse_sse_line("data: {not json}").is_empty());
        // 只有 role 的第一条 chunk，没有内容，不该产生空增量
        let line = r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert!(parse_sse_line(line).is_empty());
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
            vec![SseLine::Delta("最后一段".to_string())]
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
            tool_calls: Vec::new(),
            tool_call_id: None,
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

    // ---- 工具调用：流式碎片 ----

    #[test]
    fn assembles_a_tool_call_from_fragments() {
        // 协议把一次调用拆得很碎：第一片带 id 和 name，之后每一片只带
        // 一小段 arguments 的字符串。攒错一个字符，参数就是坏 JSON。
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(&ToolCallDelta {
            index: 0,
            id: Some("call_abc".into()),
            name: Some("read_file".into()),
            arguments: Some(String::new()),
        });
        accumulator.push(&ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments: Some("{\"path\":".into()),
        });
        accumulator.push(&ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments: Some("\"notes.md\"}".into()),
        });

        let calls = accumulator.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_abc");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, r#"{"path":"notes.md"}"#);
    }

    #[test]
    fn assembles_two_calls_in_parallel() {
        // 模型可以在一次响应里要求好几样东西，它们的碎片会交错到达
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(&ToolCallDelta {
            index: 0,
            id: Some("a".into()),
            name: Some("read_file".into()),
            arguments: Some("{\"path\":".into()),
        });
        accumulator.push(&ToolCallDelta {
            index: 1,
            id: Some("b".into()),
            name: Some("take_screenshot".into()),
            arguments: Some("{}".into()),
        });
        accumulator.push(&ToolCallDelta {
            index: 0,
            id: None,
            name: None,
            arguments: Some("\"a.txt\"}".into()),
        });

        let calls = accumulator.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(calls[1].name, "take_screenshot");
    }

    #[test]
    fn a_chunk_can_carry_both_content_and_tool_calls() {
        // 只取其中一种的话，另一种会被静默丢掉 —— 这正是最难察觉的那类 bug
        let line = concat!(
            r#"data: {"choices":[{"delta":{"content":"我看看","tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}]}}]}"#
        );

        let lines = parse_sse_line(line);
        assert!(
            lines
                .iter()
                .any(|line| matches!(line, SseLine::Delta(text) if text == "我看看"))
        );
        assert!(
            lines
                .iter()
                .any(|line| matches!(line, SseLine::ToolCall(_)))
        );
    }

    #[test]
    fn a_missing_index_falls_back_to_the_array_position() {
        // 有些服务端不发 index。用位置兜底，否则两个调用会黏成一个
        let line = r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"x","function":{"name":"take_screenshot","arguments":"{}"}}]}}]}"#;
        let delta = parse_sse_line(line)
            .into_iter()
            .find_map(|line| match line {
                SseLine::ToolCall(delta) => Some(delta),
                _ => None,
            })
            .expect("应当解析出一个工具调用碎片");

        assert_eq!(delta.index, 0);
        assert_eq!(delta.name.as_deref(), Some("take_screenshot"));
    }

    #[test]
    fn a_placeholder_call_without_a_name_is_dropped() {
        // 有些服务端会在末尾补一个只有 index 的空调用。
        // 留着它的话，前端会拿到一个不知道要执行什么的条目。
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(&ToolCallDelta {
            index: 0,
            id: Some("real".into()),
            name: Some("read_file".into()),
            arguments: Some("{}".into()),
        });
        accumulator.push(&ToolCallDelta {
            index: 1,
            id: None,
            name: None,
            arguments: None,
        });

        assert_eq!(accumulator.finish().len(), 1);
    }

    #[test]
    fn a_call_without_an_id_gets_a_stable_placeholder() {
        // 没有 id 就没法把工具结果对回去，服务端会拒绝整次请求
        let mut accumulator = ToolCallAccumulator::default();
        accumulator.push(&ToolCallDelta {
            index: 3,
            id: None,
            name: Some("read_file".into()),
            arguments: Some("{}".into()),
        });

        let calls = accumulator.finish();
        assert_eq!(calls[0].id, "call_3");
    }

    // ---- 工具调用：请求组装 ----

    #[test]
    fn no_tools_means_no_tools_field_at_all() {
        // 不开工具调用时，请求体必须和加这个功能之前完全一样
        let payload = build_payload(&request());
        assert!(
            payload.get("tools").is_none(),
            "没有点名要工具时不该带 tools"
        );
    }

    #[test]
    fn only_the_requested_tools_are_offered() {
        // 能力没开时前端不会传那个名字，模型连它存在都不知道 ——
        // 这比「先给它、执行时再拒」对用户更友好
        let mut request = request();
        request.tools = vec!["read_file".into()];

        let payload = build_payload(&request);
        let tools = payload["tools"].as_array().unwrap();

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "read_file");
        assert_eq!(tools[0]["type"], "function");
        assert!(
            tools[0]["function"]["parameters"]["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "path"),
            "read_file 必须要求一个 path 参数"
        );
    }

    #[test]
    fn unknown_tool_names_are_ignored() {
        // 传了不该传的，不该让它变成可用的工具
        let mut request = request();
        request.tools = vec!["read_file".into(), "run_shell".into(), "send_email".into()];

        let tools = build_payload(&request)["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "read_file");
    }

    #[test]
    fn all_unknown_tools_means_no_tools_field() {
        let mut request = request();
        request.tools = vec!["run_shell".into()];
        assert!(build_payload(&request).get("tools").is_none());
    }

    #[test]
    fn a_tool_call_turn_becomes_an_assistant_message_with_calls() {
        let mut request = request();
        request.messages.push(ChatTurn {
            role: "assistant".into(),
            content: String::new(),
            attachments: Vec::new(),
            tool_calls: vec![tool_call("call_1", "read_file", r#"{"path":"a.txt"}"#)],
            tool_call_id: None,
        });

        let payload = build_payload(&request);
        let messages = payload["messages"].as_array().unwrap();
        let last = messages.last().unwrap();

        assert_eq!(last["role"], "assistant");
        assert!(
            last["content"].is_null(),
            "只发调用不说话时 content 应当是 null"
        );
        assert_eq!(last["tool_calls"][0]["id"], "call_1");
        assert_eq!(last["tool_calls"][0]["type"], "function");
        assert_eq!(last["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(
            last["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"a.txt"}"#
        );
    }

    #[test]
    fn a_tool_result_turn_becomes_a_tool_message() {
        let mut request = request();
        request.messages.push(ChatTurn {
            role: "tool".into(),
            content: "文件内容".into(),
            attachments: Vec::new(),
            tool_calls: Vec::new(),
            tool_call_id: Some("call_1".into()),
        });

        let payload = build_payload(&request);
        let last = payload["messages"].as_array().unwrap().last().unwrap();

        assert_eq!(last["role"], "tool");
        assert_eq!(last["tool_call_id"], "call_1");
        assert_eq!(last["content"], "文件内容");
    }
}
