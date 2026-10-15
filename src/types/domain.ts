/**
 * 领域类型（Domain Types）
 * ----------------------------------------------------------------------------
 * 这一层只描述「业务上有什么东西」，不关心它存在哪里、怎么渲染。
 * 界面、仓储、模型适配器三边都 import 这里，保证大家对同一个概念的理解一致。
 *
 * 对应《docs/TECHNICAL_PLAN.md》第 5 节的三张表：
 *   Conversation -> conversations 表
 *   Message      -> messages 表
 *   AppSettings  -> settings 表
 */

/** 参与对话的角色。系统提示词不是「消息」，它在请求组装阶段单独注入。 */
export type MessageRole = 'user' | 'assistant';

/**
 * 一条消息的生命周期状态。
 * streaming：正在逐字写入；aborted：用户中途点了停止；error：模型调用失败。
 * 为什么要存这个：重启后要能看出某条回复是「说完了」还是「被打断了」。
 */
export type MessageStatus = 'streaming' | 'complete' | 'aborted' | 'error';

/** 会话（对应 conversations 表） */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 归档状态。MVP 不做归档 UI，先按技术方案把字段留着，避免以后迁移表结构。 */
  archived: boolean;
}

/** 一条消息（对应 messages 表） */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
}

/** 模型连接配置。注意：apiKey 永远不落盘，只活在内存里（见 5. 数据与安全）。 */
export interface ModelConfig {
  apiUrl: string;
  apiKey: string;
  modelName: string;
}

/** 人格配置（属于 settings 表，非敏感，可以持久化） */
export interface PersonaConfig {
  assistantName: string;
  userName: string;
  systemPrompt: string;
}

/**
 * 模型配置里**可以落盘**的那部分。
 * 单独定义成一个类型，是为了让「哪几个字段允许被持久化」变成一件编译期就能查的事：
 * AppSettings 里放的是它，而不是 ModelConfig，于是 apiKey 结构上就没有入口。
 */
export interface PersistedModelConfig {
  apiUrl: string;
  modelName: string;
}

/**
 * 窗口与托盘相关的偏好（非敏感，进 settings 表）
 *
 * 浏览器模式里这条设置没有意义（没有托盘可缩），但仍然存在 ——
 * 让设置结构在两种环境下保持一致，比让它随环境变形要省事得多。
 */
export interface WindowSettings {
  /**
   * 关闭主窗口时缩到系统托盘，而不是退出应用。
   *
   * 默认 true 是产品判断：这是个常驻型助手，用户关掉窗口多半是想让它退到后台。
   * 代价是「窗口关不掉」很容易被误解，所以界面上必须写清怎么真正退出。
   */
  closeToTray: boolean;
}

/**
 * 通知偏好（非敏感，进 settings 表）
 *
 * 和窗口偏好一样，两种运行模式下都存在这个设置 —— 结构不随环境变形，
 * 至于「实际上能不能发出去」由平台能力决定（浏览器要授权，桌面端不需要）。
 */
export interface NotificationSettings {
  /**
   * 回复生成完成时是否发系统通知。
   *
   * 默认 true：这个开关的整个意义就是「你切走了，好了我叫你」。
   * 窗口在前台时不会打扰，所以开着不会带来噪音。
   */
  onReplyComplete: boolean;
}

/**
 * 全局快捷键偏好（非敏感，进 settings 表）
 */
export interface ShortcutSettings {
  /**
   * 唤起 / 收起主窗口的全局快捷键。空串表示没设。
   *
   * 默认**不设**，这一点和窗口、通知两项相反：全局快捷键抢的是**全系统唯一**的组合键，
   * 开着一个就等于从别的程序手里拿走一个键位。影响超出本应用范围的事，
   * 必须由用户主动选择。
   */
  toggleWindow: string;
}

/**
 * 本地文件访问的授权范围（非敏感，进 settings 表）
 *
 * 存的是**已经过校验的绝对路径**。只允许一个目录：MVP 的需求是
 * 「让我读某个文件夹里的东西」，一个根目录 + 相对路径已经能表达清楚，
 * 而且路径检查只有一个基准点，更不容易写错。
 */
export interface FileAccessSettings {
  /** 已授权的目录，空串表示没有授权 —— 那时一个字节也读不到 */
  directory: string;
}

/** 全部可持久化的应用设置 */
export interface AppSettings {
  persona: PersonaConfig;
  /** 模型配置的非敏感投影（地址与模型名）。产品设计 3.2 要求「保存本地配置」。 */
  model: PersistedModelConfig;
  /** 窗口与托盘偏好 */
  window: WindowSettings;
  /** 通知偏好 */
  notification: NotificationSettings;
  /** 全局快捷键偏好 */
  shortcut: ShortcutSettings;
  /** 本地文件访问的授权范围 */
  fileAccess: FileAccessSettings;
}

/** 主题模式 */
export type ThemeMode = 'light' | 'dark';

/**
 * 凭据（API Key）到底存在哪。
 *
 * 这不是实现细节，而是**必须如实告诉用户**的事：
 * 浏览器阶段它只活在内存里，刷新即失效；桌面阶段它进系统凭据管理器。
 * 把这件事做成一个类型，界面就不会靠「当前是哪个阶段」这种猜测来写文案。
 */
export interface CredentialStorageInfo {
  kind: 'memory' | 'os-keychain';
  /** 短标签，例如「Windows 凭据管理器」 */
  label: string;
  /** 一段完整说明，直接显示在设置页 */
  description: string;
}

/** 数据存放位置：设置页要如实展示的东西 */
export interface StorageLocation {
  /** 具体路径。浏览器阶段是一句说明而不是路径，所以不叫 path 的字段语义要写清 */
  path: string;
  /** 存储实现的名字 */
  driver: string;
}

/** 组装给模型的一轮对话 */
export interface ChatTurn {
  role: MessageRole;
  content: string;
}

/**
 * 模型请求。
 * systemPrompt 和 messages 分开两个字段，是刻意的：
 * 技术方案要求「系统提示词和用户消息在请求组装阶段明确区分」，
 * 不给它们混进同一个数组的机会。
 */
export interface ChatRequest {
  model: string;
  systemPrompt: string;
  messages: ChatTurn[];
}

/** 面向用户的统一操作结果：只带一句人话，不带堆栈、不带请求头。 */
export interface OperationResult {
  ok: boolean;
  message: string;
}

/** 流式调用的收尾状态 */
export type StreamOutcome = 'complete' | 'aborted';

export interface StreamResult {
  outcome: StreamOutcome;
  /** 本次累计产出的完整文本（中途停止时是已生成的部分） */
  text: string;
}
