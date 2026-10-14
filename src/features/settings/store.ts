/**
 * 设置 store（Zustand）
 * ----------------------------------------------------------------------------
 * 三条约束写在这个文件最上面，它们是这个 store 存在的理由：
 *
 * 1. **API Key 前端不落盘。**
 *    浏览器模式：Key 只存在于内存，刷新即失效。
 *    桌面模式：Key 交给 Rust 侧存进 Windows 凭据管理器，前端只保留一个布尔值
 *    「是否已保存」，拿不到 Key 本身。
 *
 * 2. **非敏感配置照常持久化。** 地址、模型名、人格、窗口偏好都要记住。
 *
 * 3. **界面上的每一句「事实」都从服务层问来，不写死。**
 *    数据在哪、Key 在哪、有哪些能力可用 —— 同一份界面在两种运行环境下
 *    必须说不同的话，硬编码文案必然在其中一种里撒谎。
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
import type { PlatformCapability } from '@/services/platform';
import { DEFAULT_MODEL_ENDPOINT, defaultSettings } from '@/services/storage';
import { toUserFacingError } from '@/lib/log';
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

  // ---- 运行期探测出来的状态 ----
  /** 当前环境**真正可用**的平台能力（由服务层探测，不是写死的） */
  platformCapabilities: PlatformCapability[];
  /** 数据实际放在哪 */
  location: StorageLocation | null;
  /** 凭据存储是否可用（不可用是一种正常状态，界面当信息展示） */
  credentialStatus: OperationResult | null;
  /** 本机是否已经保存过 API Key */
  apiKeyStored: boolean;
  /** 关闭窗口时是否缩到托盘（桌面侧的权威值） */
  closeToTray: boolean;

  load(): Promise<void>;
  savePersona(persona: PersonaConfig): Promise<OperationResult>;
  /** 更新模型配置：非敏感字段落盘，Key 交给当前环境的凭据存储 */
  updateModelConfig(patch: Partial<ModelConfig>): Promise<void>;
  /** 清掉已保存的 API Key */
  clearApiKey(): Promise<void>;
  /** 修改「关闭窗口时缩到托盘」 */
  setCloseToTray(enabled: boolean): Promise<OperationResult>;
  /** 立即把窗口藏到托盘 */
  hideToTray(): Promise<OperationResult>;
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

  /** 探测能力集合。探测失败不该让设置页打不开，所以退化成空集合。 */
  async function probeCapabilities(): Promise<PlatformCapability[]> {
    try {
      return [...(await services.platform.probeCapabilities())];
    } catch {
      return [];
    }
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

    platformCapabilities: [],
    location: null,
    credentialStatus: null,
    apiKeyStored: false,
    closeToTray: defaultSettings().window.closeToTray,

    async load() {
      // 五件事互不依赖，并行拿。任何一件失败都不该让整个设置页打不开，
      // 所以「是否已存 Key」「位置」「凭据可用性」「能力集合」都各自兜底。
      const [settings, apiKeyStored, location, credentialStatus, capabilities] =
        await Promise.all([
          settingsRepo.getSettings(),
          settingsRepo.hasStoredApiKey().catch(() => false),
          services.storage.resolveLocation().catch(() => null),
          services.storage.probeCredentialStorage().catch(() => null),
          probeCapabilities(),
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
        platformCapabilities: capabilities,
        closeToTray: settings.window.closeToTray,
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

    async setCloseToTray(enabled) {
      // 持久化由平台实现负责：桌面侧必须同时写库和更新 Rust 的内存缓存
      // （关闭事件读的是内存），分两次写就会出现「保存成功但按关闭还是退出」。
      try {
        await services.platform.window.setCloseToTray(enabled);
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境不支持修改关闭行为。'),
        };
      }

      set({
        closeToTray: enabled,
        settings: { ...get().settings, window: { closeToTray: enabled } },
      });
      return {
        ok: true,
        message: enabled
          ? '关闭窗口时将缩到系统托盘，从托盘的「退出」才能真正结束应用。'
          : '关闭窗口时将直接退出应用。',
      };
    },

    async hideToTray() {
      try {
        await services.platform.window.hideToTray();
        return { ok: true, message: '已隐藏到托盘。双击托盘图标可以恢复窗口。' };
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境没有系统托盘。'),
        };
      }
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

      // 位置、凭据状态和能力集合重新探测一次（重置后可能变化）
      const [location, credentialStatus, capabilities] = await Promise.all([
        services.storage.resolveLocation().catch(() => null),
        services.storage.probeCredentialStorage().catch(() => null),
        probeCapabilities(),
      ]);

      const fresh = defaultSettings();
      set({
        settings: fresh,
        modelConfig: { ...DEFAULT_MODEL_CONFIG },
        apiKeyStored: false,
        location,
        credentialStatus,
        platformCapabilities: capabilities,
        closeToTray: fresh.window.closeToTray,
      });
    },
  }));
}
