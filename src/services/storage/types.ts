/**
 * 存储层接口（Storage Service Contract）
 * ----------------------------------------------------------------------------
 * 为什么要有这一层：
 *   技术方案第 8 节把「阶段 B 替换存储实现」当成一件必然会发生的事 —— 浏览器阶段
 *   用 Web Storage，桌面阶段换成 Rust 侧的 SQLite。如果组件直接写 localStorage，
 *   到那天就要满仓库找。所以这里先用接口把「存什么、怎么取」钉死，
 *   换实现时只改 src/services/storage/ 里面的一个文件。
 *
 * 接口刻意做成 async：localStorage 本身是同步的，但阶段 B 的 Tauri invoke()
 * 是异步的。现在就把签名对齐，那天不用改调用方。
 *
 * 方法命名对齐 SQLite 的操作（SELECT / INSERT / UPDATE / DELETE），
 * 方便阶段 B 一一映射。
 */

import type {
  AppSettings,
  ChatAttachment,
  Conversation,
  CredentialStorageInfo,
  Message,
  MessageRole,
  MessageStatus,
  ModelConfig,
  OperationResult,
  StorageLocation,
} from '@/types';

/** 新建会话时的可选覆盖项 */
export interface CreateConversationInput {
  title?: string;
  createdAt?: number;
  archived?: boolean;
}

/** 追加消息时的入参（id / createdAt 由仓储生成，不给调用方留乱填的机会） */
export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  /** 附件内容跟着消息一起存，理由见 0002_attachments.sql */
  attachments?: ChatAttachment[];
}

/** 更新消息时的可改字段 */
export interface MessagePatch {
  content?: string;
  status?: MessageStatus;
}

/**
 * 会话与消息仓储。
 * conversations 和 messages 在数据上是两张表，但业务上永远一起用
 * （删会话要连带删消息、列表要按 updatedAt 排序），所以放在一个仓储里，
 * 由实现方保证两者的原子性。
 */
export interface ConversationRepository {
  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input?: CreateConversationInput): Promise<Conversation>;
  renameConversation(id: string, title: string): Promise<Conversation | null>;
  deleteConversation(id: string): Promise<void>;
  /** 会话被消息驱动后刷新 updatedAt（对应 SQL 的 UPDATE conversations SET updated_at） */
  touchConversation(id: string, at?: number): Promise<void>;

  listMessages(conversationId: string): Promise<Message[]>;
  appendMessage(input: AppendMessageInput): Promise<Message>;
  updateMessage(id: string, patch: MessagePatch): Promise<Message | null>;
}

/** 设置仓储：只存非敏感项。apiKey 不在这里，也不在任何持久化位置。 */
export interface SettingsRepository {
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;

  /**
   * 保存完整的模型配置。
   *
   * 这是「一个对象进来、两条路出去」的地方：地址和模型名进设置，
   * API Key 交给**当前运行环境**的凭据存储 ——
   * 浏览器阶段是「只留内存」，桌面阶段是系统凭据管理器。
   * 把这件事收在一个方法里，调用方就不需要知道自己在哪个环境。
   */
  saveModelConfig(config: ModelConfig): Promise<void>;

  /** 本机是否已经保存过 API Key。浏览器阶段恒为 false。 */
  hasStoredApiKey(): Promise<boolean>;

  /** 清掉已保存的 API Key（浏览器阶段是空操作） */
  clearStoredApiKey(): Promise<void>;
}

/** 存储实现的总入口 */
export interface StorageService {
  /** 实现名，用于设置页向用户说明「数据到底存在哪」 */
  readonly driverName: string;
  /** 凭据存在哪：设置页的文案直接用它，不靠猜当前是什么阶段 */
  readonly credentialStorage: CredentialStorageInfo;
  /** 一段说明性的位置描述（不含具体路径） */
  describeLocation(): string;
  /** 具体路径。Tauri 侧要问 Rust 才知道，所以是异步的。 */
  resolveLocation(): Promise<StorageLocation>;
  /**
   * 凭据存储当前是否可用。
   * 「不可用」是一种正常状态（受限环境里可能就没有凭据管理器），
   * 所以它返回 ok=false 而不是抛异常 —— 界面需要把它当信息展示。
   */
  probeCredentialStorage(): Promise<OperationResult>;
  readonly conversations: ConversationRepository;
  readonly settings: SettingsRepository;
  /** 清空本实现管理的全部数据（含凭据） */
  reset(): Promise<void>;
}
