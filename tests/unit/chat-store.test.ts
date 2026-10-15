import { describe, expect, it } from 'vitest';
import { createChatStore } from '@/features/chat/store';
import { createConversationsStore } from '@/features/conversations/store';
import { createSettingsStore } from '@/features/settings/store';
import type { ModelProvider } from '@/services/model';
import { createBrowserStorage, type StorageService } from '@/services/storage';
import {
  createBrowserPlatformService,
  type PlatformCapability,
  type PlatformService,
} from '@/services/platform';
import {
  createCapturingProvider,
  createInstantProvider,
  createMemoryStorage,
  createStepProvider,
  createTestServices,
  waitFor,
} from './helpers';

async function setup(
  model: ModelProvider = createInstantProvider('这是模拟回复。'),
  platform?: PlatformService,
  storage?: StorageService
) {
  const services = createTestServices({
    model,
    ...(platform ? { platform } : {}),
    ...(storage ? { storage } : {}),
  });
  const conversations = createConversationsStore(services);
  const settings = createSettingsStore(services);
  const chat = createChatStore(services, conversations, settings);

  await settings.getState().load();
  await conversations.getState().load();

  return { services, conversations, settings, chat };
}

/**
 * 造一个「声称有通知能力」的平台，并把收到的通知记下来。
 *
 * 为什么要造：jsdom 里没有 Notification API，真实浏览器实现会直接判定
 * 「这个环境不支持通知」—— 那样成功路径就永远测不到。
 */
function createNotifyingPlatform(capabilities: PlatformCapability[] = ['notification']) {
  const base = createBrowserPlatformService();
  const sent: Array<{ title: string; body: string; force?: boolean }> = [];

  const platform: PlatformService = {
    ...base,
    id: 'fake-notify',
    probeCapabilities: async () => new Set(capabilities),
    showNotification: async (request) => {
      sent.push(request);
      return { delivered: true, reason: '已发送。' };
    },
  };

  return { platform, sent };
}

