import { describe, expect, it } from 'vitest';
import { createSettingsStore, DEFAULT_MODEL_CONFIG } from '@/features/settings/store';
import {
  createBrowserStorage,
  DEFAULT_CLOSE_TO_TRAY,
  DEFAULT_PERSONA,
} from '@/services/storage';
import {
  createBrowserPlatformService,
  type PlatformCapability,
  type PlatformService,
} from '@/services/platform';
import {
  createInstantProvider,
  createMemoryStorage,
  createTestServices,
  VALID_MODEL_CONFIG,
} from './helpers';

function setup(platform?: PlatformService) {
  const webStorage = createMemoryStorage();
  const services = createTestServices({
    storage: createBrowserStorage(webStorage),
    model: createInstantProvider(),
    ...(platform ? { platform } : {}),
  });

  return { webStorage, store: createSettingsStore(services) };
}

describe('启动时的默认值', () => {
  it('未配置过时使用默认人格与默认模型配置', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().settings.persona.assistantName).toBe(DEFAULT_PERSONA.assistantName);
    expect(store.getState().modelConfig).toEqual(DEFAULT_MODEL_CONFIG);
    expect(store.getState().loaded).toBe(true);
  });

  it('向界面暴露真实的存储与平台信息，而不是硬编码文案', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().driverName.length).toBeGreaterThan(0);
    expect(store.getState().platformId).toBe('browser');
    expect(Array.isArray(store.getState().platformCapabilities)).toBe(true);

    // 浏览器模式下凭据只留内存：界面据此显示「刷新即失效」
    expect(store.getState().credentialStorage.kind).toBe('memory');
    expect(store.getState().location?.path).toContain('localStorage');
    expect(store.getState().apiKeyStored).toBe(false);
  });
});

describe('人格配置校验与保存', () => {
  it('助手名称为空时被挡住，并给出可读提示', async () => {
    const { store } = setup();
    const result = await store
      .getState()
      .savePersona({ assistantName: '  ', userName: '老大', systemPrompt: '你好' });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/请填写助手名称/);
  });

  it('超长内容被挡住', async () => {
    const { store } = setup();
    const result = await store.getState().savePersona({
      assistantName: '一'.repeat(20),
      userName: '老大',
      systemPrompt: '你好',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/不要超过 16 个字/);
  });

  it('保存成功后立即可见，且落到了存储里', async () => {
    const { store, webStorage } = setup();
    const result = await store.getState().savePersona({
      assistantName: '  阿枢  ',
      userName: '  老大  ',
      systemPrompt: '  先给结论。  ',
    });

    expect(result.ok).toBe(true);
    // 首尾空白被清掉，避免用户填了个「隐形空格」还以为生效了
    expect(store.getState().settings.persona.assistantName).toBe('阿枢');
    expect(store.getState().settings.persona.systemPrompt).toBe('先给结论。');
    expect(JSON.stringify(webStorage.raw())).toContain('阿枢');
  });
});

describe('模型配置：非敏感字段落盘，Key 不落盘', () => {
  it('更新模型配置时，地址与模型名写进存储，Key 完全不落盘', async () => {
    const { store, webStorage } = setup();
    await store.getState().updateModelConfig(VALID_MODEL_CONFIG);

    // 内存里当然有 Key
    expect(store.getState().modelConfig.apiKey).toBe(VALID_MODEL_CONFIG.apiKey);

    const persisted = JSON.stringify(webStorage.raw());
    expect(persisted).toContain(VALID_MODEL_CONFIG.apiUrl);
    expect(persisted).toContain(VALID_MODEL_CONFIG.modelName);
    expect(persisted).not.toContain(VALID_MODEL_CONFIG.apiKey);
    expect(persisted).not.toMatch(/apiKey/i);
  });

  it('重新加载（等价于刷新页面）后地址还在，Key 必须重填', async () => {
    const { store } = setup();
    await store.getState().updateModelConfig(VALID_MODEL_CONFIG);
    store.getState().clearApiKey();

    await store.getState().load();

    expect(store.getState().modelConfig.apiUrl).toBe(VALID_MODEL_CONFIG.apiUrl);
    expect(store.getState().modelConfig.modelName).toBe(VALID_MODEL_CONFIG.modelName);
    expect(store.getState().modelConfig.apiKey).toBe('');
  });

  it('clearApiKey 只清掉 Key，其余字段保留', async () => {
    const { store } = setup();
    await store.getState().updateModelConfig(VALID_MODEL_CONFIG);
    await store.getState().clearApiKey();

    expect(store.getState().modelConfig.apiKey).toBe('');
    expect(store.getState().modelConfig.apiUrl).toBe(VALID_MODEL_CONFIG.apiUrl);
    expect(store.getState().modelConfig.modelName).toBe(VALID_MODEL_CONFIG.modelName);
  });

  it('testConnection 走的是当前 provider，不自己造结果', async () => {
    const { store } = setup();
    const result = await store.getState().testConnection(VALID_MODEL_CONFIG);
    expect(result.ok).toBe(true);
  });
});

