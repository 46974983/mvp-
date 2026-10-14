/**
 * 日志出口
 * ----------------------------------------------------------------------------
 * 全应用的 console 调用都从这里走。存在的唯一理由是：强制脱敏。
 * 直接 console.error(error) 有把 API Key 打进控制台的风险（比如请求对象被带出来），
 * 走这里就不会。
 */

import { redactSensitive } from './redact';

function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  scope: string,
  message: string,
  detail?: unknown
): void {
  const line = `[${scope}] ${redactSensitive(message)}`;
  if (detail === undefined) {
    console[level](line);
    return;
  }
  // 只取 Error 的 message，不带 stack 之外的额外字段，避免整个 config 对象被打印出来
  const rendered = detail instanceof Error ? detail.message : String(detail);
  console[level](line, redactSensitive(rendered));
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, detail?: unknown) => emit('debug', scope, message, detail),
    info: (message: string, detail?: unknown) => emit('info', scope, message, detail),
    warn: (message: string, detail?: unknown) => emit('warn', scope, message, detail),
    error: (message: string, detail?: unknown) => emit('error', scope, message, detail),
  };
}

/**
 * 把任意异常转成一句能展示给用户的话，顺带脱敏。
 *
 * 为什么要单独认字符串：桌面版（Tauri）的命令失败时，Promise 是被一个
 * **字符串**拒绝的，而不是 Error。只判断 `instanceof Error` 会把 Rust 侧
 * 精心写好的中文提示丢掉，换成一句笼统的兜底文案 —— 那等于白写。
 */
export function toUserFacingError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return redactSensitive(error.message);
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return redactSensitive(error);
  }
  return fallback;
}
