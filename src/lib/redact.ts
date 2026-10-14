/**
 * 敏感信息脱敏
 * ----------------------------------------------------------------------------
 * 技术方案第 5 节：日志中禁止输出 API Key、完整请求头和敏感响应。
 * 这个函数是那条约束落到代码上的样子 —— 任何要往外吐的字符串（日志、错误提示、
 * 上报）都先过它一遍。规则宁可多杀一点，也不要漏。
 */

const PATTERNS: Array<[RegExp, string]> = [
  // OpenAI 风格的 key
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  // Authorization: Bearer xxx
  [/Bearer\s+[A-Za-z0-9._~+/-]{6,}=*/gi, 'Bearer ***'],
  // api_key=xxx / apiKey: "xxx" 这类键值对
  [/(["']?(?:api[_-]?key|apikey|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, '$1***'],
  // 邮箱旁路：先把明显的密钥形状都吃掉即可，邮箱不属于敏感凭据，保留可读性
];

export function redactSensitive(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}
