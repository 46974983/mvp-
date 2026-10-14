/**
 * 人格配置的校验规则（Zod）
 * ----------------------------------------------------------------------------
 * 和技术方案第 4 节一致：表单统一走 React Hook Form + Zod，
 * 错误信息落在字段附近，不把底层异常直接抛给用户。
 */

import { z } from 'zod';
import type { PersonaConfig } from '@/types';

/**
 * 必填文本：空串和「只输入了空格」都算没填。
 * `min(1)` 挡不住 `'  '`（长度是 2），所以要额外判一次 trim。
 */
function requiredText(message: string) {
  return z
    .string()
    .min(1, message)
    .refine((value) => value.trim().length > 0, message);
}

export const personaSchema = z.object({
  assistantName: requiredText('请填写助手名称').refine(
    (value) => value.trim().length <= 16,
    '助手名称不要超过 16 个字'
  ),
  userName: requiredText('请填写你的称呼').refine(
    (value) => value.trim().length <= 16,
    '称呼不要超过 16 个字'
  ),
  systemPrompt: requiredText('请填写系统提示词').refine(
    (value) => value.trim().length <= 4000,
    '系统提示词不要超过 4000 个字'
  ),
});

export type PersonaForm = z.infer<typeof personaSchema>;

/** 校验并把结果压成一句话，供 store 与 UI 复用 */
export function validatePersona(persona: PersonaConfig): {
  ok: boolean;
  message: string;
} {
  const parsed = personaSchema.safeParse(persona);
  if (parsed.success) return { ok: true, message: '人格配置已生效。' };
  const first = parsed.error.issues[0];
  return { ok: false, message: first?.message ?? '人格配置填写有误。' };
}
