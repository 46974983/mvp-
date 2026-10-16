/**
 * 平台能力抽象（PlatformService）
 * ----------------------------------------------------------------------------
 * 对应技术方案第 3 节。规则很硬：
 *   「React 组件不得直接依赖 Rust、文件系统或具体 Tauri 插件。」
 * 所以读文件、截屏、发通知、托盘这些事，一律从这个接口走。
 *
 * 两个刻意的设计：
 *
 * 1. **能力清单是「探测」出来的，不是声明出来的。**
 *    `probeCapabilities()` 是异步的，因为桌面侧只有 Rust 知道托盘到底建起来没有。
 *    如果前端写死一份「托盘可用」，一旦托盘创建失败，用户点「隐藏到托盘」
 *    就会让窗口消失且再也找不回来。
 *
 * 2. **不可用的能力抛 UnsupportedCapabilityError，不静默失败、不返回假数据。**
 *    技术方案第 6 节要求高权限能力默认关闭、逐项开放。
 */

import type { OperationResult } from '@/types';

export const PLATFORM_CAPABILITIES = [
  'tray',
  'notification',
  'autostart',
  'global-shortcut',
  'file-read',
  'screenshot',
  'input-simulation',
] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export interface PlatformCapabilitySpec {
  /** 界面上的中文名 */
  label: string;
  /** 一句话说清这项能力是干什么的 */
  description: string;
  /** 技术方案第 6 节里排在哪一批 —— 界面用它解释「为什么现在还不能用」 */
  plannedStage: 'C' | 'D';
  /** 桌面侧是否已经接好。false 表示只是占位，还没实现 */
  desktopImplemented: boolean;
}

/**
 * 能力清单的唯一出处。
 * 界面文案、能力列表、以及「这项能力该由谁实现」都从这里读，
 * 避免同一个能力在三个地方各写一份说明、然后各说各的。
 */
export const PLATFORM_CAPABILITY_SPECS: Record<PlatformCapability, PlatformCapabilitySpec> = {
  tray: {
    label: '系统托盘',
    description: '托盘图标，以及把主窗口隐藏到托盘、从托盘恢复',
    plannedStage: 'C',
    desktopImplemented: true,
  },
  notification: {
    label: '系统通知',
    description: '回复生成完成时提醒你，窗口不在前台时才会发',
    plannedStage: 'C',
    desktopImplemented: true,
  },
  autostart: {
    label: '开机自启',
    description: '登录系统后自动启动，注册的是当前这个可执行文件的路径',
    plannedStage: 'C',
    desktopImplemented: true,
  },
  'global-shortcut': {
    label: '全局快捷键',
    description: '在任何程序里按一下就能唤起或收起主窗口',
    plannedStage: 'C',
    desktopImplemented: true,
  },
  'file-read': {
    label: '读取本地文件',
    description: '在设置页浏览、预览你显式授权的那一个文件夹里的文本文件；目前不会自动附加到聊天请求',
    plannedStage: 'D',
    desktopImplemented: true,
  },
  'input-simulation': {
    label: '键鼠模拟',
    description: '按你确认过的动作列表去操作鼠标键盘。默认关闭，每次执行前都要确认',
    plannedStage: 'D',
    desktopImplemented: true,
  },
  screenshot: {
    label: '截屏',
    description: '在设置页手动抓取并预览主屏画面；目前不会发给模型。默认关闭，需要你明确开启',
    plannedStage: 'D',
    desktopImplemented: true,
  },
};

/** 本平台不提供该能力时抛出。调用方可以据此展示「当前环境不支持」而不是笼统的失败。 */
export class UnsupportedCapabilityError extends Error {
  readonly capability: PlatformCapability;

  constructor(capability: PlatformCapability) {
    super(`当前运行环境不支持「${PLATFORM_CAPABILITY_SPECS[capability].label}」能力。`);
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
  }
}

