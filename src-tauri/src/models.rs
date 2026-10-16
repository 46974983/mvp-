//! 领域类型与领域规则
//!
//! 字段名对前端一律用 camelCase（`#[serde(rename_all = "camelCase")]`），
//! 对数据库一律用 snake_case。转换只在这一层发生，两边都不用迁就对方。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 领域规则（和前端 src/services/storage/browser-storage.ts 里的规则保持一致，
// 否则同一个操作在桌面模式和浏览器模式会得到不同结果）
// ---------------------------------------------------------------------------

/// 新会话的默认标题，也是「首条消息自动命名」的触发条件
pub const DEFAULT_CONVERSATION_TITLE: &str = "新会话";
/// 标题全是空白时的兜底
pub const UNNAMED_CONVERSATION_TITLE: &str = "未命名会话";
/// 自动命名时标题的最大字符数
const AUTO_TITLE_MAX_LENGTH: usize = 18;

pub const DEFAULT_ASSISTANT_NAME: &str = "小枢";
pub const DEFAULT_USER_NAME: &str = "老大";
pub const DEFAULT_SYSTEM_PROMPT: &str =
    "你是一个运行在本地桌面上的助手。回答先给结论，再补必要细节；不确定就直说不确定，不要编。";
pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_MODEL_NAME: &str = "gpt-4o-mini";

/// 「这个模型能看图吗」的默认值：**不能**。理由见 PersistedModelConfig 的字段说明 ——
/// 猜错方向的代价不对称。
pub const DEFAULT_SUPPORTS_VISION: bool = false;

/// 「关闭窗口时缩到托盘」的默认值。
///
/// 选 true 是产品判断，不是随手取的：这是个常驻型助手（阶段 C 之后还会有开机自启、
/// 全局快捷键），用户关掉窗口多半是想让它退到后台，而不是想让进程消失。
/// 代价是「关不掉的窗口」很容易被误解，所以界面上必须写清楚怎么真正退出，
/// 而且托盘必须在应用运行的整个期间都在。
pub const DEFAULT_CLOSE_TO_TRAY: bool = true;

/// 「回复生成完成时发系统通知」的默认值。
///
/// 同样选 true：这个开关的整个意义就是「你切走了，好了我叫你」。
/// 窗口在前台时不会打扰（见 notify.rs 的判定），所以开着不会带来噪音。
pub const DEFAULT_NOTIFY_ON_REPLY_COMPLETE: bool = true;

/// 全局快捷键的默认值：**空**
///
/// 这一项和前面两个默认开的设置不一样。全局快捷键抢的是**全系统唯一**的组合键，
/// 开着一个就等于从别的程序手里拿走一个键位。这种影响超出本应用范围的事，
/// 必须由用户主动选择，不能默认替他决定。
pub const DEFAULT_GLOBAL_SHORTCUT: &str = "";

/// 授权目录的默认值：**空**，也就是没有授权任何目录。
///
/// 阶段 D 的能力全都默认关闭。方案第 6 节的原话是
/// 「键鼠模拟和截屏增加明确的设置开关、失败提示和权限说明，默认关闭高风险自动化能力」，
/// 文件读取还额外要求「路径权限」—— 用户不显式授权，就一个字节也读不到。
pub const DEFAULT_FILE_DIRECTORY: &str = "";

/// 去掉首尾空白；全空白则回退到「未命名会话」
pub fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        UNNAMED_CONVERSATION_TITLE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 从首条用户消息推导会话标题：取首行、去空白、过长截断
pub fn derive_title_from_message(content: &str) -> String {
    let first_line = content.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return DEFAULT_CONVERSATION_TITLE.to_string();
    }
    let characters: Vec<char> = first_line.chars().collect();
    if characters.len() > AUTO_TITLE_MAX_LENGTH {
        let head: String = characters.iter().take(AUTO_TITLE_MAX_LENGTH).collect();
        format!("{head}…")
    } else {
        first_line.to_string()
    }
}