describe('发送消息', () => {
  it('在首次存储往返完成前就公开忙碌状态，避免切页或重复发送', async () => {
    const provider = createStepProvider('需要等待的回复');
    const { chat } = await setup(provider);

    const pending = chat.getState().send('第一条');
    expect(chat.getState().sending).toBe(true);
    expect(chat.getState().streaming).toBe(false);

    await waitFor(() => chat.getState().streaming);
    provider.abort();
    await pending;

    expect(chat.getState().sending).toBe(false);
  });

  it('准备阶段停止后保留用户消息，但不启动模型请求', async () => {
    const provider = createCapturingProvider();
    const base = createTestServices({ model: provider }).storage;
    let appendStarted = false;
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const storage: StorageService = {
      ...base,
      conversations: {
        ...base.conversations,
        async appendMessage(input) {
          if (input.role === 'user') {
            appendStarted = true;
            await appendGate;
          }
          return base.conversations.appendMessage(input);
        },
      },
    };
    const { chat, conversations } = await setup(provider, undefined, storage);

    const pending = chat.getState().send('这条问题仍要保留');
    await waitFor(() => appendStarted);
    expect(chat.getState().sending).toBe(true);

    chat.getState().stop();
    releaseAppend();
    await pending;

    expect(provider.captures).toHaveLength(0);
    expect(chat.getState().lastOutcome).toBe('aborted');
    expect(chat.getState().sending).toBe(false);
    expect(conversations.getState().messages.map((message) => message.content)).toEqual([
      '这条问题仍要保留',
    ]);
  });

  it('占位回复创建后加载失败，也会把消息标记为错误而不是遗留 streaming', async () => {
    const provider = createCapturingProvider();
    const base = createTestServices({ model: provider }).storage;
    let messageReads = 0;
    const storage: StorageService = {
      ...base,
      conversations: {
        ...base.conversations,
        async listMessages(conversationId) {
          messageReads += 1;
          if (messageReads === 2) throw new Error('读取消息失败');
          return base.conversations.listMessages(conversationId);
        },
      },
    };
    const { chat, conversations } = await setup(provider, undefined, storage);

    await chat.getState().send('你好');

    const assistant = conversations
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(provider.captures).toHaveLength(0);
    expect(assistant?.status).toBe('error');
    expect(chat.getState().error).toBe('读取消息失败');
  });

  it('会话消息加载完成前禁止发送，避免把旧会话上下文带进请求', async () => {
    const base = createBrowserStorage(createMemoryStorage());
    const first = await base.conversations.createConversation();
    await base.conversations.appendMessage({
      conversationId: first.id,
      role: 'user',
      content: '第一个会话的私有上下文',
      status: 'complete',
    });
    const second = await base.conversations.createConversation();
    await base.conversations.appendMessage({
      conversationId: second.id,
      role: 'user',
      content: '第二个会话的私有上下文',
      status: 'complete',
    });

    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let targetId = '';
    const storage: StorageService = {
      ...base,
      conversations: {
        ...base.conversations,
        async listMessages(conversationId) {
          if (conversationId === targetId) await readGate;
          return base.conversations.listMessages(conversationId);
        },
      },
    };
    const provider = createCapturingProvider();
    const { chat, conversations } = await setup(provider, undefined, storage);
    targetId =
      conversations.getState().activeId === first.id ? second.id : first.id;

    const selecting = conversations.getState().select(targetId);
    expect(conversations.getState().switchingConversation).toBe(true);
    await chat.getState().send('不要拿旧上下文发送');
    expect(provider.captures).toHaveLength(0);

    releaseRead();
    await selecting;
    await chat.getState().send('新会话的问题');

    expect(provider.captures[0]?.messages).toEqual([
      {
        role: 'user',
        content:
          targetId === first.id
            ? '第一个会话的私有上下文'
            : '第二个会话的私有上下文',
      },
      { role: 'user', content: '新会话的问题' },
    ]);
  });

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

  it('请求尚未把 streaming 状态写回时快速连发，也只保留第一条', async () => {
    const provider = createStepProvider('需要等待的回复');
    const { chat, conversations } = await setup(provider);

    // 第一次 send 还卡在创建占位消息之后的 await，第二次调用不能穿透。
    const first = chat.getState().send('第一条');
    const second = chat.getState().send('第二条');

    await waitFor(() => chat.getState().streaming);
    provider.abort();
    await Promise.all([first, second]);

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

// ---------------------------------------------------------------------------
// 回复完成后的通知（阶段 C）
// ---------------------------------------------------------------------------

describe('回复完成后的通知', () => {
  it('开关开着时发出通知：标题是会话标题，正文是去格式后的摘要', async () => {
    const { platform, sent } = createNotifyingPlatform();
    const { chat } = await setup(createInstantProvider('## 结论\n\n这段**回复**够短。'), platform);

    await chat.getState().send('你好');

    expect(sent).toHaveLength(1);
    // 首条用户消息成为会话标题，通知用它当标题，用户才知道是哪个会话
    expect(sent[0]?.title).toBe('你好');
    expect(sent[0]?.body).toBe('结论 这段回复够短。');
    // 正常路径**不设** force：该不该打扰由平台层按窗口状态判断。
    // 这里如果传了 true，就会变成「关着窗口也照弹」，或者「在前台也照弹」。
    expect(sent[0]?.force).toBeUndefined();
  });

  it('开关关掉之后不再发', async () => {
    const { platform, sent } = createNotifyingPlatform();
    const { chat, settings } = await setup(createInstantProvider('回复好了。'), platform);

    await settings.getState().setNotifyOnReplyComplete(false);
    await chat.getState().send('你好');

    expect(sent).toHaveLength(0);
  });

  it('用户中途停止不发通知 —— 他就在屏幕前，而且是他自己按的', async () => {
    const { platform, sent } = createNotifyingPlatform();
    const provider = createStepProvider('一段慢慢吐出来的回复内容');
    const { chat } = await setup(provider, platform);

    const pending = chat.getState().send('你好');
    await waitFor(() => chat.getState().streamingText.length >= 1);
    chat.getState().stop();
    await pending;

    expect(chat.getState().lastOutcome).toBe('aborted');
    expect(sent).toHaveLength(0);
  });

  it('出错时也发一条 —— 否则切走之后消息会悄无声息地失败', async () => {
    const { platform, sent } = createNotifyingPlatform();
    const failing: ModelProvider = {
      id: 'failing',
      label: '会失败的模型',
      performsNetworkRequest: true,
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
      async streamChat() {
        throw new Error('连接模型服务失败：网络不通');
      },
      abort() {
        /* 无需中断 */
      },
    };

    const { chat } = await setup(failing, platform);
    await chat.getState().send('你好');

    expect(chat.getState().error).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toContain('连接模型服务失败');
  });

  it('环境没有通知能力时安静跳过，不影响对话', async () => {
    // 能力集合里没有 notification：连调用都不该发生
    const { platform, sent } = createNotifyingPlatform([]);
    const { chat, conversations } = await setup(createInstantProvider('回复好了。'), platform);

    await chat.getState().send('你好');

    expect(sent).toHaveLength(0);
    // 对话本身必须完全正常
    expect(chat.getState().lastOutcome).toBe('complete');
    expect(conversations.getState().messages).toHaveLength(2);
  });

  it('通知失败不影响已经成功的对话', async () => {
    const base = createBrowserPlatformService();
    const platform: PlatformService = {
      ...base,
      id: 'broken-notify',
      probeCapabilities: async () => new Set<PlatformCapability>(['notification']),
      showNotification: async () => {
        throw new Error('发送通知失败：通知服务不可用');
      },
    };

    const { chat, conversations } = await setup(createInstantProvider('回复好了。'), platform);
    await chat.getState().send('你好');

    expect(chat.getState().lastOutcome).toBe('complete');
    expect(chat.getState().error).toBeNull();
    expect(conversations.getState().messages[1]?.status).toBe('complete');
  });
});
