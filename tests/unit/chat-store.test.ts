import { describe, expect, it } from 'vitest';
import { createChatStore } from '@/features/chat/store';
import { createConversationsStore } from '@/features/conversations/store';
import { createSettingsStore } from '@/features/settings/store';
import type { ModelProvider } from '@/services/model';
import {
  createCapturingProvider,
  createInstantProvider,
  createStepProvider,
  createTestServices,
  waitFor,
} from './helpers';

async function setup(model: ModelProvider = createInstantProvider('这是模拟回复。')) {
  const services = createTestServices({ model });
  const conversations = createConversationsStore(services);
  const settings = createSettingsStore(services);
  const chat = createChatStore(services, conversations, settings);

  await settings.getState().load();
  await conversations.getState().load();

  return { services, conversations, settings, chat };
}

describe('发送消息', () => {
  it('没有会话时自动新建一个，用户消息与助手消息都落库', async () => {
    const { chat, conversations } = await setup();

    await chat.getState().send('你好');

    const messages = conversations.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好', status: 'complete' });
    expect(messages[1]).toMatchObject({ role: 'assistant', status: 'complete' });
    expect(messages[1]?.content).toBe('这是模拟回复。');
    expect(conversations.getState().activeId).not.toBeNull();
  });

  it('首条消息成为会话标题', async () => {
    const { chat, conversations } = await setup();
    await chat.getState().send('帮我把这个流程梳理一下');

    const active = conversations
      .getState()
      .conversations.find((item) => item.id === conversations.getState().activeId);
    expect(active?.title).toBe('帮我把这个流程梳理一下');
  });

  it('空白输入被忽略，不产生任何消息', async () => {
    const { chat, conversations } = await setup();
    await chat.getState().send('   \n  ');

    expect(conversations.getState().messages).toEqual([]);
    expect(conversations.getState().conversations).toEqual([]);
  });

  it('一次只允许跑一个流式调用，重复发送被忽略', async () => {
    const provider = createStepProvider('一段需要慢慢吐出来的回复');
    const { chat, conversations } = await setup(provider);

    const first = chat.getState().send('第一条');
    await waitFor(() => chat.getState().streaming);

    await chat.getState().send('第二条');
    provider.abort();
    await first;

    const userMessages = conversations
      .getState()
      .messages.filter((message) => message.role === 'user');
    expect(userMessages.map((message) => message.content)).toEqual(['第一条']);
  });
});

describe('请求组装', () => {
  it('系统提示词单独一个字段，用户消息里不带它', async () => {
    const provider = createCapturingProvider();
    const { chat, settings } = await setup(provider);

    await chat.getState().send('今天几号');

    const request = provider.captures[0];
    expect(request).toBeDefined();
    expect(request?.systemPrompt).toBe(settings.getState().settings.persona.systemPrompt);
    expect(request?.messages.some((turn) => turn.content.includes('运行在本地桌面'))).toBe(false);
    expect(request?.messages).toEqual([{ role: 'user', content: '今天几号' }]);
    expect(request?.model).toBe(settings.getState().modelConfig.modelName);
  });

  it('多轮对话按顺序带上历史，且不含空的助手占位消息', async () => {
    const provider = createCapturingProvider('第一轮回复');
    const { chat } = await setup(provider);

    await chat.getState().send('第一轮');
    await chat.getState().send('第二轮');

    const second = provider.captures[1];
    expect(second?.messages.map((turn) => `${turn.role}:${turn.content}`)).toEqual([
      'user:第一轮',
      'assistant:第一轮回复',
      'user:第二轮',
    ]);
  });
});

