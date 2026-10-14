/**
 * 设置 store（Zustand）
 * ----------------------------------------------------------------------------
 * 这里有一条硬约束，值得写在文件最上面：
 *
 *   modelConfig.apiKey 只存在于内存里，任何时候都不写进存储、不写进日志。
 *   技术方案第 5 节要求「API Key 不以明文写入 SQLite、localStorage 或日志」，
 *   而桌面版本的安全存储要到阶段 B 由 Rust 侧接管。在阶段 A 里，
 *   唯一诚实的做法就是：不落盘。
 *
 * 代价是刷新页面后要重新填 Key。这个代价是刻意的 —— 拿它换「Key 不可能泄露到本地存储」。
 * 界面上会明确告诉用户这件事，而不是让他自己发现。
 *
 * 但「不落 Key」不等于「什么都不存」：
 *   产品设计 3.2 要求「保存本地配置」。API 地址和模型名属于非敏感设置，
 *   每次刷新都要重填地址是没有道理的。所以持久化的是 ModelConfig 的一个投影
 *   （PersistedModelConfig），只含 apiUrl 和 modelName。
 *   这个投影在**类型层面**就没有 apiKey 字段 —— 不是靠"记得别写进去"。
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { AppSettings, ModelConfig, OperationResult, PersonaConfig } from '@/types';
import type { Services } from '@/services/container';
import { DEFAULT_MODEL_ENDPOINT, defaultSettings } from '@/services/storage';
import { validatePersona } from './schema';

/** 内存态的完整模型配置（含 Key）。默认值里 Key 是空的：它从来没有过默认值。 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  ...DEFAULT_MODEL_ENDPOINT,
  apiKey: '',
};

export interface SettingsState {
  settings: AppSettings;
  /** 内存态模型配置，其中 apiKey 不持久化 */
  modelConfig: ModelConfig;
  loaded: boolean;

  /** 当前存储实现的说明（设置页「数据目录」那块用它，而不是在组件里硬编码文案） */
  readonly storageDriverName: string;
  readonly storageDescription: string;
  /** 当前平台真正可用的能力，界面据此禁用做不到的入口 */
  readonly platformId: string;
  readonly platformCapabilities: readonly string[];

  load(): Promise<void>;
  savePersona(persona: PersonaConfig): Promise<OperationResult>;
  /** 更新模型配置：非敏感字段落盘，Key 只留在内存 */
  updateModelConfig(patch: Partial<ModelConfig>): Promise<void>;
  /** 主动清掉内存里的 Key（用户点「清除」或在重置数据时调用） */
  clearApiKey(): void;
  testConnection(config: ModelConfig): Promise<OperationResult>;
  resetAll(): Promise<void>;
}

export type SettingsStore = UseBoundStore<StoreApi<SettingsState>>;

export function createSettingsStore(services: Services): SettingsStore {
  const settingsRepo = services.storage.settings;

  /**
   * 写入串行链。
   * -------------------------------------------------------------------------
   * 为什么需要它：落盘是异步的。用户点完「保存配置」马上又点「重置数据」时，
   * 如果两次写入并发，晚到的那次会把刚清掉的数据重新写回去 ——
   * 用户看到的是「重置成功了」但数据还在，这类 bug 极难复现。
   * 串行化之后，resetAll 只要排在这一串的最后，就一定赢。
   */
  let writeChain: Promise<unknown> = Promise.resolve();

  function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = writeChain.catch(() => undefined).then(task);
    writeChain = next.catch(() => undefined);
    return next;
  }

  /**
   * 把模型配置的「非敏感投影」写进设置。
   * 显式挑字段而不是展开整个对象 —— 少写一个 spread，就少一次把 Key 写进去的机会。
   */
  function persistModelProjection(model: ModelConfig): Promise<void> {
    return enqueueWrite(async () => {
      const current = await settingsRepo.getSettings();
      await settingsRepo.saveSettings({
        ...current,
        model: { apiUrl: model.apiUrl, modelName: model.modelName },
      });
    });
  }

  return create<SettingsState>((set, get) => ({
    settings: defaultSettings(),
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    loaded: false,

    storageDriverName: services.storage.driverName,
    storageDescription: services.storage.describeLocation(),
    platformId: services.platform.id,
    platformCapabilities: [...services.platform.capabilities],

    async load() {
      const settings = await settingsRepo.getSettings();
      set({
        settings,
        modelConfig: {
          // 地址和模型名从存储里恢复；Key 每次都是空的，这是设计，不是遗漏
          apiUrl: settings.model.apiUrl,
          modelName: settings.model.modelName,
          apiKey: '',
        },
        loaded: true,
      });
    },

    async savePersona(persona) {
      const validation = validatePersona(persona);
      if (!validation.ok) return validation;

      const next: AppSettings = {
        ...get().settings,
        persona: {
          assistantName: persona.assistantName.trim(),
          userName: persona.userName.trim(),
          systemPrompt: persona.systemPrompt.trim(),
        },
      };

      await enqueueWrite(async () => {
        const current = await settingsRepo.getSettings();
        // 在最新的存储内容上改人格，避免覆盖掉同时写进去的模型配置
        await settingsRepo.saveSettings({ ...current, persona: next.persona });
      });

      set({ settings: next });
      return { ok: true, message: '人格配置已保存并立即生效。' };
    },

    async updateModelConfig(patch) {
      const modelConfig: ModelConfig = { ...get().modelConfig, ...patch };
      // 先更新内存，界面立刻反映；再把非敏感部分落盘
      set({
        modelConfig,
        settings: {
          ...get().settings,
          model: { apiUrl: modelConfig.apiUrl, modelName: modelConfig.modelName },
        },
      });
      await persistModelProjection(modelConfig);
    },

    clearApiKey() {
      set({ modelConfig: { ...get().modelConfig, apiKey: '' } });
    },

    async testConnection(config) {
      // 委托给当前 provider。阶段 A 是 MockModelProvider，它不会发网络请求，
      // 返回的文案里会讲清楚这一点，不让用户误以为真的连通了。
      return services.model.testConnection(config);
    },

    async resetAll() {
      // 先把已经排队但还没落地的写入放完，再清库 —— 顺序反了就会被"复活"
      await writeChain.catch(() => undefined);
      await services.storage.reset();
      set({
        settings: defaultSettings(),
        modelConfig: { ...DEFAULT_MODEL_CONFIG },
      });
    },
  }));
}
