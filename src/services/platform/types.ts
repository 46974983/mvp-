/**
 * 平台能力抽象（PlatformService）
 * ----------------------------------------------------------------------------
 * 对应技术方案第 3 节。规则很硬：
 *   「React 组件不得直接依赖 Rust、文件系统或具体 Tauri 插件。」
 * 所以读文件、截屏、发通知、设开机启动这些事，一律从这个接口走。
 *
 * 阶段 A 的实现只有「发通知」是真能用的，其余能力会直接抛 UnsupportedCapabilityError。
 * 这是刻意的：宁可明确报「本阶段不支持」，也不要假装成功 —— 技术方案第 6 节要求
 * 高权限能力默认关闭、逐项开放。
 */

export const PLATFORM_CAPABILITIES = [
  'file-read',
  'screenshot',
  'notification',
  'autostart',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

/** 本平台不提供该能力时抛出。调用方可以据此展示「当前阶段不支持」而不是笼统的失败。 */
export class UnsupportedCapabilityError extends Error {
  readonly capability: PlatformCapability;

  constructor(capability: PlatformCapability) {
    super(`当前运行环境不支持「${capability}」能力。`);
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
  }
}

export interface PlatformService {
  /** 实现标识，例如 browser / tauri */
  readonly id: string;
  /** 当前环境下**真正可用**的能力集合 */
  readonly capabilities: ReadonlySet<PlatformCapability>;
  supports(capability: PlatformCapability): boolean;

  /** 读取本地文本文件。阶段 A 不可用。 */
  readFile(path: string): Promise<string>;
  /** 截屏，返回图片数据的引用。阶段 A 不可用。 */
  takeScreenshot(): Promise<string>;
  /** 发一条系统通知 */
  showNotification(text: string): Promise<void>;
  /** 开机自动启动。阶段 A 不可用。 */
  setAutostart(enabled: boolean): Promise<void>;
}
