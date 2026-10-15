/**
 * 模型层出口
 * ----------------------------------------------------------------------------
 * 全应用只从 createModelProvider() 拿 provider。
 * 这是「浏览器离线实现 → Rust 侧真实请求」唯一的切换点。
 *
 * 为什么浏览器环境**至今**仍然只给离线实现：
 *   技术方案第 5 节写的是「浏览器 Demo 仅允许使用 mock 数据，不连接真实模型」，
 *   理由是 API Key 不能明文落在浏览器存储里。阶段 B 并没有推翻这条 ——
 *   它给了这条约束一个**更好的出口**：想让模型真的回答，就用桌面版，
 *   Key 交给系统凭据管理器。所以浏览器分支保持原样是对的，不是忘了改。
 */

import { isTauriRuntime } from '../runtime';
import { MockModelProvider } from './mock-provider';
import { createTauriModelProvider } from './tauri-provider';
import type { ModelProvider } from './types';

export { MockModelProvider } from './mock-provider';
export { createTauriModelProvider } from './tauri-provider';
export {
  modelConfigSchema,
  modelConfigSchemaForStoredKey,
  validateModelConfig,
} from './schema';
export type { ModelConfigForm } from './schema';
export type { ModelProvider } from './types';

export function createModelProvider(): ModelProvider {
  if (isTauriRuntime()) return createTauriModelProvider();
  return new MockModelProvider();
}