describe('流式状态', () => {
  it('占位消息在流式开始时就进入消息列表，界面才有东西可渲染', async () => {
    const provider = createStepProvider('一段慢慢吐出来的回复');
    const { chat, conversations } = await setup(provider);

    const pending = chat.getState().send('你好');
    await waitFor(() => chat.getState().streaming);

    const placeholder = conversations
      .getState()
      .messages.find((message) => message.id === chat.getState().streamingMessageId);

    expect(placeholder).toBeDefined();
    expect(placeholder?.role).toBe('assistant');
    expect(placeholder?.status).toBe('streaming');

    provider.abort();
    await pending;
  });

  it('流式过程中 streamingText 逐步增长，结束后归位', async () => {
    const provider = createStepProvider('逐字吐出的内容');
    const { chat } = await setup(provider);

    const pending = chat.getState().send('开始');
    await waitFor(() => chat.getState().streamingText.length > 0);

    expect(chat.getState().streaming).toBe(true);
    const midway = chat.getState().streamingText.length;

    provider.abort();
    await pending;

    expect(midway).toBeGreaterThan(0);
    expect(chat.getState().streaming).toBe(false);
    expect(chat.getState().streamingMessageId).toBeNull();
  });

  it('中途停止：收尾状态是 aborted，已生成的内容被保留', async () => {
    const fullText = '这是一段比较长的回复内容，正常情况下会一直吐下去';
    const provider = createStepProvider(fullText);
    const { chat, conversations } = await setup(provider);

    const pending = chat.getState().send('你好');

    // 逐字 provider 每吐一个字就停住等放行，这样能精确卡在「生成到一半」
    await waitFor(() => chat.getState().streamingText.length >= 1);
    provider.release();
    await waitFor(() => chat.getState().streamingText.length >= 2);
    provider.release();
    await waitFor(() => chat.getState().streamingText.length >= 3);

    chat.getState().stop();
    await pending;

    expect(chat.getState().lastOutcome).toBe('aborted');

    const assistant = conversations
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.status).toBe('aborted');
    expect(assistant?.content.length).toBeGreaterThanOrEqual(3);
    expect(assistant?.content.length).toBeLessThan(fullText.length);
  });

  it('没有在生成时调用 stop 不会报错', async () => {
    const { chat } = await setup();
    expect(() => chat.getState().stop()).not.toThrow();
    expect(chat.getState().streaming).toBe(false);
  });
});

describe('失败处理', () => {
  it('模型调用失败时给出可读提示，并把消息标记为 error', async () => {
    const failing: ModelProvider = {
      id: 'failing',
      label: '会失败的 provider',
      performsNetworkRequest: false,
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
      async streamChat() {
        throw new Error('连接在读取响应时被重置');
      },
      abort() {
        /* 无需中断 */
      },
    };

    const { chat, conversations } = await setup(failing);
    await chat.getState().send('你好');

    expect(chat.getState().error).toContain('连接在读取响应时被重置');
    expect(chat.getState().streaming).toBe(false);

    const assistant = conversations
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.status).toBe('error');
  });

  it('错误提示经过脱敏，不会把凭据样式的内容原样抛出', async () => {
    const leaky: ModelProvider = {
      id: 'leaky',
      label: '会泄露的 provider',
      performsNetworkRequest: false,
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
      async streamChat() {
        throw new Error('请求失败：sk-abcdef1234567890 无效');
      },
      abort() {
        /* 无需中断 */
      },
    };

    const { chat } = await setup(leaky);
    await chat.getState().send('你好');

    expect(chat.getState().error).toContain('sk-***');
    expect(chat.getState().error).not.toContain('sk-abcdef1234567890');
  });

  it('clearError 可以清掉提示', async () => {
    const failing: ModelProvider = {
      id: 'failing',
      label: '会失败的 provider',
      performsNetworkRequest: false,
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
      async streamChat() {
        throw new Error('随便什么错');
      },
      abort() {
        /* 无需中断 */
      },
    };

    const { chat } = await setup(failing);
    await chat.getState().send('你好');
    expect(chat.getState().error).not.toBeNull();

    chat.getState().clearError();
    expect(chat.getState().error).toBeNull();
  });
});
