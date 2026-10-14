/**
 * 设置 store（Zustand）
 * ----------------------------------------------------------------------------
 * 两条约束写在这个文件最上面，它们是这个 store 存在的理由：
 *
 * 1. **API Key 前端不落盘。**
 *    浏览器模式：Key 只存在于内存，刷新即失效。
 *    桌面模式：Key 交给 Rust 侧存进 Windows 凭据管理器，前端只保留一个布尔值
 *    「是否已保存」，拿不到 Key 本身。
 *    两种模式的差别通过 `credentialStorage` 如实告诉界面，而不是让界面去猜
 *    自己现在跑在哪。
 *
 * 2. **非敏感配置照常持久化。**
 *    产品设计 3.2 要求「保存本地配置」，技术方案只禁止 Key 落盘。
 *    所以地址和模型名会存下来，刷新之后不用重填。
 *
 * 另外：写入走一条串行链。落盘是异步的，用户点完「保存配置」立刻点「重置数据」时，
 * 晚到的那次写入会把刚清掉的数据写回去 —— 这类 bug 极难复现，所以从结构上避免它。
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  AppSettings,
  CredentialStorageInfo,
  ModelConfig,
  OperationResult,
  PersonaConfig,
  StorageLocation,
} from '@/types';
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
  /** 内存态模型配置，其中 apiKey 是否会落盘取决于当前运行环境 */
  modelConfig: ModelConfig;
  loaded: boolean;

  // ---- 只读的环境信息：由服务层注入，界面不需要自己判断跑在哪 ----
  readonly driverName: string;
  readonly credentialStorage: CredentialStorageInfo;
  readonly providerLabel: string;
  /** 当前 provider 是否会真的发起网络请求 */
  readonly performsNetworkRequest: boolean;
  readonly platformId: string;
  readonly platformCapabilities: readonly string[];

  // ---- 运行期解析出来的状态 ----
  /** 数据实际放在哪 */
  location: StorageLocation | null;
  /** 凭据存储是否可用（不可用是一种正常状态，界面当信息展示） */
  credentialStatus: OperationResult | null;
  /** 本机是否已经保存过 API Key */
  apiKeyStored: boolean;

  load(): Promise<void>;
  savePersona(persona: PersonaConfig): Promise<OperationResult>;
  /** 更新模型配置：非敏感字段落盘，Key 交给当前环境的凭据存储 */
  updateModelConfig(patch: Partial<ModelConfig>): Promise<void>;
  /** 清掉已保存的 API Key */
  clearApiKey(): Promise<void>;
  testConnection(config: ModelConfig): Promise<OperationResult>;
  resetAll(): Promise<void>;
}

export type SettingsStore = UseBoundStore<StoreApi<SettingsState>>;

export function createSettingsStore(services: Services): SettingsStore {
  const settingsRepo = services.storage.settings;

  /** 写入串行链，见文件头的说明 */
  let writeChain: Promise<unknown> = Promise.resolve();

  function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = writeChain.catch(() => undefined).then(task);
    writeChain = next.catch(() => undefined);
    return next;
  }

  return create<SettingsState>((set, get) => ({
    settings: defaultSettings(),
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    loaded: false,

    driverName: services.storage.driverName,
    credentialStorage: services.storage.credentialStorage,
    providerLabel: services.model.label,
    performsNetworkRequest: services.model.performsNetworkRequest,
    platformId: services.platform.id,
    platformCapabilities: [...services.platform.capabilities],

    location: null,
    credentialStatus: null,
    apiKeyStored: false,

    async load() {
      // 四件事互不依赖，并行拿。任何一件失败都不该让整个设置页打不开，
      // 所以「是否已存 Key」「位置」「凭据可用性」都各自兜底。
      const [settings, apiKeyStored, location, credentialStatus] = await Promise.all([
        settingsRepo.getSettings(),
        settingsRepo.hasStoredApiKey().catch(() => false),
        services.storage.resolveLocation().catch(() => null),
        services.storage.probeCredentialStorage().catch(() => null),
      ]);

      set({
        settings,
        modelConfig: {
          // 地址和模型名从存储恢复；Key 是否还在，由 apiKeyStored 表达，
          // 前端永远不持有它（桌面模式下它躺在系统凭据管理器里）
          apiUrl: settings.model.apiUrl,
          modelName: settings.model.modelName,
          apiKey: '',
        },
        loaded: true,
        apiKeyStored,
        location,
        credentialStatus,
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

      await enqueueWrite(() => settingsRepo.saveSettings(next));
      set({ settings: next });
      return { ok: true, message: '人格配置已保存并立即生效。' };
    },

    async updateModelConfig(patch) {
      const modelConfig: ModelConfig = { ...get().modelConfig, ...patch };

      // 先更新内存，界面立刻反映；再交给存储层处理（它会决定 Key 去哪）
      set({
        modelConfig,
        settings: {
          ...get().settings,
          model: { apiUrl: modelConfig.apiUrl, modelName: modelConfig.modelName },
        },
      });

      await enqueueWrite(() => settingsRepo.saveModelConfig(modelConfig));

      // 保存完再确认一次凭据状态：桌面模式下用户可能刚把 Key 填进去
      const apiKeyStored = await settingsRepo
        .hasStoredApiKey()
        .catch(() => get().apiKeyStored);
      set({ apiKeyStored });
    },

    async clearApiKey() {
      await enqueueWrite(() => settingsRepo.clearStoredApiKey());
      set({
        modelConfig: { ...get().modelConfig, apiKey: '' },
        apiKeyStored: false,
      });
    },

    async testConnection(config) {
      // 委托给当前 provider。浏览器模式下的离线实现不会发网络请求，
      // 返回的文案里会讲清楚这一点，不让用户误以为真的连通了。
      return services.model.testConnection(config);
    },

    async resetAll() {
      // 先把排队中的写入放完，再清库 —— 顺序反了就会被"复活"
      await writeChain.catch(() => undefined);
      await services.storage.reset();

      // 位置和凭据状态重新探测一次（重置后可能变化）
      const [location, credentialStatus] = await Promise.all([
        services.storage.resolveLocation().catch(() => null),
        services.storage.probeCredentialStorage().catch(() => null),
      ]);

      set({
        settings: defaultSettings(),
        modelConfig: { ...DEFAULT_MODEL_CONFIG },
        apiKeyStored: false,
        location,
        credentialStatus,
      });
    },
  }));
}
