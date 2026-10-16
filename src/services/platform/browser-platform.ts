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
  type AutomationReport,
  type AutostartStatus,
  type FileAccessStatus,
  type FileEntry,
  type GlobalShortcutStatus,
  type NotificationOutcome,
  type NotificationRequest,
  type PlatformCapability,
  type PlatformService,
  type RecentRead,
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

    async showNotification(request: NotificationRequest): Promise<NotificationOutcome> {
      const api = resolveNotificationApi();
      // 能力本身不存在 → 抛错（环境不支持）。下面「有 API 但没发出去」才是返回值。
      if (!api) unsupported('notification');

      // 和桌面端保持同一套打扰判定：页面可见且聚焦时跳过。
      // 两边规则一致，才不会出现「桌面版很安静、浏览器版一直弹」这种诡异差异。
      if (!request.force) {
        const visible = document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        if (visible && focused) {
          return { delivered: false, reason: '页面正在前台，已跳过通知。' };
        }
      }

      let permission = api.permission;
      if (permission === 'default' && request.force) {
        // 只有用户明确要求时才发起授权申请。
        // 浏览器的授权提示必须由用户手势触发 —— 在「回复完成」这种后台时机去申请，
        // 既会被静默拒绝，又会平白打扰用户一次。
        permission = await api.requestPermission();
      }
      if (permission !== 'granted') {
        // 授权与否是运行时状态，不是错误 —— 返回说明比抛错更好用
        return {
          delivered: false,
          reason: request.force
            ? '浏览器没有授予通知权限，请在地址栏的站点设置里手动开启。'
            : '浏览器还没有通知权限；到设置页点「发一条测试通知」可以发起申请。',
        };
      }

      const Ctor = (
        globalThis as unknown as { Notification: new (title: string, options?: unknown) => unknown }
      ).Notification;
      new Ctor(request.title, { body: request.body });
      return { delivered: true, reason: '已发送浏览器通知。' };
    },

    async autostartStatus(): Promise<AutostartStatus> {
      // 浏览器里没有「开机自启」这回事，所以如实返回 false —— 这是事实，不是失败。
      // 界面会先看能力集合，不会把这个值当成一种状态来展示。
      return { enabled: false, exePath: '' };
    },

    async takeScreenshot() {
      unsupported('screenshot');
    },

    async setScreenshotEnabled() {
      unsupported('screenshot');
    },

    async setInputSimulationEnabled() {
      unsupported('input-simulation');
    },

    async runAutomation() {
      unsupported('input-simulation');
    },

    async stopAutomation() {
      unsupported('input-simulation');
    },

    async automationLastRun(): Promise<AutomationReport | null> {
      return null;
    },

    // ---- 本地文件（阶段 D） ----
    //
    // 浏览器读不了本地文件 —— 网页拿到的只有用户主动拖进来的东西。
    // 所以这里的查询方法返回「没有授权」这个事实，动作方法一律抛不支持。

    async fileAccessStatus(): Promise<FileAccessStatus> {
      return { directory: '', available: false };
    },

    async pickDirectory() {
      unsupported('file-read');
    },

    async authorizeDirectory() {
      unsupported('file-read');
    },

    async revokeDirectory() {
      unsupported('file-read');
    },

    async listAuthorizedDirectory(): Promise<FileEntry[]> {
      return [];
    },

    async readFile() {
      unsupported('file-read');
    },

    async recentFileReads(): Promise<RecentRead[]> {
      return [];
    },

    async setAutostart() {
      unsupported('autostart');
    },

    async globalShortcutStatus(): Promise<GlobalShortcutStatus> {
      // 浏览器里没有「全局快捷键」这回事：网页拿不到页面之外的按键。
      // 如实返回空状态，不抛错 —— 界面会先看能力集合。
      return { accelerator: '', registered: false };
    },

    async setGlobalShortcut() {
      unsupported('global-shortcut');
    },
  };
}
