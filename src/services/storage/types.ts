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
  Conversation,
  Message,
  MessageRole,
  MessageStatus,
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
}

/** 存储实现的总入口 */
export interface StorageService {
  /** 实现名，用于设置页向用户说明「数据到底存在哪」 */
  readonly driverName: string;
  /** 数据目录 / 存储位置的说明文案 */
  describeLocation(): string;
  readonly conversations: ConversationRepository;
  readonly settings: SettingsRepository;
  /** 清空本实现管理的全部数据 */
  reset(): Promise<void>;
}
