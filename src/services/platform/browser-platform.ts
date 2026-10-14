/**
 * 浏览器平台实现（阶段 A）
 * ----------------------------------------------------------------------------
 * 只有「通知」是真能力，其余一律抛 UnsupportedCapabilityError —— 不静默失败，
 * 也不返回假数据。capabilities 集合是运行时算出来的，界面可以直接拿它来禁用按钮，
 * 而不是靠硬编码「阶段 A 所以不能用」。
 *
 * 想知道阶段 B 长什么样：把这个文件替换成 TauriPlatformService，
 * 用 invoke() 调用 Rust 侧的窄命令，capabilities 从 tauri.conf.json 的
 * capabilities 配置反推。接口不变。
 */

import {
  UnsupportedCapabilityError,
  type PlatformCapability,
  type PlatformService,
} from './types';

interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

function resolveNotificationApi(): NotificationApi | null {
  const candidate = (globalThis as { Notification?: NotificationApi }).Notification;
  return candidate ?? null;
}

export function createBrowserPlatformService(): PlatformService {
  const notificationApi = resolveNotificationApi();

  const capabilities = new Set<PlatformCapability>();
  if (notificationApi) capabilities.add('notification');

  async function ensure(capability: PlatformCapability): Promise<void> {
    if (!capabilities.has(capability)) throw new UnsupportedCapabilityError(capability);
  }

  return {
    id: 'browser',
    capabilities,

    supports(capability) {
      return capabilities.has(capability);
    },

    async readFile() {
      await ensure('file-read');
      throw new UnsupportedCapabilityError('file-read');
    },

    async takeScreenshot() {
      await ensure('screenshot');
      throw new UnsupportedCapabilityError('screenshot');
    },

    async showNotification(text: string) {
      await ensure('notification');
      const api = notificationApi;
      if (!api) throw new UnsupportedCapabilityError('notification');

      let permission = api.permission;
      if (permission === 'default') {
        permission = await api.requestPermission();
      }
      if (permission !== 'granted') {
        throw new Error('浏览器未授予通知权限，请在地址栏的站点设置里开启。');
      }

      const Ctor = (globalThis as unknown as { Notification: new (title: string) => unknown })
        .Notification;
      new Ctor(text);
    },

    async setAutostart() {
      await ensure('autostart');
      throw new UnsupportedCapabilityError('autostart');
    },
  };
}
