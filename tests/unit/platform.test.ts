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
