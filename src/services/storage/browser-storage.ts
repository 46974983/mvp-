/**
 * 浏览器存储实现（阶段 A 的默认实现）
 * ----------------------------------------------------------------------------
 * 为什么用 Web Storage 而不是在浏览器里塞一个 SQLite：
 *   技术方案第 8 节把「真 SQLite」放在阶段 B（Rust 侧）。在浏览器里编译一份
 *   SQLite WASM 只会增加体积和一套独立的迁移脚本，却换不来任何阶段 A 需要的
 *   能力。所以这里用一个符合 StorageService 接口的轻量实现顶着，
 *   内部结构直接照着 SQLite 的三张表摆，阶段 B 可以一一对照着搬。
 *
 * 明确不做的事：
 *   - 不存储 apiKey（ModelConfig 从不进入这个文件，见 5. 数据与安全）。这里没有
 *     任何「顺手把整份 state 存下来」的写法，就是为了不给敏感字段留后门。
 *   - 不存储 systemPrompt 之外的模型配置。
 *
 * 数据结构（和 SQLite 表一一对应）：
 *   snapshot.conversations  ->  conversations 表
 *   snapshot.messages       ->  messages 表
 *   snapshot.settings       ->  settings 表
 */

import type { AppSettings, Conversation, Message, StorageLocation } from '@/types';
import { createId } from '@/lib/id';
import type {
  AppendMessageInput,
  ConversationRepository,
  CreateConversationInput,
  MessagePatch,
  SettingsRepository,
  StorageService,
} from './types';

/** 存储键。带 schema 版本号，将来表结构变了可以识别出旧数据。 */
const STORAGE_KEY = 'desktop-ai-assistant:mvp';
const SCHEMA_VERSION = 1;

/** 新会话的默认标题，也是「首条消息自动命名」的触发条件 */
export const DEFAULT_CONVERSATION_TITLE = '新会话';

/** 自动命名时标题的最大长度 */
const AUTO_TITLE_MAX_LENGTH = 18;

export const DEFAULT_PERSONA = {
  assistantName: '小枢',
  userName: '老大',
  systemPrompt:
    '你是一个运行在本地桌面上的助手。回答先给结论，再补必要细节；不确定就直说不确定，不要编。',
} as const;

/**
 * 模型配置里默认的非敏感部分。
 * 注意这里是「地址 + 模型名」，不含 Key —— 默认值这一层就不给 Key 留位置。
 */
export const DEFAULT_MODEL_ENDPOINT = {
  apiUrl: 'https://api.openai.com/v1',
  modelName: 'gpt-4o-mini',
} as const;

/** 「关闭窗口时缩到托盘」的默认值。与 Rust 侧 DEFAULT_CLOSE_TO_TRAY 保持一致。 */
export const DEFAULT_CLOSE_TO_TRAY = true;

/** 「回复完成时发通知」的默认值。与 Rust 侧 DEFAULT_NOTIFY_ON_REPLY_COMPLETE 保持一致。 */
export const DEFAULT_NOTIFY_ON_REPLY_COMPLETE = true;

/**
 * 全局快捷键的默认值：**空**。
 * 与 Rust 侧 DEFAULT_GLOBAL_SHORTCUT 保持一致 —— 抢系统唯一键位的事不默认开。
 */
export const DEFAULT_GLOBAL_SHORTCUT = '';

export function defaultSettings(): AppSettings {
  return {
    persona: { ...DEFAULT_PERSONA },
    model: { ...DEFAULT_MODEL_ENDPOINT },
    window: { closeToTray: DEFAULT_CLOSE_TO_TRAY },
    notification: { onReplyComplete: DEFAULT_NOTIFY_ON_REPLY_COMPLETE },
    shortcut: { toggleWindow: DEFAULT_GLOBAL_SHORTCUT },
  };
}

interface StorageSnapshot {
  version: number;
  conversations: Conversation[];
  messages: Message[];
  settings: AppSettings;
}

function emptySnapshot(): StorageSnapshot {
  return {
    version: SCHEMA_VERSION,
    conversations: [],
    messages: [],
    settings: defaultSettings(),
  };
}

/** 只依赖用到的那几个方法，方便测试注入假实现 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 读取时做的形状校验：手改坏了就退回空数据，不让应用白屏 */
function isSnapshot(value: unknown): value is StorageSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StorageSnapshot>;
  return (
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.conversations) &&
    Array.isArray(candidate.messages) &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null
  );
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : '未命名会话';
}

