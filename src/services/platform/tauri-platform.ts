/**
 * 桌面平台实现（Tauri）
 * ----------------------------------------------------------------------------
 * 能力集合目前是**空的**，这是如实回答，不是偷懒。
 *
 * 技术方案第 6 节把原生能力排了顺序：
 *   1. SQLite、加密配置和模型请求   ← 本阶段已做（它们不走 PlatformService）
 *   2. 托盘、隐藏窗口、开机启动、全局快捷键
 *   3. 本地文件读取和路径权限
 *   4. 截屏
 *   5. 键鼠模拟和自动化
 *
 * 第 2 项之后才轮到 PlatformService 上的这些能力，所以阶段 B 里它们都还没开。
 * 界面拿到空集合就会把对应入口标记成「未开放」，用户不会点了之后才发现不行。
 *
 * 阶段 C 的做法：把这里换成通过 `invoke` 调用 Rust 命令的实现，
 * capabilities/default.json 里再逐项放开对应权限。接口不用改。
 */

import type { PlatformCapability, PlatformService } from './types';

export function createTauriPlatformService(): PlatformService {
  const capabilities = new Set<PlatformCapability>();

  function unsupported(capability: PlatformCapability) {
    return new Error(`当前阶段尚未开放「${capability}」能力，它排在技术方案第 6 节的后续阶段。`);
  }

  return {
    id: 'tauri',
    capabilities,

    supports(capability) {
      return capabilities.has(capability);
    },

    async readFile() {
      throw unsupported('file-read');
    },

    async takeScreenshot() {
      throw unsupported('screenshot');
    },

    async showNotification() {
      throw unsupported('notification');
    },

    async setAutostart() {
      throw unsupported('autostart');
    },
  };
}