/// 设置项的键名。集中在这里，避免键名散落在 SQL 字符串里
pub mod setting_keys {
    pub const PERSONA_ASSISTANT_NAME: &str = "persona.assistant_name";
    pub const PERSONA_USER_NAME: &str = "persona.user_name";
    pub const PERSONA_SYSTEM_PROMPT: &str = "persona.system_prompt";
    pub const MODEL_API_URL: &str = "model.api_url";
    pub const MODEL_SUPPORTS_VISION: &str = "model.supports_vision";
    pub const MODEL_NAME: &str = "model.model_name";
    pub const WINDOW_CLOSE_TO_TRAY: &str = "window.close_to_tray";
    pub const NOTIFICATION_ON_REPLY_COMPLETE: &str = "notification.on_reply_complete";
    pub const SHORTCUT_TOGGLE_WINDOW: &str = "shortcut.toggle_window";
    pub const FILE_ACCESS_DIRECTORY: &str = "file_access.directory";
    pub const PERMISSION_SCREENSHOT: &str = "permission.screenshot";
}

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

/// 会话（conversations 表）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
}

/// 一条消息（messages 表）。
///
/// `role` 和 `status` 用字符串而不是枚举：合法取值由数据库的 CHECK 约束兜底，
/// 这样前端传进来一个没见过的值会被数据库拦住，而不是在反序列化时抛出一个
/// 用户看不懂的错。
/// 一条消息带的一个附件。
///
/// 两种形态差别很大，所以不是一个结构加个 `kind` 字段：
///   - `File` 是**文本**，拼进 prompt 的文本部分就够，任何模型都能用；
///   - `Screenshot` 是**图片**，走 OpenAI 的 `image_url` 多模态格式，
///     只有支持视觉的模型才收得下。
///
/// 做成枚举是为了让「哪些字段对哪种附件有意义」这件事由类型表达，
/// 而不是靠调用方记得「图片那个字段是空的」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatAttachment {
    /// 读到的本地文件内容
    #[serde(rename_all = "camelCase")]
    File {
        /// 展示用的文件名
        name: String,
        /// 相对授权目录的路径 —— 留个来路，方便用户对上「这是哪个文件」
        relative_path: String,
        content: String,
        bytes: u64,
        /// 是否因为超过上限被截断
        truncated: bool,
    },
    /// 一张截图。图片数据就在里面，不落盘也没有外部引用。
    #[serde(rename_all = "camelCase")]
    Screenshot {
        name: String,
        data_url: String,
        width: u32,
        height: u32,
        bytes: u64,
    },
}

impl ChatAttachment {
    /// 是不是图片附件。组装请求时要靠它决定走不走多模态格式。
    pub fn is_screenshot(&self) -> bool {
        matches!(self, ChatAttachment::Screenshot { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub status: String,
    pub created_at: i64,
    /// 这条消息带的附件。老消息读出来是空数组。
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaConfig {
    pub assistant_name: String,
    pub user_name: String,
    pub system_prompt: String,
}

/// 模型配置里**允许落到 SQLite** 的那部分。
/// 单独一个类型，是为了让「哪几个字段可以入库」在类型层面就写死 ——
/// api_key 没有入口。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedModelConfig {
    pub api_url: String,
    pub model_name: String,
    /// 这个模型收不收图片输入（多模态）。
    ///
    /// **默认 false。** 猜错方向的代价不对称：标成不支持、实际支持，
    /// 用户多点一下开关；标成支持、实际不支持，就会把一张图发给文本模型，
    /// 换来一个看不懂的 API 报错。所以默认选保守的那边。
    #[serde(default)]
    pub supports_vision: bool,
}

/// 窗口与托盘相关的偏好（非敏感，进 settings 表）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSettings {
    /// 关闭主窗口时缩到托盘，而不是退出应用
    pub close_to_tray: bool,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            close_to_tray: DEFAULT_CLOSE_TO_TRAY,
        }
    }
}

/// 通知相关的偏好（非敏感，进 settings 表）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// 回复生成完成时是否发系统通知
    pub on_reply_complete: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            on_reply_complete: DEFAULT_NOTIFY_ON_REPLY_COMPLETE,
        }
    }
}

