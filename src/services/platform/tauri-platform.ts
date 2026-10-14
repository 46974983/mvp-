/**
 * 桌面平台实现（Tauri）
 * ----------------------------------------------------------------------------
 * 阶段 B 里这个实现的能力集合是空的，因为那时还没做原生能力。
 * 阶段 C 起，能力一项项接上来 —— 但**不是在这里声明**，而是问 Rust：
 * `platform_capabilities` 命令会如实回答「托盘到底建起来没有」。
 *
 * 这一点很关键：如果这里写死 `new Set(['tray'])`，那么托盘创建失败时
 * （图标缺失、系统限制……），前端仍然会显示「可用」，
 * 用户一点「隐藏到托盘」，窗口就消失且再也找不回来。
 *
 * 托盘本身完全在 Rust 侧建立与响应，前端只多拿到四条窄命令，
 * capabilities/default.json 里没有增加任何权限。
 */

import { invoke } from '@tauri-apps/api/core';

import type { OperationResult } from '@/types';
import {
  PLATFORM_CAPABILITIES,
  UnsupportedCapabilityError,
  type AutostartStatus,
  type GlobalShortcutStatus,
  type NotificationOutcome,
  type NotificationRequest,
  type PlatformCapability,
  type PlatformService,
} from './types';

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(PLATFORM_CAPABILITIES);

export function createTauriPlatformService(): PlatformService {
  function unsupported(capability: PlatformCapability): never {
    throw new UnsupportedCapabilityError(capability);
  }

  async function probeCapabilities(): Promise<ReadonlySet<PlatformCapability>> {
    const reported = await invoke<string[]>('platform_capabilities');
    // 过滤一遍：只认本版本认识的名字。
    // 这样以后 Rust 加了新能力、旧前端拿到不认识的名字也不会崩。
    return new Set(
      reported.filter((name): name is PlatformCapability => KNOWN_CAPABILITIES.has(name))
    );
  }

  return {
    id: 'tauri',

    probeCapabilities,

    window: {
      hideToTray: () => invoke<void>('hide_to_tray'),

      // 这个值由 Rust 从内存缓存直接回答，不查库 ——
      // 它是窗口关闭时要用的判断依据，必须和 Rust 侧看到的是同一份
      isCloseToTrayEnabled: () => invoke<boolean>('close_to_tray_enabled'),

      // 修改会同时写库和更新 Rust 的内存缓存，见 commands.rs 的说明
      setCloseToTray: (enabled: boolean) => invoke<void>('set_close_to_tray', { enabled }),
    },

    async readFile() {
      unsupported('file-read');
    },

    async takeScreenshot() {
      unsupported('screenshot');
    },

    async showNotification(request: NotificationRequest): Promise<NotificationOutcome> {
      // 走自己的窄命令，而不是插件的 JS API。
      // 关键原因是「窗口在前台就不打扰」这个判定只有 Rust 知道答案 ——
      // 前端拿不到窗口的可见性与焦点，硬做就得再加一条查询命令，
      // 而且把策略拆到两处，迟早会分叉。
      return invoke<NotificationOutcome>('notify', {
        title: request.title,
        body: request.body,
        force: request.force ?? false,
      });
    },

    async setAutostart(enabled: boolean): Promise<OperationResult> {
      // 自启状态不存我们的数据库：系统才是权威。
      // Rust 侧直接读写注册表并回报结果，前端不需要（也不该）记一份可能过期的副本。
      return invoke<OperationResult>('set_autostart', { enabled });
    },

    autostartStatus: () => invoke<AutostartStatus>('autostart_status'),

    globalShortcutStatus: () => invoke<GlobalShortcutStatus>('global_shortcut_status'),

    setGlobalShortcut: (accelerator: string | null) =>
      // 只有注册成功 Rust 才会落盘 —— 否则下次启动会拿同一个注定失败的键再试一遍。
      // 走自己的窄命令而不是插件的 JS API：注册结果、键位占用、合法性校验都在 Rust 侧一处处理。
      invoke<OperationResult>('set_global_shortcut', { accelerator }),
  };
}
