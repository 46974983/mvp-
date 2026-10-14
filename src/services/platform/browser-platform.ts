/**
 * 浏览器平台实现
 * ----------------------------------------------------------------------------
 * 浏览器里没有系统托盘、没有开机自启、没有本地文件系统。
 *
 * 所以这里的原则是**如实回答**，而不是「尽量模拟」：
 *   - 查询类方法（isCloseToTrayEnabled）返回事实：关掉标签页就是关掉，所以是 false；
 *   - 动作类方法（hideToTray / readFile / ...）抛 UnsupportedCapabilityError，
 *     让界面能明确显示「当前环境不支持」，而不是静默什么都不做。
 *
 * 唯一的真能力是系统通知（用的是 Web Notification API）。
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
  function unsupported(capability: PlatformCapability): never {
    throw new UnsupportedCapabilityError(capability);
  }

  async function probeCapabilities(): Promise<ReadonlySet<PlatformCapability>> {
    const capabilities = new Set<PlatformCapability>();
    // 通知能力取决于浏览器有没有 Notification，所以每次探测都重新看一眼
    if (resolveNotificationApi()) capabilities.add('notification');
    return capabilities;
  }

  return {
    id: 'browser',

    probeCapabilities,

    window: {
      async hideToTray() {
        // 浏览器里没有托盘可藏。假装成功会让用户以为窗口会回来。
        unsupported('tray');
      },

      async isCloseToTrayEnabled() {
        // 这不是「不支持」，而是事实：关掉标签页就是关掉了。
        // 查询类方法报错只会逼调用方写一层没意义的 try。
        return false;
      },

      async setCloseToTray() {
        unsupported('tray');
      },
    },

    async readFile() {
      unsupported('file-read');
    },

    async takeScreenshot() {
      unsupported('screenshot');
    },

    async showNotification(text: string) {
      const api = resolveNotificationApi();
      if (!api) unsupported('notification');

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
      unsupported('autostart');
    },
  };
}