/**
 * 开机自启的当前状态。
 *
 * `enabled` 永远来自**系统**（注册表 + 任务管理器里的启动项开关），
 * 不是我们自己的记录 —— 用户随时可能在任务管理器里把它关掉，
 * 我们存一份副本只会和系统对不上。
 */
export interface AutostartStatus {
  enabled: boolean;
  /**
   * 开启后会写进注册表的路径。
   *
   * 把它显示出来是为了让「注册的到底是哪个文件」这件事**可见**：
   * 把 exe 挪走之后自启会静默失效，而系统仍然认为它是开着的。
   * 开发模式下尤其要注意，那时注册的是 target/debug 下的路径。
   */
  exePath: string;
}

/**
 * 文件读取的授权状态。
 *
 * `directory` 是用户**显式授权**的一个目录，空串表示没有授权 ——
 * 那时应用的文件浏览功能一个字节也读不到（技术方案第 6 节第 3 项要求的「路径权限」）。
 */
export interface FileAccessStatus {
  directory: string;
  /** 这个目录现在还能不能打开。授权之后它可能被删掉或改名。 */
  available: boolean;
}

/** 授权目录里的一项 */
export interface FileEntry {
  /** 相对授权目录的路径 —— 请求读取时用的就是这个值，而不是绝对路径 */
  relativePath: string;
  name: string;
  isDirectory: boolean;
  /** 目录恒为 0 */
  size: number;
}

/**
 * 一个文件的内容。
 *
 * 比技术方案第 3 节写的 `Promise<string>` 多带了两个字段，
 * 因为「这份内容不完整」这件事必须能传出来 —— 否则用户会以为读到的是全文。
 */
export interface FileContent {
  relativePath: string;
  content: string;
  /** 文件在磁盘上的真实大小 */
  bytes: number;
  /** 是否因为超过上限被截断 */
  truncated: boolean;
}

/** 一次读取记录，用于回答「它读了我的什么」 */
export interface RecentRead {
  relativePath: string;
  bytes: number;
  /** 毫秒时间戳 */
  at: number;
}

/**
 * 一次截屏的结果。
 *
 * **图片只在内存里传递，不落盘。** `dataUrl` 可以直接放进 `<img src>`，
 * 用完就没了 —— 没有文件、没有路径、没有需要清理的残留。
 *
 * 这也解释了为什么返回的是 `dataUrl` 而不是文件路径：这个应用里
 * 「截图放哪儿」这个问题根本不存在，比事后去管临时文件的清理更简单也更安全。
 */
export interface Screenshot {
  /** PNG 的 data URL，只在内存里 */
  dataUrl: string;
  width: number;
  height: number;
  /** 编码后的字节数 */
  bytes: number;
  /** 截的是哪块屏 */
  monitor: string;
  /** 系统里一共有几块屏 —— 界面上要如实说明只截了主屏 */
  monitorCount: number;
  /** 毫秒时间戳 */
  capturedAt: number;
}

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * 一个自动化动作。
 *
 * **这是协议的全部，而且是刻意做窄的**：没有条件、没有循环、没有变量，
 * 也没有按键组合和拖拽。表达不出「重复执行」这件事，就不可能写出无限循环 ——
 * 这比「运行时检测到死循环再拦住」可靠得多。
 *
 * 协议与各项上限的理由写成了一篇文档：`docs/AUTOMATION_PROTOCOL.md`。
 * 加新动作要同时改协议、校验、上限、预览文案和测试。
 */
export type AutomationAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: MouseButton }
  /** 输入文字。**必须跟在一个 click 后面** —— 文字会打到当前有焦点的窗口上 */
  | { kind: 'type'; text: string }
  | { kind: 'wait'; ms: number };

/** 一步的执行结果 */
export interface AutomationStep {
  index: number;
  /** 人话描述 —— 和预览里看到的是同一句 */
  action: string;
  ok: boolean;
  detail: string;
}

