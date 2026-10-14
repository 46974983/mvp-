/**
 * 依赖组装（Composition Root）
 * ----------------------------------------------------------------------------
 * 整个应用只有这一个地方「决定用哪个实现」。组件和 store 只接收 Services，
 * 不自己 new 任何东西。这样测试里可以整套换成假的，界面代码不用打洞。
 */

import { createModelProvider, type ModelProvider } from './model';
import { createPlatformService, type PlatformService } from './platform';
import { createDefaultStorage, type StorageService } from './storage';

export interface Services {
  storage: StorageService;
  model: ModelProvider;
  platform: PlatformService;
}

export function createServices(overrides: Partial<Services> = {}): Services {
  return {
    storage: overrides.storage ?? createDefaultStorage(),
    model: overrides.model ?? createModelProvider(),
    platform: overrides.platform ?? createPlatformService(),
  };
}

let singleton: Services | null = null;

/** 应用运行时用的那一份。测试请用 createServices() 自己造，别碰这个。 */
export function getServices(): Services {
  singleton ??= createServices();
  return singleton;
}
