import { describe, expect, it } from 'vitest';
import { createSettingsStore, DEFAULT_MODEL_CONFIG } from '@/features/settings/store';
import { createBrowserStorage, DEFAULT_PERSONA } from '@/services/storage';
import {
  createInstantProvider,
  createMemoryStorage,
  createTestServices,
  VALID_MODEL_CONFIG,
} from './helpers';

function setup() {
  const webStorage = createMemoryStorage();
  const services = createTestServices({
    storage: createBrowserStorage(webStorage),
    model: createInstantProvider(),
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

  it('向界面暴露真实的存储与平台信息，而不是硬编码文案', () => {
    const { store } = setup();
    expect(store.getState().storageDriverName.length).toBeGreaterThan(0);
    expect(store.getState().storageDescription).toContain('API Key');
    expect(store.getState().platformId).toBe('browser');
    expect(Array.isArray(store.getState().platformCapabilities)).toBe(true);
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
    store.getState().clearApiKey();

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
