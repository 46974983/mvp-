import { describe, expect, it } from 'vitest';
import {
  createBrowserPlatformService,
  PLATFORM_CAPABILITIES,
  PLATFORM_CAPABILITY_SPECS,
  UnsupportedCapabilityError,
} from '@/services/platform';

/**
 * 浏览器平台实现
 * ----------------------------------------------------------------------------
 * 测试重点不是「功能好不好用」，而是**不可用时行为是否诚实**。
 * 技术方案第 6 节要求「高权限能力默认关闭」——
 * 悄悄返回假数据、或者假装成功，都比直接报错危险得多。
 */
describe('浏览器平台实现', () => {
  it('标识为 browser', () => {
    expect(createBrowserPlatformService().id).toBe('browser');
  });

  it('能力是运行时探测出来的，不是写死的', async () => {
    const capabilities = await createBrowserPlatformService().probeCapabilities();

    expect(capabilities).toBeInstanceOf(Set);
    // 通知能力取决于浏览器有没有 Notification，跟着实际情况走
    expect(capabilities.has('notification')).toBe(globalThis.Notification !== undefined);

    // 这几项在浏览器里一律不可用 —— 没有托盘、没有文件系统、没有截屏
    for (const capability of ['tray', 'autostart', 'file-read', 'screenshot'] as const) {
      expect(capabilities.has(capability), capability).toBe(false);
    }
  });

  it('未开放的能力一律抛 UnsupportedCapabilityError，不返回假数据', async () => {
    const platform = createBrowserPlatformService();

    await expect(platform.readFile('D:/x.txt')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(platform.takeScreenshot()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(platform.setAutostart(true)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(platform.window.hideToTray()).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    await expect(platform.window.setCloseToTray(true)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
  });

  it('错误里带上具体是哪个能力，而不是笼统的「失败」', async () => {
    const platform = createBrowserPlatformService();

    await expect(platform.readFile('D:/x.txt')).rejects.toThrow(/读取本地文件/);
    await expect(platform.window.hideToTray()).rejects.toThrow(/系统托盘/);
  });

  it('查询类方法如实返回 false，而不是抛错', async () => {
    // 「关掉标签页就是关掉」是个事实，不是失败。
    // 这里报错只会逼调用方写一层没有意义的 try。
    await expect(createBrowserPlatformService().window.isCloseToTrayEnabled()).resolves.toBe(
      false
    );
  });
});

describe('能力清单', () => {
  it('每项能力都有可读的说明', () => {
    for (const capability of PLATFORM_CAPABILITIES) {
      const spec = PLATFORM_CAPABILITY_SPECS[capability];
      expect(spec, capability).toBeDefined();
      expect(spec.label.length, capability).toBeGreaterThan(0);
      expect(spec.description.length, capability).toBeGreaterThan(0);
      expect(['C', 'D'], capability).toContain(spec.plannedStage);
    }
  });

  it('清单的键与能力枚举完全一致，不会各说各的', () => {
    expect(Object.keys(PLATFORM_CAPABILITY_SPECS).sort()).toEqual(
      [...PLATFORM_CAPABILITIES].sort()
    );
  });

  it('托盘能力被标记为「桌面侧已实现」', () => {
    // 这条断言会在「实现和声明脱节」时提醒人：改了 Rust 却忘了改这里
    expect(PLATFORM_CAPABILITY_SPECS.tray.desktopImplemented).toBe(true);
    expect(PLATFORM_CAPABILITY_SPECS.tray.plannedStage).toBe('C');
  });
});

// ---------------------------------------------------------------------------
// 浏览器通知（阶段 C）
// ---------------------------------------------------------------------------

/**
 * jsdom 里没有 Notification API，所以这里自己造一个。
 * 造它不是为了「测假实现」，而是为了覆盖三件真实会发生的事：
 * 没授权、被前台跳过、以及真的发出去。
 */
function stubNotificationApi(permission: NotificationPermission) {
  const created: Array<{ title: string; body?: string }> = [];

  class FakeNotification {
    static permission: NotificationPermission = permission;
    static async requestPermission(): Promise<NotificationPermission> {
      return permission;
    }
    constructor(title: string, options?: { body?: string }) {
      created.push({ title, body: options?.body });
    }
  }

  Object.defineProperty(globalThis, 'Notification', {
    value: FakeNotification,
    configurable: true,
    writable: true,
  });

  return created;
}

function stubDocumentFocus(focused: boolean) {
  Object.defineProperty(document, 'hasFocus', {
    value: () => focused,
    configurable: true,
  });
}

function clearNotificationApi() {
  Reflect.deleteProperty(globalThis, 'Notification');
  Reflect.deleteProperty(document, 'hasFocus');
}

describe('浏览器通知', () => {
  it('没有 Notification API 时抛 UnsupportedCapabilityError（环境不支持）', async () => {
    clearNotificationApi();
    await expect(
      createBrowserPlatformService().showNotification({ title: 'a', body: 'b' })
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('已授权且强制发送时，真的创建一条通知', async () => {
    const created = stubNotificationApi('granted');

    const outcome = await createBrowserPlatformService().showNotification({
      title: '会话 A',
      body: '回复好了',
      force: true,
    });

    expect(outcome.delivered).toBe(true);
    expect(created).toEqual([{ title: '会话 A', body: '回复好了' }]);
    clearNotificationApi();
  });

  it('没授权时返回一句说明，而不是抛错', async () => {
    stubNotificationApi('denied');

    const outcome = await createBrowserPlatformService().showNotification({
      title: '会话 A',
      body: '回复好了',
      force: true,
    });

    // 「没授权」是运行时状态，不是程序错误 —— 界面需要的是说明，不是异常
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('权限');
    clearNotificationApi();
  });

  it('页面正在前台且未强制时跳过 —— 和桌面端同一套打扰规则', async () => {
    const created = stubNotificationApi('granted');
    stubDocumentFocus(true);

    const outcome = await createBrowserPlatformService().showNotification({
      title: '会话 A',
      body: '回复好了',
    });

    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('前台');
    expect(created).toHaveLength(0);
    clearNotificationApi();
  });

  it('页面在前台但用户明确要求时照发（设置页的测试按钮）', async () => {
    const created = stubNotificationApi('granted');
    stubDocumentFocus(true);

    const outcome = await createBrowserPlatformService().showNotification({
      title: '会话 A',
      body: '回复好了',
      force: true,
    });

    expect(outcome.delivered).toBe(true);
    expect(created).toHaveLength(1);
    clearNotificationApi();
  });
});

describe('授权申请只在用户明确要求时发起', () => {
  it('后台路径（未 force）不会触发授权弹窗', async () => {
    let requested = 0;
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission(): Promise<NotificationPermission> {
        requested += 1;
        return 'granted';
      }
      constructor() {
        /* 不会走到这里 */
      }
    }
    Object.defineProperty(globalThis, 'Notification', {
      value: FakeNotification,
      configurable: true,
      writable: true,
    });
    // 让打扰判定放行，确保「没弹窗」不是因为被前台跳过了
    stubDocumentFocus(false);

    const outcome = await createBrowserPlatformService().showNotification({
      title: '会话 A',
      body: '回复好了',
    });

    // 浏览器的授权提示需要用户手势，后台时机申请会被静默拒绝，所以不该发这一步
    expect(requested).toBe(0);
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain('测试通知');
    clearNotificationApi();
  });

  it('用户点按钮（force）时才发起授权申请', async () => {
    let requested = 0;
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission(): Promise<NotificationPermission> {
        requested += 1;
        return 'granted';
      }
      constructor() {
        /* 不需要真的创建 */
      }
    }
    Object.defineProperty(globalThis, 'Notification', {
      value: FakeNotification,
      configurable: true,
      writable: true,
    });

    const outcome = await createBrowserPlatformService().showNotification({
      title: '会话 A',
      body: '回复好了',
      force: true,
    });

    expect(requested).toBe(1);
    expect(outcome.delivered).toBe(true);
    clearNotificationApi();
  });
});

// ---------------------------------------------------------------------------
// 开机自启（阶段 C）
// ---------------------------------------------------------------------------

describe('开机自启', () => {
  it('动作类方法抛 UnsupportedCapabilityError', async () => {
    await expect(createBrowserPlatformService().setAutostart(true)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    await expect(createBrowserPlatformService().setAutostart(false)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
  });

  it('查询类方法返回事实：浏览器里没有自启这回事', async () => {
    const status = await createBrowserPlatformService().autostartStatus();

    // 「关掉标签页就结束了」是事实，不是失败 —— 查询不该抛错
    expect(status.enabled).toBe(false);
    expect(status.exePath).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 全局快捷键（阶段 C）
// ---------------------------------------------------------------------------

describe('全局快捷键', () => {
  it('动作类方法抛 UnsupportedCapabilityError', async () => {
    await expect(
      createBrowserPlatformService().setGlobalShortcut('CommandOrControl+Shift+K')
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(createBrowserPlatformService().setGlobalShortcut(null)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
  });

  it('查询类方法返回事实：网页拿不到页面之外的按键', async () => {
    const status = await createBrowserPlatformService().globalShortcutStatus();

    expect(status).toEqual({ accelerator: '', registered: false });
  });
});

// ---------------------------------------------------------------------------
// 本地文件（阶段 D）
// ---------------------------------------------------------------------------

describe('本地文件', () => {
  it('动作类方法抛 UnsupportedCapabilityError', async () => {
    const platform = createBrowserPlatformService();
    for (const call of [
      () => platform.pickDirectory(),
      () => platform.authorizeDirectory('D://笔记'),
      () => platform.revokeDirectory(),
      () => platform.readFile('a.txt'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    }
  });

  it('查询类方法返回事实：浏览器里没有授权这回事', async () => {
    const platform = createBrowserPlatformService();

    expect(await platform.fileAccessStatus()).toEqual({ directory: '', available: false });
    expect(await platform.listAuthorizedDirectory('')).toEqual([]);
    expect(await platform.recentFileReads()).toEqual([]);
  });
});
