import { describe, expect, it, vi } from 'vitest';
import { MockModelProvider } from '@/services/model';
import {
  modelConfigSchemaForStoredKey,
  validateModelConfig,
} from '@/services/model/schema';
import type { ChatRequest, ModelConfig } from '@/types';
import { VALID_MODEL_CONFIG } from './helpers';

const REQUEST: ChatRequest = {
  model: 'gpt-4o-mini',
  systemPrompt: '你是一个简洁的助手。',
  messages: [{ role: 'user', content: '你好' }],
};

function makeProvider(options = {}) {
  return new MockModelProvider({
    thinkingDelayMs: 0,
    chunkDelayMs: 0,
    chunkSize: 1000,
    ...options,
  });
}

describe('MockModelProvider 的自我声明', () => {
  it('如实声明自己不发起网络请求', () => {
    const provider = makeProvider();
    expect(provider.performsNetworkRequest).toBe(false);
    expect(provider.id).toBe('mock');
  });
});

describe('配置校验规则', () => {
  it('合法配置通过校验', () => {
    expect(validateModelConfig(VALID_MODEL_CONFIG).ok).toBe(true);
  });

  it('桌面端已有凭据时允许留空 Key，填入新 Key 仍需满足长度', () => {
    const schema = modelConfigSchemaForStoredKey(true);

    expect(schema.safeParse({ ...VALID_MODEL_CONFIG, apiKey: '' }).success).toBe(true);
    expect(schema.safeParse({ ...VALID_MODEL_CONFIG, apiKey: 'short' }).success).toBe(false);
    expect(schema.safeParse({ ...VALID_MODEL_CONFIG, apiKey: 'sk-new-key-1234' }).success).toBe(true);
  });

  it('空地址 / 非 http 开头 / Key 过短 / 模型名带空格都会被挡住', () => {
    const cases: Array<[Partial<ModelConfig>, RegExp]> = [
      [{ apiUrl: '' }, /请填写 API 地址/],
      [{ apiUrl: 'api.example.com/v1' }, /完整 http:\/\/ 或 https:\/\//],
      [{ apiUrl: 'https://' }, /完整 http:\/\/ 或 https:\/\//],
      [{ apiUrl: 'http://api.example.com/v1' }, /HTTP 只允许本机地址/],
      [{ apiUrl: 'https://api.example.com/v1?api_key=secret' }, /不能包含.*Key/],
      [{ apiUrl: 'https://api.example.com/v1?X-API-Key=secret' }, /不能包含.*凭据/],
      [{ apiUrl: 'https://api.example.com/v1?client_secret=secret' }, /不能包含.*凭据/],
      [{ apiUrl: 'https://api.example.com/v1?X-Amz-Signature=secret' }, /不能包含.*凭据/],
      [{ apiUrl: 'https://api.example.com/v1#secret' }, /不能包含片段/],
      [{ apiUrl: 'https://api.example.com/v1#' }, /不能包含片段/],
      [{ apiKey: 'short' }, /太短/],
      [{ modelName: 'gpt 4o' }, /不应包含空格/],
    ];

    for (const [patch, expected] of cases) {
      const result = validateModelConfig({ ...VALID_MODEL_CONFIG, ...patch });
      expect(result.ok, `期望被拒绝：${JSON.stringify(patch)}`).toBe(false);
      expect(result.message).toMatch(expected);
    }
  });

  it('允许本机 HTTP 模型服务和远程 HTTPS 服务', () => {
    expect(
      validateModelConfig({ ...VALID_MODEL_CONFIG, apiUrl: 'http://localhost:11434/v1' }).ok
    ).toBe(true);
    expect(
      validateModelConfig({ ...VALID_MODEL_CONFIG, apiUrl: 'http://127.0.0.2:11434/v1' }).ok
    ).toBe(true);
    expect(
      validateModelConfig({ ...VALID_MODEL_CONFIG, apiUrl: 'https://api.example.com/v1' }).ok
    ).toBe(true);
    expect(
      validateModelConfig({ ...VALID_MODEL_CONFIG, apiUrl: 'http://[::1]:11434/v1' }).ok
    ).toBe(true);
  });
});

describe('testConnection', () => {
  it('配置不合法时直接给出字段级提示，不说「连接失败」这种含糊的话', async () => {
    const provider = makeProvider();
    const result = await provider.testConnection({ ...VALID_MODEL_CONFIG, apiKey: '' });

    expect(result.ok).toBe(false);
    expect(result.message).toBe('请填写 API Key');
  });

  it('配置合法时明确告知「没有发起任何网络请求」', async () => {
    const provider = makeProvider();
    const result = await provider.testConnection(VALID_MODEL_CONFIG);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('没有发起任何网络请求');
    expect(result.message).toContain(VALID_MODEL_CONFIG.modelName);
  });

  it('不会把 API Key 回显到提示文案里', async () => {
    const provider = makeProvider();
    const result = await provider.testConnection(VALID_MODEL_CONFIG);
    expect(result.message).not.toContain(VALID_MODEL_CONFIG.apiKey);
  });
});

describe('streamChat', () => {
  it('onDelta 收到的是累计文本，最后一次等于全文', async () => {
    const provider = makeProvider({ replyBuilder: () => '一二三四五' });
    const seen: string[] = [];

    const result = await provider.streamChat(REQUEST, (text) => seen.push(text));

    expect(seen.at(-1)).toBe('一二三四五');
    expect(result).toEqual({ outcome: 'complete', text: '一二三四五', toolCalls: [] });
  });

  it('chunkSize 决定分几段吐出', async () => {
    const provider = makeProvider({ chunkSize: 2, replyBuilder: () => '一二三四五六' });
    const seen: string[] = [];

    await provider.streamChat(REQUEST, (text) => seen.push(text));

    expect(seen).toEqual(['一二', '一二三四', '一二三四五六']);
  });

  it('abort 之后立刻收尾，且保留已经吐出的部分', async () => {
    const provider = makeProvider({
      chunkSize: 1,
      thinkingDelayMs: 50,
      replyBuilder: () => '一二三四五六七八九十',
    });
    const seen: string[] = [];

    const result = await provider.streamChat(REQUEST, (text) => {
      seen.push(text);
      if (text.length === 3) provider.abort();
    });

    expect(result.outcome).toBe('aborted');
    expect(result.text).toBe('一二三');
    expect(seen.at(-1)).toBe('一二三');
  });

  it('abort 能打断「思考中」的等待，不用等首字延迟跑完', async () => {
    const provider = makeProvider({ thinkingDelayMs: 5_000, replyBuilder: () => '不会出现' });

    const startedAt = Date.now();
    const pending = provider.streamChat(REQUEST, () => undefined);
    provider.abort();
    const result = await pending;

    expect(result.outcome).toBe('aborted');
    expect(result.text).toBe('');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('每次调用都会重置中断标记，上一次 abort 不会污染下一次', async () => {
    const provider = makeProvider({ chunkSize: 1, replyBuilder: () => '一二三' });

    await provider.streamChat(REQUEST, (text) => {
      if (text.length === 1) provider.abort();
    });
    const second = await provider.streamChat(REQUEST, () => undefined);

    expect(second.outcome).toBe('complete');
    expect(second.text).toBe('一二三');
  });

  it('传入的请求对象原样可见（系统提示词与消息分开）', async () => {
    const replyBuilder = vi.fn(() => '好的');
    const provider = makeProvider({ replyBuilder });

    await provider.streamChat(REQUEST, () => undefined);

    expect(replyBuilder).toHaveBeenCalledWith(REQUEST);
  });
});
