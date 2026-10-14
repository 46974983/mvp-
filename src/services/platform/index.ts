/**
 * 平台层出口
 * ----------------------------------------------------------------------------
 * 与模型层同样的套路：界面只认 PlatformService 接口，
 * 换实现（browser -> tauri）只改这个文件。
 */

import { createBrowserPlatformService } from './browser-platform';
import type { PlatformService } from './types';

export { createBrowserPlatformService } from './browser-platform';
export { PLATFORM_CAPABILITIES, UnsupportedCapabilityError } from './types';
export type { PlatformCapability, PlatformService } from './types';

export function createPlatformService(): PlatformService {
  // 阶段 B：if (isTauriEnv()) return createTauriPlatformService();
  return createBrowserPlatformService();
}
