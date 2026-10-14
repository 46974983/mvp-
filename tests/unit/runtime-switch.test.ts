import { afterEach, describe, expect, it } from 'vitest';
import { isTauriRuntime, runtimeKind } from '@/services/runtime';
import { createDefaultStorage, createTauriStorage } from '@/services/storage';
import { createModelProvider, createTauriModelProvider } from '@/services/model';
import { createPlatformService, createTauriPlatformService } from '@/services/platform';

/**
 * 运行环境切换
 * ----------------------------------------------------------------------------
 * 这三个切换点是阶段 B 的核心机制：同一份前端代码，在浏览器和桌面壳里
 * 必须拿到**不同**的实现。测的就是这件事。
 *
 * 植桩 `__TAURI_INTERNALS__` 就够了 —— 因为实现类在构造时不会调用 invoke，
 * 它们只是把命令名包成函数。真正会打到 Rust 的行为由 Rust 侧的 cargo test 覆盖。
 */

interface TauriGlobals {
  __TAURI_INTERNALS__?: unknown;
}

function stubTauriRuntime(enabled: boolean): void {
  const globals = window as unknown as TauriGlobals;
  if (enabled) {
    globals.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() };
  } else {
    delete globals.__TAURI_INTERNALS__;
  }
}

afterEach(() => {
  stubTauriRuntime(false);
});

describe('环境探测', () => {
  it('没有 Tauri 注入时判定为浏览器环境', () => {
    stubTauriRuntime(false);
    expect(isTauriRuntime()).toBe(false);
    expect(runtimeKind()).toBe('browser');
  });

  it('检测到 __TAURI_INTERNALS__ 时判定为桌面环境', () => {
    stubTauriRuntime(true);
    expect(isTauriRuntime()).toBe(true);
    expect(runtimeKind()).toBe('tauri');
  });
});

describe('浏览器环境拿到的实现', () => {
  it('存储走 Web Storage，凭据只留内存', () => {
    stubTauriRuntime(false);
    const storage = createDefaultStorage();

    expect(storage.driverName).toContain('localStorage');
    expect(storage.credentialStorage.kind).toBe('memory');
  });

  it('模型走离线实现，不联网', () => {
    stubTauriRuntime(false);
    const provider = createModelProvider();

    expect(provider.id).toBe('mock');
    expect(provider.performsNetworkRequest).toBe(false);
  });

  it('平台实现是 browser', () => {
    stubTauriRuntime(false);
    expect(createPlatformService().id).toBe('browser');
  });
});

describe('桌面环境拿到的实现', () => {
  it('存储走 SQLite，凭据交给系统凭据管理器', () => {
    stubTauriRuntime(true);
    const storage = createDefaultStorage();

    expect(storage.driverName).toContain('SQLite');
    expect(storage.credentialStorage.kind).toBe('os-keychain');
    expect(storage.credentialStorage.label).toContain('凭据管理器');
  });

  it('模型走 Rust 侧真实请求', () => {
    stubTauriRuntime(true);
    const provider = createModelProvider();

    expect(provider.id).toBe('tauri-openai');
    expect(provider.performsNetworkRequest).toBe(true);
  });

  it('平台实现是 tauri，且阶段 B 不开放任何高权限能力', () => {
    stubTauriRuntime(true);
    const platform = createPlatformService();

    expect(platform.id).toBe('tauri');
    expect([...platform.capabilities]).toEqual([]);
  });
});

describe('两种模式的差别是显式声明的', () => {
  it('凭据描述文字不一致 —— 因为事实本来就不一样', () => {
    stubTauriRuntime(false);
    const browserText = createDefaultStorage().credentialStorage.description;

    stubTauriRuntime(true);
    const tauriText = createTauriStorage().credentialStorage.description;

    expect(browserText).not.toBe(tauriText);
    expect(browserText).toContain('刷新');
    expect(tauriText).toContain('凭据管理器');
  });

  it('直接构造的桌面实现与切换逻辑给出的结果一致', () => {
    stubTauriRuntime(true);
    expect(createDefaultStorage().driverName).toBe(createTauriStorage().driverName);
    expect(createModelProvider().id).toBe(createTauriModelProvider().id);
    expect(createPlatformService().id).toBe(createTauriPlatformService().id);
  });
});