/** 一次执行的报告 */
export interface AutomationReport {
  steps: AutomationStep[];
  /** 是否被用户中断（区别于「跑完了」和「超时了」） */
  stopped: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

/**
 * 全局快捷键的当前状态。
 *
 * `accelerator` 是用户设的值，`registered` 是**运行期的事实**。
 * 两者必须分开看：那个组合键可能已经被别的程序占了，注册没成功 ——
 * 界面上要能同时显示「你设的是这个」和「它现在没生效」，
 * 否则用户只会觉得「按了没反应」。
 */
export interface GlobalShortcutStatus {
  /** 用户设置的组合键，空串表示没设 */
  accelerator: string;
  /** 这个组合键当前是否真的注册成功 */
  registered: boolean;
}

/** 一条要发出去的通知 */
export interface NotificationRequest {
  title: string;
  body: string;
  /**
   * 强制发送，跳过「窗口正在前台就不打扰」的判断。
   *
   * 只有设置页的「发一条测试通知」该用它 —— 那时用户明确要求看到它，
   * 而窗口恰好就在前台，按普通规则必然被跳过，那样按钮看起来就是坏的。
   */
  force?: boolean;
}

/**
 * 一次通知投递的结果。
 *
 * 为什么是返回值而不是抛错：**「没发出去」不总是错误**。
 * 窗口在前台时跳过是正常行为，用户自己关掉了系统通知也是正常行为。
 * 当成错误的话，界面只能弹红色提示，而这里需要的是一句说明。
 */
export interface NotificationOutcome {
  delivered: boolean;
  /** 给人看的一句话。delivered 为 false 时说明原因 */
  reason: string;
}

/**
 * 主窗口的控制入口。
 *
 * 为什么单独成一块而不是把方法平铺在 PlatformService 上：
 * 托盘与窗口是**一回事**（窗口藏到哪、怎么回来），
 * 而且它们只在桌面环境里有意义，平铺会让接口看起来比实际能力大。
 */
export interface WindowController {
  /**
   * 把主窗口隐藏到系统托盘。
   * 调用之前必须确认 capabilities 里有 'tray'，否则会抛错。
   */
  hideToTray(): Promise<void>;

  /**
   * 关闭窗口时是否缩到托盘。
   *
   * 不支持该能力的环境返回 `false` 而不是抛错 —— 因为「关掉页面就是关掉」
   * 是个事实，不是失败。查询类方法报错只会让调用方多写一层无意义的 try。
   */
  isCloseToTrayEnabled(): Promise<boolean>;

  /**
   * 修改关闭行为。
   *
   * 约定：**桌面实现负责持久化**（写进 settings 表），
   * 因为它同时还要更新 Rust 侧的内存缓存 —— 关闭事件读的是内存，
   * 分两次写会出现「保存成功但按关闭还是退出」。
   */
  setCloseToTray(enabled: boolean): Promise<void>;
}

export interface PlatformService {
  /** 实现标识，例如 browser / tauri */
  readonly id: string;

  /** 探测当前环境下**真正可用**的能力集合 */
  probeCapabilities(): Promise<ReadonlySet<PlatformCapability>>;

  /** 主窗口控制（托盘、关闭行为） */
  readonly window: WindowController;

  /**
   * 查询文件读取的授权状态。
   *
   * 查询类方法在不支持的环境里返回事实（空目录、不可用），而不是抛错。
   */
  fileAccessStatus(): Promise<FileAccessStatus>;

  /**
   * 弹出系统的「选择文件夹」对话框，返回用户选的绝对路径；取消则返回 null。
   *
   * **这是用户表达授权意图的唯一入口。** 拿到路径还不算授权，
   * 要再调 `authorizeDirectory` 才生效 —— 中间那一步是给用户看清楚
   * 「将要授权哪个目录」的机会。
   */
  pickDirectory(): Promise<string | null>;

  /** 授权一个目录用于读取。传进来的必须是绝对路径，Rust 侧会校验并规范化。 */
  authorizeDirectory(path: string): Promise<OperationResult>;

  /** 撤销授权。撤销后立刻读不到任何文件。 */
  revokeDirectory(): Promise<OperationResult>;

