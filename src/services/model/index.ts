/**
 * 模型层出口
 * ----------------------------------------------------------------------------
 * 全应用只从 createModelProvider() 拿 provider。这是阶段 A -> B 唯一的切换点。
 */

import { MockModelProvider } from './mock-provider';
import type { ModelProvider } from './types';

export { MockModelProvider } from './mock-provider';
export { modelConfigSchema, validateModelConfig } from './schema';
export type { ModelConfigForm } from './schema';
export type { ModelProvider } from './types';

/**
 * 当前阶段（A）返回离线模拟实现。
 * 阶段 B 的改法：在这里判断是否运行在桌面外壳里，是则返回由 Rust 侧驱动的 provider。
 * 界面层拿到的仍然是同一个接口，一行都不用改。
 */
export function createModelProvider(): ModelProvider {
  return new MockModelProvider();
}
