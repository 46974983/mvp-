import { describe, expect, it } from 'vitest';
import { createBrowserPlatformService, UnsupportedCapabilityError } from '@/services/platform';

/**
 * 平台能力的测试重点不是「功能好不好用」，而是**不可用时行为是否诚实**。
 * 技术方案第 6 节要求「高权限能力默认关闭」——
 * 悄悄返回假数据、或者假装成功，都比直接报错危险得多。
 */
describe('浏览器平台实现', () => {
  it('标识为 browser，能力集合是运行时算出来的', () => {
    const platform = createBrowserPlatformService();
    expect(platform.id).toBe('browser');
    expect(platform.capabilities).toBeInstanceOf(Set);
    expect(platform.supports('file-read')).toBe(false);
    expect(platform.supports('screenshot')).toBe(false);
    expect(platform.supports('autostart')).toBe(false);
  });

  it('未开放的能力一律抛 UnsupportedCapabilityError，不返回假数据', async () => {
    const platform = createBrowserPlatformService();

    await expect(platform.readFile('D:/x.txt')).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    await expect(platform.takeScreenshot()).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
    await expect(platform.setAutostart(true)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError
    );
  });

  it('错误里带上具体是哪个能力，而不是笼统的「失败」', async () => {
    const platform = createBrowserPlatformService();
    await expect(platform.readFile('D:/x.txt')).rejects.toThrow(/file-read/);
  });

  it('capabilities 集合与 supports() 的回答始终一致', () => {
    const platform = createBrowserPlatformService();
    for (const capability of ['file-read', 'screenshot', 'notification', 'autostart'] as const) {
      expect(platform.supports(capability)).toBe(platform.capabilities.has(capability));
    }
  });
});
