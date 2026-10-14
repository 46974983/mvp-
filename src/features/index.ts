/**
 * 全局 store 组装
 * ----------------------------------------------------------------------------
 * 应用运行时只需要在这里组装一次。组件从本文件导入 hook，而不是各自 new 一个 store，
 * 否则状态就散了。测试请直接 import createXxxStore 并喂假的 Services。
 */

import { getServices } from '@/services/container';
import { createChatStore } from './chat/store';
import { createConversationsStore } from './conversations/store';
import { createSettingsStore } from './settings/store';

const services = getServices();

export const useConversationsStore = createConversationsStore(services);
export const useSettingsStore = createSettingsStore(services);
export const useChatStore = createChatStore(services, useConversationsStore, useSettingsStore);

export { createChatStore } from './chat/store';
export { createConversationsStore } from './conversations/store';
export { createSettingsStore, DEFAULT_MODEL_CONFIG } from './settings/store';
export { personaSchema, validatePersona } from './settings/schema';
export type { PersonaForm } from './settings/schema';
export type { ChatState } from './chat/store';
export type { ConversationsState } from './conversations/store';
export type { SettingsState } from './settings/store';

// 模型配置的校验规则归属「模型」这个领域，但组件层不应该直接 import @/services。
// 在这里转一次手：组件只知道「有这么个 schema」，不知道它住哪一层。
export { modelConfigSchema } from '@/services/model';
export type { ModelConfigForm } from '@/services/model';

// 能力清单同理：界面要读能力的名字和说明，但不该直接摸到服务层的实现目录。
export { PLATFORM_CAPABILITIES, PLATFORM_CAPABILITY_SPECS } from '@/services/platform';
export type { PlatformCapability, PlatformCapabilitySpec } from '@/services/platform';
