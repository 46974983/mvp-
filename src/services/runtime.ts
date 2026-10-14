/**
 * 运行环境探测
 * ----------------------------------------------------------------------------
 * 全应用只有这一个地方回答「我现在跑在哪」。
 * 三个服务层的切换点（storage / model / platform）都读它，避免各自判断、
 * 各自判断就容易出现「存储走了桌面版、模型还走浏览器版」这种半分裂状态。
 */

interface TauriGlobals {
  __TAURI_INTERNALS__?: unknown;
}

/**
 * 是否运行在 Tauri 桌面外壳里。
 *
 * 判据用 `__TAURI_INTERNALS__` 而不是 `__TAURI__`：
 * 后者只有在 tauri.conf.json 里开 `withGlobalTauri` 才存在，而我们的前端
 * 是通过 npm 包访问 Tauri API 的，没有开那个开关。
 */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as TauriGlobals).__TAURI_INTERNALS__ === 'object';
}

export type RuntimeKind = 'tauri' | 'browser';

export function runtimeKind(): RuntimeKind {
  return isTauriRuntime() ? 'tauri' : 'browser';
}