describe('重置数据', () => {
  it('重置后存储被清空，内存回到默认值', async () => {
    const { store, webStorage } = setup();
    await store.getState().savePersona({
      assistantName: '改过的名字',
      userName: '老大',
      systemPrompt: '改过的提示词',
    });
    await store.getState().updateModelConfig(VALID_MODEL_CONFIG);

    await store.getState().resetAll();

    expect(webStorage.raw()).toEqual({});
    expect(store.getState().settings.persona.assistantName).toBe(DEFAULT_PERSONA.assistantName);
    expect(store.getState().modelConfig).toEqual(DEFAULT_MODEL_CONFIG);
  });

  it('重置排在未完成的写入之后，不会出现「重置完数据又回来了」', async () => {
    const { store, webStorage } = setup();
    await store.getState().savePersona({
      assistantName: '改过的名字',
      userName: '老大',
      systemPrompt: '改过的提示词',
    });

    // 故意不 await：模拟用户点完「保存配置」立刻点「重置数据」
    void store.getState().updateModelConfig(VALID_MODEL_CONFIG);
    await store.getState().resetAll();

    expect(webStorage.raw()).toEqual({});
    expect(store.getState().settings.persona.assistantName).toBe(DEFAULT_PERSONA.assistantName);
  });
});

// ---------------------------------------------------------------------------
// 托盘与窗口（阶段 C）
// ---------------------------------------------------------------------------

/**
 * 造一个「声称有托盘」的平台实现。
 * 用它验证成功路径 —— 浏览器环境下这两条链路永远不会成功，
 * 只测失败路径的话，成功路径会一直是没跑过的代码。
 */
function createTrayCapablePlatform() {
  const base = createBrowserPlatformService();
  const calls: string[] = [];
  let closeToTray = true;

  const platform: PlatformService = {
    ...base,
    id: 'fake-tray',
    probeCapabilities: async () => new Set<PlatformCapability>(['tray']),
    window: {
      ...base.window,
      hideToTray: async () => {
        calls.push('hide');
      },
      isCloseToTrayEnabled: async () => closeToTray,
      setCloseToTray: async (enabled: boolean) => {
        closeToTray = enabled;
        calls.push(`set:${enabled}`);
      },
    },
  };

  return { platform, calls, current: () => closeToTray };
}

describe('托盘与窗口设置', () => {
  it('默认开启「关闭窗口时缩到托盘」', () => {
    const { store } = setup();
    expect(store.getState().closeToTray).toBe(DEFAULT_CLOSE_TO_TRAY);
    expect(DEFAULT_CLOSE_TO_TRAY).toBe(true);
  });

  it('浏览器模式探测不到托盘能力', async () => {
    const { store } = setup();
    await store.getState().load();
    expect(store.getState().platformCapabilities).not.toContain('tray');
  });

  it('环境不支持时，修改关闭行为返回失败而不是静默成功', async () => {
    const { store } = setup();
    await store.getState().load();

    const result = await store.getState().setCloseToTray(false);

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    // 状态不能跟着变 —— 「点了但没生效」比「不让点」更糟
    expect(store.getState().closeToTray).toBe(DEFAULT_CLOSE_TO_TRAY);
  });

  it('环境不支持时，隐藏到托盘返回失败', async () => {
    const { store } = setup();
    await store.getState().load();

    const result = await store.getState().hideToTray();

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('有托盘能力时：能探测到、能切换、能隐藏', async () => {
    const { platform, calls, current } = createTrayCapablePlatform();
    const { store } = setup(platform);
    await store.getState().load();

    expect(store.getState().platformCapabilities).toContain('tray');

    const toggled = await store.getState().setCloseToTray(false);
    expect(toggled.ok).toBe(true);
    expect(current()).toBe(false);
    expect(store.getState().closeToTray).toBe(false);
    // 内存里的设置结构要同步，否则设置页重渲染会跳回旧值
    expect(store.getState().settings.window.closeToTray).toBe(false);

    const hidden = await store.getState().hideToTray();
    expect(hidden.ok).toBe(true);
    expect(calls).toEqual(['set:false', 'hide']);
  });

  it('重置数据会把关闭行为恢复到默认值', async () => {
    const { platform } = createTrayCapablePlatform();
    const { store } = setup(platform);
    await store.getState().load();
    await store.getState().setCloseToTray(false);

    await store.getState().resetAll();

    expect(store.getState().closeToTray).toBe(DEFAULT_CLOSE_TO_TRAY);
  });
});
