/**
 * 桌面版存储实现（Tauri → Rust → SQLite）
 * ----------------------------------------------------------------------------
 * 这个文件是「阶段 B 替换存储实现」那句话的落地结果。它做的事只有一件：
 * 把 `StorageService` 的每个方法翻译成一次 `invoke`。
 *
 * 几个刻意的选择：
 *
 * 1. **不在这里做任何业务规则。** 比如「首条用户消息成为会话标题」，
 *    在桌面模式下由 Rust 在写库的事务里完成（见 src-tauri/src/db.rs），
 *    这里只是转发。规则只能有一个出处，否则桌面版和浏览器版迟早会分叉。
 *
 * 2. **apiKey 不经过这里。** 模型配置的保存走 `save_model_config`，
 *    Rust 侧会把它一分为二：地址和模型名入库，Key 进系统凭据管理器。
 *    前端拿不到「Key 存在哪」的句柄，也不需要。
 *
 * 3. **字段名映射只在这一层。** Rust 返回 `databasePath`，
 *    领域类型叫 `path` —— 因为浏览器模式下的「位置」根本不是路径。
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  AppSettings,
  Conversation,
  Message,
  ModelConfig,
  OperationResult,
  StorageLocation,
} from '@/types';
import type {
  AppendMessageInput,
  ConversationRepository,
  CreateConversationInput,
  MessagePatch,
  SettingsRepository,
  StorageService,
} from './types';

interface RustStorageLocation {
  databasePath: string;
  driver: string;
}

export function createTauriStorage(): StorageService {
  const conversations: ConversationRepository = {
    listConversations: () => invoke<Conversation[]>('list_conversations'),

    getConversation: (id) => invoke<Conversation | null>('get_conversation', { id }),

    createConversation: (input?: CreateConversationInput) =>
      invoke<Conversation>('create_conversation', { input: input ?? {} }),

    renameConversation: (id, title) =>
      invoke<Conversation | null>('rename_conversation', { id, title }),

    deleteConversation: (id) => invoke<void>('delete_conversation', { id }),

    touchConversation: (id, at) => invoke<void>('touch_conversation', { id, at: at ?? null }),

    listMessages: (conversationId) => invoke<Message[]>('list_messages', { conversationId }),

    appendMessage: (input: AppendMessageInput) => invoke<Message>('append_message', { input }),

    updateMessage: (id, patch: MessagePatch) =>
      invoke<Message | null>('update_message', { id, patch }),
  };

  const settings: SettingsRepository = {
    getSettings: () => invoke<AppSettings>('get_settings'),

    saveSettings: (next) => invoke<void>('save_settings', { settings: next }),

    saveModelConfig: (config: ModelConfig) => invoke<void>('save_model_config', { config }),

    hasStoredApiKey: () => invoke<boolean>('api_key_status'),

    clearStoredApiKey: () => invoke<void>('clear_api_key'),
  };

  return {
    driverName: 'SQLite（应用数据目录）',

    credentialStorage: {
      kind: 'os-keychain',
      label: 'Windows 凭据管理器',
      description:
        'API Key 由 Rust 侧保存到 Windows 凭据管理器，由操作系统加密、按当前用户隔离。' +
        '它不写入 SQLite 数据库、不写入日志，也不出现在前端的任何存储里 ——' +
        '前端只知道「是否已经保存过」。',
    },

    describeLocation: () =>
      '数据存放在系统分配的应用数据目录下的 SQLite 数据库，' +
      '按 conversations / messages / settings 三张表组织。' +
      '数据库文件不包含任何凭据。',

    async resolveLocation(): Promise<StorageLocation> {
      const location = await invoke<RustStorageLocation>('storage_location');
      return { path: location.databasePath, driver: location.driver };
    },

    probeCredentialStorage: () => invoke<OperationResult>('credential_storage_status'),

    conversations,
    settings,

    reset: () => invoke<void>('reset_all_data'),
  };
}