/** 从首条用户消息里截一个标题出来 */
export function deriveTitleFromMessage(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return DEFAULT_CONVERSATION_TITLE;
  return firstLine.length > AUTO_TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, AUTO_TITLE_MAX_LENGTH)}…`
    : firstLine;
}

export function createBrowserStorage(storage: StorageLike): StorageService {
  // -------------------------------------------------------------------------
  // 读写快照
  // -------------------------------------------------------------------------
  function load(): StorageSnapshot {
    let raw: string | null = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return emptySnapshot();
    }
    if (!raw) return emptySnapshot();

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isSnapshot(parsed) || parsed.version !== SCHEMA_VERSION) return emptySnapshot();
      return { ...parsed, settings: { ...defaultSettings(), ...parsed.settings } };
    } catch {
      // 数据坏了不抛给用户，退回空数据，用户还能继续用
      return emptySnapshot();
    }
  }

  function save(snapshot: StorageSnapshot): void {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      // 配额满了 / 隐私模式禁写。抛出可读的消息，由调用方决定怎么提示用户。
      throw new Error(
        `本地存储写入失败，可能是浏览器存储空间已满或被禁用。原始原因：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // -------------------------------------------------------------------------
  // conversations 表
  // -------------------------------------------------------------------------
  const conversations: ConversationRepository = {
    async listConversations() {
      return load().conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async getConversation(id) {
      return load().conversations.find((item) => item.id === id) ?? null;
    },

    async createConversation(input: CreateConversationInput = {}) {
      const snapshot = load();
      const now = Date.now();
      const conversation: Conversation = {
        id: createId('conv'),
        title: normalizeTitle(input.title ?? DEFAULT_CONVERSATION_TITLE),
        createdAt: input.createdAt ?? now,
        updatedAt: input.createdAt ?? now,
        archived: input.archived ?? false,
      };
      snapshot.conversations.unshift(conversation);
      save(snapshot);
      return conversation;
    },

    async renameConversation(id, title) {
      const snapshot = load();
      const target = snapshot.conversations.find((item) => item.id === id);
      if (!target) return null;
      target.title = normalizeTitle(title);
      target.updatedAt = Date.now();
      save(snapshot);
      return { ...target };
    },

    async deleteConversation(id) {
      const snapshot = load();
      snapshot.conversations = snapshot.conversations.filter((item) => item.id !== id);
      // 级联删除，对应 SQLite 里的 ON DELETE CASCADE
      snapshot.messages = snapshot.messages.filter((item) => item.conversationId !== id);
      save(snapshot);
    },

    async touchConversation(id, at) {
      const snapshot = load();
      const target = snapshot.conversations.find((item) => item.id === id);
      if (!target) return;
      target.updatedAt = at ?? Date.now();
      save(snapshot);
    },

    async listMessages(conversationId) {
      return load()
        .messages.filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async appendMessage(input: AppendMessageInput) {
      const snapshot = load();
      const conversation = snapshot.conversations.find(
        (item) => item.id === input.conversationId
      );
      if (!conversation) {
        throw new Error('会话不存在，消息未能写入。');
      }

      const now = Date.now();
      const message: Message = {
        id: createId('msg'),
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        status: input.status ?? 'complete',
        createdAt: now,
      };
      snapshot.messages.push(message);
      conversation.updatedAt = now;

      // 首条用户消息升格为会话标题（会话管理体验的一部分，属于数据规则）
      if (input.role === 'user' && conversation.title === DEFAULT_CONVERSATION_TITLE) {
        conversation.title = deriveTitleFromMessage(input.content);
      }

      save(snapshot);
      return { ...message };
    },

    async updateMessage(id, patch: MessagePatch) {
      const snapshot = load();
      const message = snapshot.messages.find((item) => item.id === id);
      if (!message) return null;
      if (patch.content !== undefined) message.content = patch.content;
      if (patch.status !== undefined) message.status = patch.status;
      const conversation = snapshot.conversations.find(
        (item) => item.id === message.conversationId
      );
      if (conversation) conversation.updatedAt = Date.now();
      save(snapshot);
      return { ...message };
    },
  };

  // -------------------------------------------------------------------------
  // settings 表
  // -------------------------------------------------------------------------
  const settings: SettingsRepository = {
    async getSettings() {
      return load().settings;
    },

    async saveSettings(next) {
      const snapshot = load();
      snapshot.settings = next;
      save(snapshot);
    },

    async saveModelConfig(config) {
      // 只落非敏感投影。config 里的 apiKey 到这里就被丢掉了 ——
      // 不是靠"记得别写进去"，而是这个函数体里根本没有地方放它。
      const snapshot = load();
      snapshot.settings = {
        ...snapshot.settings,
        model: { apiUrl: config.apiUrl, modelName: config.modelName },
      };
      save(snapshot);
    },

    /** 浏览器阶段没有持久化凭据这回事，恒为 false */
    async hasStoredApiKey() {
      return false;
    },

    async clearStoredApiKey() {
      // 空操作：本来就没存过。留着这个方法是为了让调用方不需要区分环境。
    },
  };

  const driverName = 'Web Storage（localStorage）';

  return {
    driverName,
    credentialStorage: {
      kind: 'memory',
      label: '仅内存',
      description:
        '当前是浏览器运行模式：API Key 只存在于内存，刷新页面即失效。' +
        '它不会写入 localStorage、不会写入日志，也不会被发往本应用自己的服务器。' +
        '桌面版本（Tauri）会改由 Windows 凭据管理器保管。',
    },
    describeLocation: () =>
      '数据存放在浏览器的 localStorage（键名 desktop-ai-assistant:mvp），' +
      '结构按 SQLite 的三张表分开放置。桌面版本会改用应用数据目录下的 SQLite 文件。',
    async resolveLocation(): Promise<StorageLocation> {
      return { path: '浏览器 localStorage（键名 desktop-ai-assistant:mvp）', driver: driverName };
    },
    async probeCredentialStorage() {
      return {
        ok: true,
        message: '浏览器模式不使用系统凭据存储：API Key 只存在于内存。',
      };
    },
    conversations,
    settings,
    async reset() {
      storage.removeItem(STORAGE_KEY);
    },
  };
}
