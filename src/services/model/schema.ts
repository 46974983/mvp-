/**
 * 模型配置的校验规则（Zod）
 * ----------------------------------------------------------------------------
 * 放这一层而不是放表单里，是因为「什么算合法的模型配置」是模型层的领域规则，
 * 不是一个界面的规则。设置页用 zodResolver 复用同一份 schema，
 * MockModelProvider 的 testConnection 也复用同一份，
 * 保证「表单能保存的」和「能通过测试连接的」永远一致。
 */

import { z } from 'zod';
import type { ModelConfig, OperationResult } from '@/types';

/**
 * 必填文本：既挡空串，也挡「只输入了空格」。
 * 为什么两条都要：`min(1)` 拦不住 `'  '`（长度是 2），
 * 而用户完全可能不小心敲进两个空格然后以为填好了。
 */
function requiredText(message: string) {
  return z
    .string()
    .min(1, message)
    .refine((value) => value.trim().length > 0, message);
}

function parseApiUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

function hasEmbeddedCredential(url: URL): boolean {
  return (
    url.username.length > 0 ||
    url.password.length > 0 ||
    [...url.searchParams.keys()].some((name) => {
      const normalized = name.replace(/[_\-.]/g, '').toLowerCase();
      return (
        [
          'key',
          'apikey',
          'xapikey',
          'accesskey',
          'accesskeyid',
          'awsaccesskeyid',
          'token',
          'accesstoken',
          'refreshtoken',
          'securitytoken',
          'authorization',
          'auth',
          'credential',
          'credentials',
          'secret',
          'clientsecret',
          'password',
          'passphrase',
          'signature',
          'sig',
        ].includes(normalized) ||
        ['apikey', 'token', 'credential', 'secret', 'signature'].some((suffix) =>
          normalized.endsWith(suffix)
        )
      );
    })
  );
}

function usesSafeTransport(value: string): boolean {
  const url = parseApiUrl(value);
  if (!url || hasEmbeddedCredential(url) || url.href.includes('#')) return false;
  if (url.protocol === 'https:') return true;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === '::1') return true;

  const octets = hostname.split('.');
  return octets.length === 4 && Number(octets[0]) === 127 && octets.every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export const modelConfigSchema = z.object({
  apiUrl: requiredText('请填写 API 地址')
    .refine(
      (value) => parseApiUrl(value) !== null,
      'API 地址需要是包含主机名的完整 http:// 或 https:// 地址'
    )
    .refine(
      (value) => {
        const url = parseApiUrl(value);
        return url !== null && !hasEmbeddedCredential(url);
      },
      'API 地址不能包含用户名、密码、Key、token 或其他凭据，请把凭据填在 API Key 栏'
    )
    .refine(
      (value) => {
        const url = parseApiUrl(value);
        return url !== null && !url.href.includes('#');
      },
      'API 地址不能包含片段（# 后面的内容），请填写服务地址本身'
    )
    .refine(
      usesSafeTransport,
      '为避免 API Key 明文传输，HTTP 只允许本机地址；远程服务请使用 HTTPS'
    ),
  apiKey: requiredText('请填写 API Key').refine(
    (value) => value.trim().length >= 8,
    'API Key 看起来太短了，请检查是否复制完整'
  ),
  modelName: requiredText('请填写模型名称').refine(
    (value) => !/\s/.test(value.trim()),
    '模型名称里不应包含空格'
  ),
  // 纯声明，不校验 —— 我们没法从模型名可靠地判断它支不支持图片，
  // 所以这一项由用户说了算，默认 false
  supportsVision: z.boolean(),
});

/**
 * 桌面端已有凭据时，空 Key 表示「沿用已保存的那一份」。
 * 新填的 Key 仍然要经过同样的最小长度校验；浏览器模式没有已保存凭据，
 * 继续使用严格 schema。
 */
export function modelConfigSchemaForStoredKey(apiKeyStored: boolean) {
  if (!apiKeyStored) return modelConfigSchema;

  return modelConfigSchema.extend({
    apiKey: z
      .string()
      .refine(
        (value) => value.trim().length === 0 || value.trim().length >= 8,
        'API Key 看起来太短了，请检查是否复制完整'
      ),
  });
}

export type ModelConfigForm = z.infer<typeof modelConfigSchema>;

/**
 * 把 Zod 的校验结果压成一句面向用户的话。
 * 校验失败时只取第一条错误 —— 用户一次只需要修一个问题。
 */
export function validateModelConfig(config: ModelConfig): OperationResult {
  const parsed = modelConfigSchema.safeParse(config);
  if (parsed.success) {
    if (config.apiKey.trim().length === 0) {
      return { ok: false, message: '请填写 API Key' };
    }
    return { ok: true, message: '配置校验通过。' };
  }
  const first = parsed.error.issues[0];
  return { ok: false, message: first?.message ?? '配置校验未通过，请检查填写内容。' };
}
