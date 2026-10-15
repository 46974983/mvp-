import { describe, expect, it } from 'vitest';
import { createSettingsStore, DEFAULT_MODEL_CONFIG } from '@/features/settings/store';
import {
  createBrowserStorage,
  DEFAULT_CLOSE_TO_TRAY,
  DEFAULT_PERSONA,
  DEFAULT_FILE_DIRECTORY,
  DEFAULT_GLOBAL_SHORTCUT,
  DEFAULT_NOTIFY_ON_REPLY_COMPLETE,
} from '@/services/storage';
import type { StorageService } from '@/services/storage';
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

function setup(platform?: PlatformService, storage?: StorageService) {
  const webStorage = createMemoryStorage();
  const services = createTestServices({
    storage: storage ?? createBrowserStorage(webStorage),
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

// ---------------------------------------------------------------------------
// 通知设置（阶段 C）
// ---------------------------------------------------------------------------

/** 造一个「声称有通知能力」的平台，记下发出去的通知 */
function createNotifyingPlatform() {
  const base = createBrowserPlatformService();
  const sent: Array<{ title: string; body: string; force?: boolean }> = [];

  const platform: PlatformService = {
    ...base,
    id: 'fake-notify',
    probeCapabilities: async () => new Set<PlatformCapability>(['notification']),
    showNotification: async (request) => {
      sent.push(request);
      return { delivered: true, reason: '已发送。' };
    },
  };

  return { platform, sent };
}

describe('通知设置', () => {
  it('默认开启「回复完成时提醒我」', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().onReplyComplete).toBe(true);
    expect(DEFAULT_NOTIFY_ON_REPLY_COMPLETE).toBe(true);
  });

  it('可以关掉，并且落盘', async () => {
    const { store, webStorage } = setup();
    await store.getState().load();

    const result = await store.getState().setNotifyOnReplyComplete(false);

    expect(result.ok).toBe(true);
    expect(store.getState().onReplyComplete).toBe(false);
    // 内存里的设置结构要同步，否则设置页重渲染会跳回旧值
    expect(store.getState().settings.notification.onReplyComplete).toBe(false);
    // 而且是持久化的偏好，不只是内存
    await store.getState().load();
    expect(store.getState().onReplyComplete).toBe(false);
    expect(JSON.stringify(webStorage.raw())).toContain('onReplyComplete');
  });

  it('测试通知带 force —— 点按钮时窗口必然在前台，不强制就必然被跳过', async () => {
    const { platform, sent } = createNotifyingPlatform();
    const { store } = setup(platform);
    await store.getState().load();

    const outcome = await store.getState().sendTestNotification();

    expect(outcome.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.force).toBe(true);
    // 标题用人格里的助手名，正文说明这是一条测试
    expect(sent[0]?.title.length).toBeGreaterThan(0);
    expect(sent[0]?.body).toContain('测试通知');
  });

  it('环境不支持时，测试通知返回一句说明而不是抛错', async () => {
    const { store } = setup();
    await store.getState().load();

    const outcome = await store.getState().sendTestNotification();

    expect(outcome.delivered).toBe(false);
    expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it('浏览器模式探测不到通知能力时不显示为可用', async () => {
    const { store } = setup();
    await store.getState().load();

    // jsdom 没有 Notification API，所以能力集合里不该有它
    expect(store.getState().platformCapabilities).not.toContain('notification');
  });

  it('重置数据会把通知开关恢复到默认值', async () => {
    const { platform } = createNotifyingPlatform();
    const { store } = setup(platform);
    await store.getState().load();
    await store.getState().setNotifyOnReplyComplete(false);

    await store.getState().resetAll();

    expect(store.getState().onReplyComplete).toBe(DEFAULT_NOTIFY_ON_REPLY_COMPLETE);
  });
});

// ---------------------------------------------------------------------------
// 开机自启（阶段 C）
// ---------------------------------------------------------------------------

/** 造一个「声称有自启能力」的平台，并记录系统里的状态 */
function createAutostartPlatform(initial = false) {
  const base = createBrowserPlatformService();
  let enabled = initial;
  const calls: boolean[] = [];

  const platform: PlatformService = {
    ...base,
    id: 'fake-autostart',
    probeCapabilities: async () => new Set<PlatformCapability>(['autostart']),
    autostartStatus: async () => ({ enabled, exePath: 'D://demo//app.exe' }),
    setAutostart: async (next: boolean) => {
      calls.push(next);
      enabled = next;
      return { ok: true, message: next ? '已设置开机自启。' : '已关闭开机自启。' };
    },
  };

  return { platform, calls, current: () => enabled };
}

describe('开机自启', () => {
  it('浏览器模式探测不到自启能力，开关不可用', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().platformCapabilities).not.toContain('autostart');
    // 查询类方法如实返回事实，不抛错
    expect(store.getState().autostartEnabled).toBe(false);
  });

  it('状态来自系统，不来自我们的设置表', async () => {
    // 系统里已经开着，但我们的存储里没有任何相关记录
    const { platform } = createAutostartPlatform(true);
    const { store, webStorage } = setup(platform);

    await store.getState().load();

    expect(store.getState().autostartEnabled).toBe(true);
    expect(store.getState().autostartExePath).toContain('app.exe');
    // 关键：这个状态没有被写进本地存储 —— 系统才是权威
    expect(JSON.stringify(webStorage.raw())).not.toContain('autostart');
  });

  it('开启后会重新问一次系统，而不是假设操作生效了', async () => {
    const { platform, calls } = createAutostartPlatform(false);
    const { store } = setup(platform);
    await store.getState().load();

    const result = await store.getState().setAutostart(true);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([true]);
    expect(store.getState().autostartEnabled).toBe(true);
  });

  it('环境不支持时返回失败说明而不是抛错', async () => {
    const { store } = setup();
    await store.getState().load();

    const result = await store.getState().setAutostart(true);

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('重置本地数据不会关掉开机自启', async () => {
    const { platform, current } = createAutostartPlatform(true);
    const { store } = setup(platform);
    await store.getState().load();
    expect(store.getState().autostartEnabled).toBe(true);

    await store.getState().resetAll();

    // 自启属于系统设置，不在「本地数据」范围内
    expect(current()).toBe(true);
    expect(store.getState().autostartEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 全局快捷键（阶段 C）
// ---------------------------------------------------------------------------

/** 造一个「声称有全局快捷键能力」的平台，记录注册请求 */
function createShortcutPlatform() {
  const base = createBrowserPlatformService();
  const calls: Array<string | null> = [];
  let accelerator = '';
  let registered = false;

  const platform: PlatformService = {
    ...base,
    id: 'fake-shortcut',
    probeCapabilities: async () => new Set<PlatformCapability>(['global-shortcut']),
    globalShortcutStatus: async () => ({ accelerator, registered }),
    setGlobalShortcut: async (next: string | null) => {
      calls.push(next);

      // 模拟「键被别的程序占了」：**注册失败时什么都不会变** ——
      // 旧的还在，界面显示的也还是旧的。这正是真实行为该有的样子。
      if (next === 'CommandOrControl+Shift+9') {
        return { ok: false, message: '注册失败，这个组合键可能已被别的程序占用。' };
      }

      accelerator = next ?? '';
      registered = next !== null && next !== '';
      return { ok: true, message: '已注册。' };
    },
  };

  return {
    platform,
    calls,
    state: () => ({ accelerator, registered }),
    /** 模拟「重置时把系统里的注册一并撤销」（真实环境由 Rust 侧做） */
    forget: () => {
      accelerator = '';
      registered = false;
    },
  };
}

describe('全局快捷键', () => {
  it('默认不设 —— 抢系统唯一键位的事不默认开', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().globalShortcut).toBe('');
    expect(DEFAULT_GLOBAL_SHORTCUT).toBe('');
  });

  it('浏览器模式探测不到这个能力', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().platformCapabilities).not.toContain('global-shortcut');
  });

  it('设置成功后内存与存储同步', async () => {
    const { platform, state } = createShortcutPlatform();
    const { store } = setup(platform);
    await store.getState().load();

    const result = await store.getState().setGlobalShortcut('CommandOrControl+Shift+K');

    expect(result.ok).toBe(true);
    expect(state()).toEqual({ accelerator: 'CommandOrControl+Shift+K', registered: true });
    expect(store.getState().globalShortcut).toBe('CommandOrControl+Shift+K');
    expect(store.getState().globalShortcutRegistered).toBe(true);
    expect(store.getState().settings.shortcut.toggleWindow).toBe('CommandOrControl+Shift+K');
  });

  it('注册失败时界面不改 —— 不能显示一个看着像设好了其实没生效的键', async () => {
    const { platform, state } = createShortcutPlatform();
    const { store } = setup(platform);
    await store.getState().load();

    const result = await store.getState().setGlobalShortcut('CommandOrControl+Shift+9');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('占用');
    // 状态保持原样（原来没设，现在还是没设）
    expect(state()).toEqual({ accelerator: '', registered: false });
    expect(store.getState().globalShortcut).toBe('');
  });

  it('可以清除', async () => {
    const { platform, state } = createShortcutPlatform();
    const { store } = setup(platform);
    await store.getState().load();
    await store.getState().setGlobalShortcut('CommandOrControl+Shift+K');

    const result = await store.getState().setGlobalShortcut(null);

    expect(result.ok).toBe(true);
    expect(state()).toEqual({ accelerator: '', registered: false });
    expect(store.getState().globalShortcut).toBe('');
  });

  it('环境不支持时返回失败说明而不是抛错', async () => {
    const { store } = setup();
    await store.getState().load();

    const result = await store.getState().setGlobalShortcut('CommandOrControl+Shift+K');

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('重置本地数据会把快捷键撤掉，包括系统里那一份', async () => {
    const { platform, forget } = createShortcutPlatform();
    const webStorage = createMemoryStorage();
    const base = createBrowserStorage(webStorage);

    // 真实环境里 reset_all_data 会连带把系统里的注册撤销（Rust 侧做的），
    // 不做的话会出现「设置里没有这个键、实际却还生效」的漂移。这里跟着模拟。
    const storage: StorageService = {
      ...base,
      reset: async () => {
        await base.reset();
        forget();
      },
    };

    const { store } = setup(platform, storage);
    await store.getState().load();
    await store.getState().setGlobalShortcut('CommandOrControl+Shift+K');
    expect(store.getState().globalShortcutRegistered).toBe(true);

    await store.getState().resetAll();

    expect(store.getState().globalShortcut).toBe(DEFAULT_GLOBAL_SHORTCUT);
    expect(store.getState().globalShortcutRegistered).toBe(false);
    expect(store.getState().settings.shortcut.toggleWindow).toBe(DEFAULT_GLOBAL_SHORTCUT);
  });
});

// ---------------------------------------------------------------------------
// 本地文件（阶段 D）
// ---------------------------------------------------------------------------

/** 造一个「声称能读本地文件」的平台，带一个内存文件树 */
function createFilePlatform(
  tree: Record<string, string> = { 'a.txt': '内容' },
  options: { failAuthorize?: boolean } = {}
) {
  const base = createBrowserPlatformService();
  const reads: string[] = [];
  let directory = '';

  const platform: PlatformService = {
    ...base,
    id: 'fake-file',
    probeCapabilities: async () => new Set<PlatformCapability>(['file-read']),
    fileAccessStatus: async () => ({ directory, available: directory.length > 0 }),
    pickDirectory: async () => 'D:/笔记',
    authorizeDirectory: async (path: string) => {
      if (options.failAuthorize) {
        return { ok: false, message: '这个路径不是一个目录。' };
      }
      directory = path;
      return { ok: true, message: `已授权读取 ${path}。` };
    },
    revokeDirectory: async () => {
      directory = '';
      return { ok: true, message: '已撤销文件读取授权。' };
    },
    listAuthorizedDirectory: async (relativeDir: string) =>
      Object.keys(tree)
        .filter((key) => key.startsWith(relativeDir))
        .map((key) => ({
          relativePath: key,
          name: key.split('/').pop() ?? key,
          isDirectory: false,
          size: (tree[key] ?? '').length,
        })),
    readFile: async (relativePath: string) => {
      const content = tree[relativePath];
      if (content === undefined) throw new Error('读不到这个文件：系统找不到指定的文件。');
      reads.push(relativePath);
      return {
        relativePath,
        content,
        bytes: content.length,
        truncated: false,
      };
    },
    recentFileReads: async () => reads.map((path, index) => ({ relativePath: path, bytes: 2, at: index })),
  };

  return {
    platform,
    reads,
    current: () => directory,
    /** 模拟「重置时授权一并清掉」（真实环境由 Rust 侧的 reset_all_data 做） */
    forget: () => {
      directory = '';
      reads.length = 0;
    },
  };
}

describe('本地文件访问', () => {
  it('默认没有授权任何目录 —— 阶段 D 的能力默认关闭', async () => {
    const { store } = setup();
    await store.getState().load();

    expect(store.getState().fileAccessDirectory).toBe('');
    expect(store.getState().fileAccessAvailable).toBe(false);
    expect(store.getState().recentReads).toEqual([]);
    expect(DEFAULT_FILE_DIRECTORY).toBe('');
  });

  it('浏览器模式探测不到这个能力', async () => {
    const { store } = setup();
    await store.getState().load();
    expect(store.getState().platformCapabilities).not.toContain('file-read');
  });

  it('授权成功后界面才反映新范围', async () => {
    const { platform, current } = createFilePlatform();
    const { store } = setup(platform);
    await store.getState().load();

    const result = await store.getState().authorizeDirectory('D:/笔记');

    expect(result.ok).toBe(true);
    expect(current()).toBe('D:/笔记');
    expect(store.getState().fileAccessDirectory).toBe('D:/笔记');
    expect(store.getState().fileAccessAvailable).toBe(true);
  });

  it('授权失败时界面不改 —— 库里没存，界面就不能显示成已授权', async () => {
    const { platform, current } = createFilePlatform({}, { failAuthorize: true });
    const { store } = setup(platform);
    await store.getState().load();

    const result = await store.getState().authorizeDirectory('D:/不存在');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('不是一个目录');
    expect(current()).toBe('');
    expect(store.getState().fileAccessDirectory).toBe('');
  });

  it('撤销之后范围清空、读取记录也清掉', async () => {
    const { platform, current } = createFilePlatform();
    const { store } = setup(platform);
    await store.getState().load();
    await store.getState().authorizeDirectory('D:/笔记');
    await store.getState().readFile('a.txt');
    expect(store.getState().recentReads.length).toBeGreaterThan(0);

    const result = await store.getState().revokeDirectory();

    expect(result.ok).toBe(true);
    expect(current()).toBe('');
    expect(store.getState().fileAccessDirectory).toBe('');
    expect(store.getState().fileAccessAvailable).toBe(false);
    expect(store.getState().recentReads).toEqual([]);
  });

  it('读文件成功后刷新「最近读取」，让用户能回头看它读了什么', async () => {
    const { platform, reads } = createFilePlatform();
    const { store } = setup(platform);
    await store.getState().load();
    await store.getState().authorizeDirectory('D:/笔记');

    const content = await store.getState().readFile('a.txt');

    expect(content.content).toBe('内容');
    expect(reads).toEqual(['a.txt']);
    expect(store.getState().recentReads[0]?.relativePath).toBe('a.txt');
  });

  it('读文件失败会抛出可展示的一句话，而不是吞掉', async () => {
    const { platform } = createFilePlatform();
    const { store } = setup(platform);
    await store.getState().load();
    await store.getState().authorizeDirectory('D:/笔记');

    await expect(store.getState().readFile('没有这个.txt')).rejects.toThrow('读不到这个文件');
    // 失败的尝试不该进「最近读取」，否则那个列表会变得很嘈杂
    expect(store.getState().recentReads).toEqual([]);
  });

  it('环境不支持时授权返回失败说明而不是抛错', async () => {
    const { store } = setup();
    await store.getState().load();

    const result = await store.getState().authorizeDirectory('D:/笔记');

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('重置本地数据会清掉授权范围，之后读不到任何文件', async () => {
    const { platform, forget } = createFilePlatform();
    const base = createBrowserStorage(createMemoryStorage());

    // 真实环境里 reset_all_data 会把授权目录从库里删掉，之后 file_access_status 返回空。
    // 不模拟这一步的话，这条用例测的只是「前端会不会自己清」——
    // 而真正要保证的是「重置之后读不到任何东西」。
    const storage: StorageService = {
      ...base,
      reset: async () => {
        await base.reset();
        forget();
      },
    };

    const { store } = setup(platform, storage);
    await store.getState().load();
    await store.getState().authorizeDirectory('D:/笔记');

    await store.getState().resetAll();

    expect(store.getState().fileAccessDirectory).toBe(DEFAULT_FILE_DIRECTORY);
    expect(store.getState().fileAccessAvailable).toBe(false);
    expect(store.getState().recentReads).toEqual([]);
  });
});
