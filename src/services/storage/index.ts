/**
 * 存储层出口
 * ----------------------------------------------------------------------------
 * 全应用只从这一个文件拿 StorageService。阶段 B 要换 SQLite 实现时，
 * 只需要改这里的 createDefaultStorage，其他地方一行不用动。
 */

import { createBrowserStorage, type StorageLike } from './browser-storage';
import type { StorageService } from './types';

export {
  createBrowserStorage,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_MODEL_ENDPOINT,
  DEFAULT_PERSONA,
  defaultSettings,
  deriveTitleFromMessage,
} from './browser-storage';
export type { StorageLike } from './browser-storage';
export type {
  AppendMessageInput,
  ConversationRepository,
  CreateConversationInput,
  MessagePatch,
  SettingsRepository,
  StorageService,
} from './types';

/** 内存兜底：隐私模式 / 沙箱里 localStorage 可能直接抛异常，这时退化成内存存储，应用还能跑。 */
function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function resolveWebStorage(): StorageLike {
  try {
    const probe = '__desktop-ai-assistant_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

export function createDefaultStorage(): StorageService {
  return createBrowserStorage(resolveWebStorage());
}