  /** 列出授权目录里某一层的内容。`relativeDir` 为空表示目录本身。 */
  listAuthorizedDirectory(relativeDir: string): Promise<FileEntry[]>;

  /**
   * 读取授权目录里的一个文本文件。
   *
   * **参数是相对路径，不是绝对路径。** 这样前端连「指定别处」这件事
   * 都表达不出来，比「收绝对路径再检查范围」少一整类攻击面。
   * 另外路径上不允许经过符号链接 —— 那会绕过范围检查。
   */
  readFile(relativePath: string): Promise<FileContent>;

  /** 最近的读取记录，新的在前。只在内存里，不落盘。 */
  recentFileReads(): Promise<RecentRead[]>;

  /**
   * 开启 / 关闭键鼠模拟。
   *
   * 技术方案第 6 节要求高风险自动化能力**默认关闭**。
   * 这一项是全项目权限最重的：前面几项最坏是「看到了不该看的」，
   * 这一项能代替用户去操作别的程序。
   */
  setInputSimulationEnabled(enabled: boolean): Promise<OperationResult>;

  /**
   * 执行一个自动化任务。
   *
   * **Rust 侧会在动手之前把动作列表校验一遍**（数量、总时长、坐标范围、
   * 以及「输入动作之前必须有点击」），所以传错了不会出现「鼠标先动了一截再报错」。
   *
   * 返回执行报告；被中断和超时都会如实写在报告里。
   */
  runAutomation(actions: AutomationAction[]): Promise<AutomationReport>;

  /** 中断正在执行的自动化任务。最多延迟到当前这一步结束。 */
  stopAutomation(): Promise<void>;

  /** 最近一次执行报告。只在内存里。 */
  automationLastRun(): Promise<AutomationReport | null>;

  /**
   * 抓一张主屏截图。
   *
   * **Rust 侧会再检查一次开关**：没开启时直接拒绝，不管前端有没有把按钮禁掉。
   * 前端那个开关表达的是用户意图，不是权限 —— 命令是可以被直接调用的。
   */
  takeScreenshot(): Promise<Screenshot>;

  /**
   * 开启 / 关闭截屏能力。
   *
   * 技术方案第 6 节要求高风险自动化能力**默认关闭**，
   * 所以这个开关的默认值是 false，而不是「开着但提示一下」。
   */
  setScreenshotEnabled(enabled: boolean): Promise<OperationResult>;

  /**
   * 发一条系统通知。
   *
   * 能力本身不存在时（浏览器没有 Notification API）抛 UnsupportedCapabilityError；
   * 能力存在但这次没发出去（窗口在前台、系统没授权）返回 delivered=false ——
   * 前者是环境问题，后者是运行时状态，不该混为一谈。
   */
  showNotification(request: NotificationRequest): Promise<NotificationOutcome>;

  /**
   * 查询开机自启的状态。
   *
   * 查询类方法在不支持该能力的环境里返回事实（enabled: false、路径为空），
   * 而不是抛错 —— 和 `window.isCloseToTrayEnabled()` 同样的道理。
   */
  autostartStatus(): Promise<AutostartStatus>;

  /**
   * 开启或关闭开机自启。
   *
   * 返回结果而不是 void：写注册表可能失败（系统策略、权限），
   * 界面需要说清是哪种失败，而不是笼统地弹一个「操作失败」。
   */
  setAutostart(enabled: boolean): Promise<OperationResult>;

  /**
   * 查询全局快捷键的状态。
   *
   * 查询类方法在不支持的环境里返回事实（空串、未注册），而不是抛错。
   */
  globalShortcutStatus(): Promise<GlobalShortcutStatus>;

  /**
   * 设置全局快捷键；传 `null` 表示关闭。
   *
   * 返回结果而不是 void：这个组合键可能已被别的程序占用，
   * 那是**最需要讲清楚**的一种失败 —— 用户对「按了没反应」没有任何排查手段。
   */
  setGlobalShortcut(accelerator: string | null): Promise<OperationResult>;
}