/// 开机自启的当前状态。
///
/// `enabled` 永远来自**系统**（注册表 + 任务管理器里的开关），
/// 不是我们自己的记录 —— 见 autostart.rs 的说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    /// 系统里当前是否已启用
    pub enabled: bool,
    /// 开启后会写进注册表的路径。让「注册的是哪个文件」这件事对用户可见。
    pub exe_path: String,
}

/// 一次通知投递的结果。
///
/// 为什么不返回 `Result<(), Error>`：**「没发出去」不总是错误**。
/// 窗口在前台时跳过是正常行为，用户主动关掉通知也是正常行为。
/// 把它当成错误会让界面只能弹红色提示，而这里需要的是一句说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyOutcome {
    /// 通知是否真的发出去了
    pub delivered: bool,
    /// 给人看的一句话。delivered 为 false 时说明原因
    pub reason: String,
}

/// 全局快捷键偏好（非敏感，进 settings 表）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    /// 唤起 / 收起主窗口的全局快捷键。空串表示没设。
    pub toggle_window: String,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            toggle_window: DEFAULT_GLOBAL_SHORTCUT.to_string(),
        }
    }
}

/// 本地文件访问的授权范围（非敏感，进 settings 表）
///
/// 存的是**已经过校验的绝对路径**。授权范围只允许一个目录 ——
/// 多目录要配一套管理界面，而 MVP 的需求是「让我读某个文件夹里的东西」，
/// 一个根目录 + 相对路径已经能表达清楚，而且路径检查只有一个基准点，更不容易写错。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAccessSettings {
    /// 已授权的目录，空串表示没有授权
    pub directory: String,
}

impl Default for FileAccessSettings {
    fn default() -> Self {
        Self {
            directory: DEFAULT_FILE_DIRECTORY.to_string(),
        }
    }
}

/// 文件访问的当前状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAccessStatus {
    /// 已授权的目录，空串表示没授权
    pub directory: String,
    /// 这个目录现在还能不能打开。
    /// 授权之后目录可能被删掉或改名，那时候要如实显示为不可用，
    /// 而不是等到用户点开文件才报一个看不懂的错。
    pub available: bool,
}

/// 目录里的一项
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 相对授权目录的路径 —— 前端拿这个值来请求读取
    pub relative_path: String,
    pub name: String,
    pub is_directory: bool,
    /// 目录的 size 恒为 0（Windows 上目录大小本来也不是一个标量）
    pub size: u64,
}

/// 一个文件的内容
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub relative_path: String,
    pub content: String,
    /// 文件在磁盘上的真实大小（不是返回内容的长度）
    pub bytes: u64,
    /// 是否因为超过上限被截断
    pub truncated: bool,
}

/// 一次读取记录。**只存在内存里**，不落盘 —— 见 file_access.rs 的说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRead {
    pub relative_path: String,
    pub bytes: u64,
    /// 毫秒时间戳
    pub at: u64,
}

/// 全局快捷键的当前状态。
///
/// `accelerator` 是用户设置的值，`registered` 是**运行期的事实** ——
/// 两者可能不一致（比如那个键被别的程序占着，注册没成功），
/// 界面必须能同时看到这两件事，否则会显示一个看起来生效其实没生效的快捷键。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalShortcutStatus {
    pub accelerator: String,
    pub registered: bool,
}

/// 高风险能力的开关（非敏感，进 settings 表）
///
/// 这些能力默认**关闭**（技术方案第 6 节），而且判断在 Rust 侧 —— 见 permissions 模块。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSettings {
    /// 手动截屏。开启后可在设置页抓取并预览主屏画面。
    pub screenshot: bool,
}

impl Default for PermissionSettings {
    fn default() -> Self {
        Self {
            screenshot: crate::permissions::DEFAULT_HIGH_RISK_ENABLED,
        }
    }
}

