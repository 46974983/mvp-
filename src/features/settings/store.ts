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
import type {
  FileContent,
  FileEntry,
  NotificationOutcome,
  PlatformCapability,
  RecentRead,
  Screenshot,
} from '@/services/platform';
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
  /** 回复生成完成时是否发系统通知 */
  onReplyComplete: boolean;
  /** 开机自启是否已开启（值来自系统，不是我们的记录） */
  autostartEnabled: boolean;
  /** 开启自启后会写进注册表的路径 —— 显示出来，让「注册的是哪个文件」可见 */
  autostartExePath: string;
  /** 用户设置的全局快捷键（空串表示没设） */
  globalShortcut: string;
  /** 这个快捷键当前是否真的注册成功。可能为 false —— 组合键被别的程序占了 */
  globalShortcutRegistered: boolean;
  /**
   * 已授权的读取目录（空串表示没有授权，那时一个字节也读不到）。
   * 阶段 D 的「路径权限」就是这个值。
   */
  fileAccessDirectory: string;
  /** 这个目录现在还能不能打开（授权之后可能被删掉或改名） */
  fileAccessAvailable: boolean;
  /** 最近的读取记录。回答「它刚才读了我的什么」—— 只在内存里，不落盘。 */
  recentReads: RecentRead[];
  /**
   * 截屏能力是否开启。**默认关闭**（技术方案第 6 节要求高风险能力默认关闭）。
   * 这个值表达的是用户意图；真正的门在 Rust 侧。
   */
  screenshotEnabled: boolean;
  /** 最近一次截屏。**只在内存里**，关掉能力时一并丢弃。 */
  lastScreenshot: Screenshot | null;

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
  /** 修改「回复完成时发通知」 */
  setNotifyOnReplyComplete(enabled: boolean): Promise<OperationResult>;
  /** 发一条测试通知。跳过打扰判定 —— 用户明确要求看到它。 */
  sendTestNotification(): Promise<NotificationOutcome>;
  /** 开启 / 关闭开机自启 */
  setAutostart(enabled: boolean): Promise<OperationResult>;
  /** 设置全局快捷键；传 null 关闭 */
  setGlobalShortcut(accelerator: string | null): Promise<OperationResult>;
  /** 弹出系统目录选择框；用户取消返回 null */
  pickDirectory(): Promise<string | null>;
  /** 授权一个目录用于读取 */
  authorizeDirectory(path: string): Promise<OperationResult>;
  /** 撤销文件读取授权 */
  revokeDirectory(): Promise<OperationResult>;
  /** 读取授权目录里的一个文本文件（相对路径）。失败时抛出一句可展示的话。 */
  readFile(relativePath: string): Promise<FileContent>;
  /** 列出授权目录里某一层的内容。`relativeDir` 为空表示目录本身。 */
  listAuthorizedDirectory(relativeDir: string): Promise<FileEntry[]>;
  /** 刷新「最近读取」列表 */
  refreshRecentReads(): Promise<void>;
  /** 开启 / 关闭截屏能力 */
  setScreenshotEnabled(enabled: boolean): Promise<OperationResult>;
  /** 抓一张主屏截图（只在内存里，不落盘）。失败时抛出一句可展示的话。 */
  takeScreenshot(): Promise<Screenshot>;
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
    onReplyComplete: defaultSettings().notification.onReplyComplete,
    autostartEnabled: false,
    autostartExePath: '',
    globalShortcut: defaultSettings().shortcut.toggleWindow,
    globalShortcutRegistered: false,
    fileAccessDirectory: defaultSettings().fileAccess.directory,
    fileAccessAvailable: false,
    recentReads: [],
    screenshotEnabled: defaultSettings().permission.screenshot,
    lastScreenshot: null,

    async load() {
      // 五件事互不依赖，并行拿。任何一件失败都不该让整个设置页打不开，
      // 所以「是否已存 Key」「位置」「凭据可用性」「能力集合」都各自兜底。
      const [
        settings,
        apiKeyStored,
        location,
        credentialStatus,
        capabilities,
        autostart,
        shortcut,
        fileAccess,
      ] = await Promise.all([
        settingsRepo.getSettings(),
        settingsRepo.hasStoredApiKey().catch(() => false),
        services.storage.resolveLocation().catch(() => null),
        services.storage.probeCredentialStorage().catch(() => null),
        probeCapabilities(),
        // 自启状态问系统，不读我们的设置表 —— 用户可能在任务管理器里改过
        services.platform.autostartStatus().catch(() => null),
        // 快捷键的「值」存在我们这儿，「注册上没有」只有运行期知道，所以两者都要问
        services.platform.globalShortcutStatus().catch(() => null),
        // 授权的目录可能在授权之后被删掉或改名，所以要真的去看一眼还在不在
        services.platform.fileAccessStatus().catch(() => null),
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
        onReplyComplete: settings.notification.onReplyComplete,
        autostartEnabled: autostart?.enabled ?? false,
        autostartExePath: autostart?.exePath ?? '',
        // 值以设置表为准，注册与否以运行期为准
        globalShortcut: settings.shortcut.toggleWindow,
        globalShortcutRegistered: shortcut?.registered ?? false,
        // 授权目录以运行期报告为准：库里存着但目录没了，要如实显示为不可用
        fileAccessDirectory: fileAccess?.directory ?? settings.fileAccess.directory,
        fileAccessAvailable: fileAccess?.available ?? false,
        recentReads: await services.platform.recentFileReads().catch(() => []),
        // 开关值只有我们这儿有，没有别的权威来源
        screenshotEnabled: settings.permission.screenshot,
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

      try {
        await enqueueWrite(() => settingsRepo.saveSettings(next));
        set({ settings: next });
        return { ok: true, message: '人格配置已保存并立即生效。' };
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '保存人格配置失败，请重试。'),
        };
      }
    },

    async updateModelConfig(patch) {
      const modelConfig: ModelConfig = { ...get().modelConfig, ...patch };

      try {
        await enqueueWrite(() => settingsRepo.saveModelConfig(modelConfig));
      } catch (error) {
        // 凭据存储与 SQLite 无法组成同一个事务，Key 可能已保存而模型设置写入失败。
        const apiKeyStored = await settingsRepo
          .hasStoredApiKey()
          .catch(() => get().apiKeyStored);
        set({ apiKeyStored });
        throw error;
      }

      // 保存完再确认一次凭据状态：桌面模式下用户可能刚把 Key 填进去
      const apiKeyStored = await settingsRepo
        .hasStoredApiKey()
        .catch(() => get().apiKeyStored);
      set({
        modelConfig,
        settings: {
          ...get().settings,
          model: { apiUrl: modelConfig.apiUrl, modelName: modelConfig.modelName },
        },
        apiKeyStored,
      });
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

    async setNotifyOnReplyComplete(enabled) {
      // 这一项是纯前端偏好（要不要通知由 chat store 判断），
      // 和 closeToTray 不同 —— 那个必须同时改 Rust 的内存缓存，所以由平台层负责持久化。
      const next: AppSettings = {
        ...get().settings,
        notification: { onReplyComplete: enabled },
      };

      try {
        await enqueueWrite(() => settingsRepo.saveSettings(next));
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '保存通知设置失败，请重试。'),
        };
      }
      set({ settings: next, onReplyComplete: enabled });

      return {
        ok: true,
        message: enabled
          ? '回复生成完成时会发系统通知；窗口正在前台时不会打扰你。'
          : '已关闭回复完成通知。',
      };
    },

    async sendTestNotification() {
      try {
        return await services.platform.showNotification({
          title: get().settings.persona.assistantName,
          body: '这是一条测试通知。能看到它，说明系统通知已经接通。',
          // 用户明确点了按钮，此时窗口必然在前台 —— 不跳过的话按钮看起来就是坏的
          force: true,
        });
      } catch (error) {
        return {
          delivered: false,
          reason: toUserFacingError(error, '当前运行环境不支持系统通知。'),
        };
      }
    },

    async setGlobalShortcut(accelerator) {
      let result: OperationResult;
      try {
        result = await services.platform.setGlobalShortcut(accelerator);
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境不支持全局快捷键。'),
        };
      }

      // 只有成功才更新内存：失败时 Rust 侧没有落盘、旧键也还生效，
      // 界面跟着改就会显示一个「看着像设好了、其实没生效」的快捷键。
      if (result.ok) {
        const status = await services.platform.globalShortcutStatus().catch(() => null);
        const next = status?.accelerator ?? accelerator ?? '';
        set({
          globalShortcut: next,
          globalShortcutRegistered: status?.registered ?? false,
          settings: { ...get().settings, shortcut: { toggleWindow: next } },
        });
      }

      return result;
    },

    async setAutostart(enabled) {
      let result: OperationResult;
      try {
        result = await services.platform.setAutostart(enabled);
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境不支持开机自启。'),
        };
      }

      if (result.ok) {
        // 重新问一次系统，而不是假设刚才的操作生效了。
        // 注册表写入有可能被系统策略挡下却不报错，那样界面就会显示一个假的开关状态。
        const status = await services.platform.autostartStatus().catch(() => null);
        set({
          autostartEnabled: status?.enabled ?? get().autostartEnabled,
          autostartExePath: status?.exePath ?? get().autostartExePath,
        });
      }

      return result;
    },

    async pickDirectory() {
      return services.platform.pickDirectory();
    },

    async authorizeDirectory(path) {
      let result: OperationResult;
      try {
        result = await services.platform.authorizeDirectory(path);
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境不支持读取本地文件。'),
        };
      }

      // 只有成功才更新界面：失败时 Rust 侧没有落盘，界面跟着变会显示一个假的授权范围
      if (result.ok) {
        const status = await services.platform.fileAccessStatus().catch(() => null);
        set({
          fileAccessDirectory: status?.directory ?? path,
          fileAccessAvailable: status?.available ?? true,
          // 换目录时 Rust 会清掉旧的读取记录，这里跟着清，两边保持一致
          recentReads: [],
        });
      }

      return result;
    },

    async revokeDirectory() {
      let result: OperationResult;
      try {
        result = await services.platform.revokeDirectory();
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境不支持读取本地文件。'),
        };
      }

      if (result.ok) {
        set({ fileAccessDirectory: '', fileAccessAvailable: false, recentReads: [] });
      }

      return result;
    },

    async readFile(relativePath) {
      // 读文件是「取数据」而不是「做动作」，所以失败直接抛 —— 让调用方决定怎么展示。
      // 不像上面几个动作那样返回 OperationResult，是因为文件内容本身要传回去。
      const content = await services.platform.readFile(relativePath);
      await get().refreshRecentReads();
      return content;
    },

    async listAuthorizedDirectory(relativeDir) {
      return services.platform.listAuthorizedDirectory(relativeDir);
    },

    async refreshRecentReads() {
      const recent = await services.platform.recentFileReads().catch(() => []);
      set({ recentReads: recent });
    },

    async setScreenshotEnabled(enabled) {
      let result: OperationResult;
      try {
        result = await services.platform.setScreenshotEnabled(enabled);
      } catch (error) {
        return {
          ok: false,
          message: toUserFacingError(error, '当前运行环境不支持截屏。'),
        };
      }

      if (result.ok) {
        set({
          screenshotEnabled: enabled,
          settings: { ...get().settings, permission: { screenshot: enabled } },
          // 关掉能力时把上一次的画面一并丢掉：能力都关了，
        // 还留着一张屏幕快照在内存里没有道理，而且它是最敏感的那份数据。
          ...(enabled ? {} : { lastScreenshot: null }),
        });
      }

      return result;
    },

    async takeScreenshot() {
      // 和读文件一样：这是「取数据」，失败直接抛，由调用方决定怎么展示
      const shot = await services.platform.takeScreenshot();
      set({ lastScreenshot: shot });
      return shot;
    },

    async testConnection(config) {
      // 委托给当前 provider。浏览器模式下的离线实现不会发网络请求，
      // 返回的文案里会讲清楚这一点，不让用户误以为真的连通了。
      return services.model.testConnection(config);
    },

    async resetAll() {
      // 先把排队中的写入放完，再清库 —— 顺序反了就会被"复活"
      await writeChain.catch(() => undefined);
      let resetError: unknown = null;
      try {
        await services.storage.reset();
      } catch (error) {
        // Rust 可能已清掉 SQLite、随后才在凭据管理器上失败。
        // 无论结果如何都重新读取权威状态，避免界面留在「已重置前」的旧快照。
        resetError = error;
      }

      // 位置、凭据状态、能力集合和自启状态都重新探测一次（重置后可能变化）
      const [
        persistedSettings,
        apiKeyStored,
        location,
        credentialStatus,
        capabilities,
        autostart,
        shortcut,
        fileAccess,
        recentReads,
      ] =
        await Promise.all([
          settingsRepo.getSettings().catch(() => defaultSettings()),
          settingsRepo.hasStoredApiKey().catch(() => false),
          services.storage.resolveLocation().catch(() => null),
          services.storage.probeCredentialStorage().catch(() => null),
          probeCapabilities(),
          // 自启属于系统设置，重置本地数据**不会**动它，这里只是把真实状态再读一遍
          services.platform.autostartStatus().catch(() => null),
          // 快捷键会被重置清掉，但系统里注册的那个还在，所以要重新问一次
          services.platform.globalShortcutStatus().catch(() => null),
          // 授权范围属于本地数据，重置会清掉
          services.platform.fileAccessStatus().catch(() => null),
          services.platform.recentFileReads().catch(() => []),
        ]);

      set({
        settings: persistedSettings,
        modelConfig: {
          apiUrl: persistedSettings.model.apiUrl,
          modelName: persistedSettings.model.modelName,
          apiKey: '',
        },
        apiKeyStored,
        location,
        credentialStatus,
        platformCapabilities: capabilities,
        closeToTray: persistedSettings.window.closeToTray,
        onReplyComplete: persistedSettings.notification.onReplyComplete,
        autostartEnabled: autostart?.enabled ?? get().autostartEnabled,
        autostartExePath: autostart?.exePath ?? get().autostartExePath,
        globalShortcut: shortcut?.accelerator ?? persistedSettings.shortcut.toggleWindow,
        globalShortcutRegistered: shortcut?.registered ?? false,
        fileAccessDirectory: fileAccess?.directory ?? persistedSettings.fileAccess.directory,
        fileAccessAvailable: fileAccess?.available ?? false,
        recentReads,
        screenshotEnabled: persistedSettings.permission.screenshot,
        lastScreenshot: null,
      });

      if (resetError !== null) throw resetError;
    },
  }));
}
