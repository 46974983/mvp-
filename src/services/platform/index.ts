/**
 * 平台层出口
 * ----------------------------------------------------------------------------
 * 与存储层、模型层同样的套路：界面只认 PlatformService 接口。
 */

import { isTauriRuntime } from '../runtime';
import { createBrowserPlatformService } from './browser-platform';
import { createTauriPlatformService } from './tauri-platform';
import type { PlatformService } from './types';

export { createBrowserPlatformService } from './browser-platform';
export { createTauriPlatformService } from './tauri-platform';
export { PLATFORM_CAPABILITIES, UnsupportedCapabilityError } from './types';
export type { PlatformCapability, PlatformService } from './types';

export function createPlatformService(): PlatformService {
  if (isTauriRuntime()) return createTauriPlatformService();
  return createBrowserPlatformService();
}
