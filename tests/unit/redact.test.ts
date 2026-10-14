import { describe, expect, it } from 'vitest';
import { redactSensitive } from '@/lib/redact';
import { toUserFacingError } from '@/lib/log';

describe('脱敏规则', () => {
  it('吃掉 OpenAI 风格的 key', () => {
    expect(redactSensitive('失败：sk-abcdef1234567890 无效')).toBe('失败：sk-*** 无效');
  });

  it('吃掉 Bearer 令牌', () => {
    const cleaned = redactSensitive('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc');
    expect(cleaned).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(cleaned).toContain('***');
  });

  it('吃掉键值对形式写的凭据', () => {
    expect(redactSensitive('{"apiKey":"abcdef1234567890"}')).toContain('"apiKey":"***');
    expect(redactSensitive('api_key=abcdef1234567890')).toContain('api_key=***');
  });

  it('普通文本原样保留', () => {
    const text = '连接超时，请检查网络后重试。';
    expect(redactSensitive(text)).toBe(text);
  });

  it('不会把短词误伤成秘密', () => {
    expect(redactSensitive('sk-123')).toBe('sk-123');
  });
});

describe('用户可见的错误提示', () => {
  it('Error 的 message 会被保留，但先过一遍脱敏', () => {
    expect(toUserFacingError(new Error('请求失败 sk-abcdef123456'), '兜底')).toBe(
      '请求失败 sk-***'
    );
  });

  it('拿不到可用信息时用兜底文案，而不是把 undefined 显示给用户', () => {
    expect(toUserFacingError(new Error('   '), '生成回复时出了点问题，请重试。')).toBe(
      '生成回复时出了点问题，请重试。'
    );
    expect(toUserFacingError('随便一个字符串', '兜底文案')).toBe('兜底文案');
    expect(toUserFacingError(null, '兜底文案')).toBe('兜底文案');
  });
});
