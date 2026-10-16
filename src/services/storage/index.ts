/**
 * 存储层出口
 * ----------------------------------------------------------------------------
 * 全应用只从这一个文件拿 StorageService。这是「阶段 A → 阶段 B 换存储实现」
 * 那句话唯一的落点：桌面环境走 SQLite，浏览器环境走 Web Storage，
 * 上层的 store 和组件一行都不用改。
 */

import { isTauriRuntime } from '../runtime';
import { createBrowserStorage, type StorageLike } from './browser-storage';
import { createTauriStorage } from './tauri-storage';
import type { StorageService } from './types';

export {
  createBrowserStorage,
  DEFAULT_CLOSE_TO_TRAY,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_FILE_DIRECTORY,
  DEFAULT_GLOBAL_SHORTCUT,
  DEFAULT_INPUT_SIMULATION_ENABLED,
  DEFAULT_MODEL_ENDPOINT,
  DEFAULT_NOTIFY_ON_REPLY_COMPLETE,
  DEFAULT_PERSONA,
  DEFAULT_SCREENSHOT_ENABLED,
  defaultSettings,
  deriveTitleFromMessage,
} from './browser-storage';
export { createTauriStorage } from './tauri-storage';
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
  if (isTauriRuntime()) return createTauriStorage();
  return createBrowserStorage(resolveWebStorage());
}