/// 一次截屏的结果。
///
/// **图片只在内存里传递，不落盘** —— `data_url` 是给前端直接放进 `<img src>` 用的，
/// 用完之后没有任何文件残留。这也是「只返回临时引用」的含义：
/// 没有路径、没有临时文件，只有一个马上就会被丢掉的字符串。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    /// 编码后的字节数（不含 data URL 前缀）
    pub bytes: u64,
    /// 截的是哪块屏
    pub monitor: String,
    /// 系统里一共有几块屏 —— 界面上要如实说明**只截了主屏**
    pub monitor_count: usize,
    /// 毫秒时间戳
    pub captured_at: u64,
}

/// 全部可持久化的应用设置
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub persona: PersonaConfig,
    pub model: PersistedModelConfig,
    pub window: WindowSettings,
    pub notification: NotificationSettings,
    pub shortcut: ShortcutSettings,
    pub file_access: FileAccessSettings,
    pub permission: PermissionSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            persona: PersonaConfig {
                assistant_name: DEFAULT_ASSISTANT_NAME.to_string(),
                user_name: DEFAULT_USER_NAME.to_string(),
                system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            },
            model: PersistedModelConfig {
                api_url: DEFAULT_API_URL.to_string(),
                model_name: DEFAULT_MODEL_NAME.to_string(),
                supports_vision: DEFAULT_SUPPORTS_VISION,
            },
            window: WindowSettings::default(),
            notification: NotificationSettings::default(),
            shortcut: ShortcutSettings::default(),
            file_access: FileAccessSettings::default(),
            permission: PermissionSettings::default(),
        }
    }
}

/// 前端传来的完整模型配置（含 Key）。
/// 它只作为命令的参数出现，**不会**被写进数据库，也没有对应的表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model_name: String,
    /// 这个模型收不收图片输入。见 PersistedModelConfig 上的说明。
    #[serde(default)]
    pub supports_vision: bool,
}

impl ModelConfig {
    /// 取出可以入库的投影
    pub fn projection(&self) -> PersistedModelConfig {
        PersistedModelConfig {
            api_url: self.api_url.clone(),
            model_name: self.model_name.clone(),
            supports_vision: self.supports_vision,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessageInput {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub status: Option<String>,
    /// 附件。**内容跟着消息一起存**，理由见 0002_attachments.sql 的说明。
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePatch {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

/// 面向用户的操作结果：一句人话，不带堆栈、不带请求头
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub ok: bool,
    pub message: String,
}

/// 数据放在哪：设置页要如实告诉用户
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocation {
    /// 数据库文件的绝对路径
    pub database_path: String,
    /// 存储实现的说明
    pub driver: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_title_falls_back_when_blank() {
        assert_eq!(normalize_title("   "), UNNAMED_CONVERSATION_TITLE);
        assert_eq!(normalize_title("  讨论计划  "), "讨论计划");
    }

    #[test]
    fn derive_title_takes_first_line() {
        assert_eq!(derive_title_from_message("第一行\n第二行"), "第一行");
    }

    #[test]
    fn derive_title_falls_back_for_blank_content() {
        assert_eq!(
            derive_title_from_message("   \n  "),
            DEFAULT_CONVERSATION_TITLE
        );
    }

    #[test]
    fn derive_title_truncates_by_characters() {
        let long = "一".repeat(40);
        let title = derive_title_from_message(&long);
        assert_eq!(title.chars().count(), AUTO_TITLE_MAX_LENGTH + 1);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn model_config_projection_has_no_key() {
        let config = ModelConfig {
            api_url: "https://api.example.com/v1".into(),
            api_key: "sk-should-not-be-persisted".into(),
            model_name: "gpt-4o-mini".into(),
            supports_vision: true,
        };
        let json = serde_json::to_string(&config.projection()).unwrap();
        assert!(!json.contains("sk-should-not-be-persisted"));
        assert!(!json.to_lowercase().contains("apikey"));
    }

    #[test]
    fn default_settings_match_the_frontend_defaults() {
        let settings = AppSettings::default();
        assert_eq!(settings.persona.assistant_name, DEFAULT_ASSISTANT_NAME);
        assert_eq!(settings.model.api_url, DEFAULT_API_URL);
    }
}
