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

export const modelConfigSchema = z.object({
  apiUrl: requiredText('请填写 API 地址')
    .refine(
      (value) => /^https?:\/\//i.test(value.trim()),
      'API 地址需要以 http:// 或 https:// 开头'
    )
    .refine(
      (value) => value.trim().length > 'https://'.length,
      'API 地址不完整，请补上服务域名和路径'
    ),
  apiKey: requiredText('请填写 API Key').refine(
    (value) => value.trim().length >= 8,
    'API Key 看起来太短了，请检查是否复制完整'
  ),
  modelName: requiredText('请填写模型名称').refine(
    (value) => !/\s/.test(value.trim()),
    '模型名称里不应包含空格'
  ),
});

export type ModelConfigForm = z.infer<typeof modelConfigSchema>;

/**
 * 把 Zod 的校验结果压成一句面向用户的话。
 * 校验失败时只取第一条错误 —— 用户一次只需要修一个问题。
 */
export function validateModelConfig(config: ModelConfig): OperationResult {
  const parsed = modelConfigSchema.safeParse(config);
  if (parsed.success) {
    return { ok: true, message: '配置校验通过。' };
  }
  const first = parsed.error.issues[0];
  return { ok: false, message: first?.message ?? '配置校验未通过，请检查填写内容。' };
}
