import { describe, expect, it, vi } from 'vitest';
import { createChatStore } from '@/features/chat/store';
import { createConversationsStore } from '@/features/conversations/store';
import { createSettingsStore } from '@/features/settings/store';
import type { ModelProvider } from '@/services/model';
import type { ChatRequest, ToolCall } from '@/types';

/** 与 Rust 侧的 MAX_TOOL_ROUNDS 保持一致 */
const MAX_ROUNDS_FOR_TEST = 3;
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

// ---------------------------------------------------------------------------
// 附件（阶段 D）
// ---------------------------------------------------------------------------

function fileAttachment(name: string, content: string) {
  return {
    kind: 'file' as const,
    name,
    relativePath: name,
    content,
    bytes: content.length,
    truncated: false,
  };
}

function screenshotAttachment() {
  return {
    kind: 'screenshot' as const,
    name: '屏幕截图',
    dataUrl: 'data:image/png;base64,AAAA',
    width: 2560,
    height: 1440,
    bytes: 1024,
  };
}

describe('把附件发进对话', () => {
  it('附件在发送前只留在内存里，不会先进数据库', async () => {
    const { chat, conversations } = await setup();
    chat.getState().attach(fileAttachment('笔记.md', '# 标题'));

    expect(chat.getState().pendingAttachments).toHaveLength(1);
    // 还没点发送 —— 挑了几个文件又反悔的话，库里不该留下任何痕迹
    expect(conversations.getState().messages).toHaveLength(0);
  });

  it('可以移除和清空', async () => {
    const { chat } = await setup();
    chat.getState().attach(fileAttachment('a.txt', 'a'));
    chat.getState().attach(fileAttachment('b.txt', 'b'));

    chat.getState().detach(0);
    expect(chat.getState().pendingAttachments.map((item) => item.name)).toEqual(['b.txt']);

    chat.getState().clearAttachments();
    expect(chat.getState().pendingAttachments).toHaveLength(0);
  });

  it('发送后附件跟着用户消息落库，待发送列表清空', async () => {
    const { chat, conversations } = await setup();
    chat.getState().attach(fileAttachment('笔记.md', '# 标题'));

    await chat.getState().send('看看这个文件');

    const userMessage = conversations.getState().messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe('看看这个文件');
    expect(userMessage?.attachments).toHaveLength(1);
    expect(userMessage?.attachments[0]?.name).toBe('笔记.md');
    expect(chat.getState().pendingAttachments).toHaveLength(0);
  });

  it('只挂附件不写字也能发出去', async () => {
    // 单看 text 会把这种情况吞掉：用户拖进一个文件、什么都没打就按了发送
    const provider = createCapturingProvider('收到。');
    const { chat, conversations } = await setup(provider);
    chat.getState().attach(screenshotAttachment());

    await chat.getState().send('');

    expect(conversations.getState().messages[0]?.attachments).toHaveLength(1);
    expect(provider.captures).toHaveLength(1);
  });

  it('第二轮请求仍然带着上一轮的截图 —— 否则模型就「忘了」那张图', async () => {
    // 这是把附件内容存进消息的真正原因：每轮都要重发整段历史，
    // 历史里的图片只剩引用的话，第二轮的请求里就没有它了。
    const provider = createCapturingProvider('看到了。');
    const { chat } = await setup(provider);

    chat.getState().attach(screenshotAttachment());
    await chat.getState().send('这张图什么意思');
    await chat.getState().send('那再解释一下');

    expect(provider.captures).toHaveLength(2);
    const secondTurn = provider.captures[1]?.messages ?? [];
    const withImage = secondTurn.filter((turn) =>
      (turn.attachments ?? []).some((item) => item.kind === 'screenshot')
    );
    expect(withImage).toHaveLength(1);
    expect(withImage[0]?.content).toBe('这张图什么意思');
  });

  it('只发附件没写字的那一轮，也要进第二轮的历史', async () => {
    const provider = createCapturingProvider('收到。');
    const { chat } = await setup(provider);

    chat.getState().attach(fileAttachment('周报.md', '本周没什么事'));
    await chat.getState().send('');
    await chat.getState().send('帮我总结一下');

    const secondTurn = provider.captures[1]?.messages ?? [];
    const withFile = secondTurn.filter((turn) =>
      (turn.attachments ?? []).some((item) => item.kind === 'file')
    );
    // 内容为空但带附件的消息如果被历史过滤掉，模型在第二轮就看不到那个文件了
    expect(withFile).toHaveLength(1);
  });

  it('没有附件的消息不带 attachments 字段', async () => {
    // 不带的才走「content 是字符串」的老格式，改动面才最小
    const provider = createCapturingProvider('好。');
    const { chat } = await setup(provider);

    await chat.getState().send('普通消息');

    expect(provider.captures[0]?.messages[0]?.attachments).toBeUndefined();
  });

  it('发送失败时待发送列表不会被清空两次', async () => {
    const { chat } = await setup();
    chat.getState().attach(fileAttachment('a.txt', 'a'));
    await chat.getState().send('看看');

    // 第二次发送时列表本来就是空的，不该抛错也不该复活
    await chat.getState().send('再看一次');
    expect(chat.getState().pendingAttachments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 工具调用（阶段 E）：模型要求访问内容
// ---------------------------------------------------------------------------

/**
 * 造一个「能读文件 + 能截屏」的平台，并记下每次读取的路径。
 *
 * 关键的一点：读文件走的是真实命令的形状（`readFile(relativePath)`），
 * 所以「模型给的路径有没有被校验」这件事由 Rust 侧负责 ——
 * 这里只验证我们把路径原样交给那条命令、并且没绕过它。
 */
function createToolCapablePlatform() {
  const base = createBrowserPlatformService();
  const reads: string[] = [];
  let shots = 0;

  const platform: PlatformService = {
    ...base,
    id: 'fake-tool-capable',
    probeCapabilities: async () =>
      new Set<PlatformCapability>(['file-read', 'screenshot']),
    fileAccessStatus: async () => ({ directory: 'D://notes', available: true }),
    readFile: async (relativePath: string) => {
      reads.push(relativePath);
      // 模拟 Rust 侧的越权拒绝：真实实现会在 file_access 里拦掉
      if (relativePath.includes('..') || relativePath.startsWith('/') || relativePath.includes(':')) {
        throw new Error('这个路径超出了已授权的目录范围，已拒绝读取。');
      }
      return { relativePath, content: `内容:${relativePath}`, bytes: 12, truncated: false };
    },
    setScreenshotEnabled: async () => ({ ok: true, message: '已开启截屏。' }),
    takeScreenshot: async () => {
      shots += 1;
      return {
        dataUrl: 'data:image/png;base64,SHOT',
        width: 2560,
        height: 1440,
        bytes: 2048,
        monitor: '主屏',
        monitorCount: 1,
        capturedAt: Date.now(),
      };
    },
  };

  return { platform, reads, shots: () => shots };
}

/** 按剧本返回的 provider：第一轮发工具调用，之后发文字 */
function createScriptedProvider(script: Array<{ text: string; toolCalls?: ToolCall[] }>) {
  const captures: ChatRequest[] = [];
  let round = 0;

  const provider: ModelProvider = {
    id: 'scripted',
    label: '按剧本返回的 provider',
    performsNetworkRequest: false,
    async testConnection() {
      return { ok: true, message: 'ok' };
    },
    async streamChat(input, onDelta) {
      captures.push(input);
      const step = script[Math.min(round, script.length - 1)] ?? { text: '' };
      round += 1;
      onDelta(step.text);
      return { outcome: 'complete', text: step.text, toolCalls: step.toolCalls ?? [] };
    },
    abort() {
      /* 不用中断能力 */
    },
  };

  return { provider, captures };
}

function fileCall(path: string, id = 'call_1'): ToolCall {
  return { id, name: 'read_file', arguments: JSON.stringify({ path }) };
}

describe('模型要求访问内容', () => {
  it('模型读文件之前会停下来等用户批准，不会自己读', async () => {
    const { platform, reads } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我先看一下这个文件。', toolCalls: [fileCall('notes.md')] },
      { text: '看完了，没问题。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('看看 notes.md');

    const request = chat.getState().toolRequest;
    expect(request?.calls).toHaveLength(1);
    expect(request?.calls[0]?.name).toBe('read_file');
    // 这一步最关键：没有用户批准就一个字节都不该读
    expect(reads).toHaveLength(0);
    expect(captures).toHaveLength(1);
  });

  it('批准之后把文件内容作为工具结果发回去，id 对得上', async () => {
    const { platform, reads } = await createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我先看一下。', toolCalls: [fileCall('notes.md')] },
      { text: '看完了。' },
    ]);
    const { chat, conversations } = await setup(provider, platform);

    await chat.getState().send('看看 notes.md');
    await chat.getState().resolveToolRequest([true]);

    expect(reads).toEqual(['notes.md']);

    // 第二轮请求里必须能看到：assistant(tool_calls) + tool(结果)
    const second = captures[1]?.messages ?? [];
    const assistantCall = second.find((turn) => (turn.toolCalls?.length ?? 0) > 0);
    const toolResult = second.find((turn) => turn.role === 'tool');

    expect(
      second.filter((turn) => turn.role === 'assistant' && turn.content === '我先看一下。')
    ).toHaveLength(1);
    expect(assistantCall?.toolCalls?.[0]?.id).toBe('call_1');
    expect(toolResult?.toolCallId).toBe('call_1');
    expect(toolResult?.content).toContain('内容:notes.md');

    // 读到的内容也要挂在那条回答上：重放历史时它就是上下文
    const answer = conversations.getState().messages.filter((message) => message.role === 'assistant').at(-1);
    expect(answer?.attachments?.[0]?.name).toBe('notes.md');
    expect(chat.getState().toolRequest).toBeNull();
  });

  it('拒绝时不读文件，并且明确告诉模型「用户拒绝了」', async () => {
    const { platform, reads } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我先看一下。', toolCalls: [fileCall('notes.md')] },
      { text: '那我就不看了。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('看看 notes.md');
    await chat.getState().resolveToolRequest([false]);

    expect(reads).toHaveLength(0);

    const toolResult = captures[1]?.messages.find((turn) => turn.role === 'tool');
    // 不说清楚的话，模型会一遍遍重试同一个请求，用户看到的是「它卡住了」
    expect(toolResult?.content).toContain('拒绝');
  });

  it('越权路径被拒绝，模型能拿到失败原因', async () => {
    const { platform, reads } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我看看。', toolCalls: [fileCall('../../../etc/passwd')] },
      { text: '读不到，抱歉。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一下外面的文件');
    await chat.getState().resolveToolRequest([true]);

    // 路径原样交给 Rust 侧的命令，由它判断 —— 前端不自己做安全判断
    expect(reads).toEqual(['../../../etc/passwd']);
    const toolResult = captures[1]?.messages.find((turn) => turn.role === 'tool');
    expect(toolResult?.content).toContain('读取失败');
    expect(toolResult?.content).toContain('超出');
  });

  it('参数坏掉时给出可读的失败说明，而不是崩', async () => {
    const { platform, reads } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我看看。', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '不是 JSON' }] },
      { text: '抱歉。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一下');
    await chat.getState().resolveToolRequest([true]);

    expect(reads).toHaveLength(0);
    const toolResult = captures[1]?.messages.find((turn) => turn.role === 'tool');
    expect(toolResult?.content).toContain('参数不合法');
  });

  it('截图请求：工具结果只报尺寸，图片另起一条消息带进去', async () => {
    const { platform, shots } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我看看屏幕。', toolCalls: [{ id: 'call_s', name: 'take_screenshot', arguments: '{}' }] },
      { text: '看到了。' },
    ]);
    const { chat, settings } = await setup(provider, platform);
    await settings.getState().setScreenshotEnabled(true);

    await chat.getState().send('看看我的屏幕');
    await chat.getState().resolveToolRequest([true]);

    expect(shots()).toBe(1);

    const second = captures[1]?.messages ?? [];
    const toolResult = second.find((turn) => turn.role === 'tool');
    // 工具结果只能是文本 —— 所以图片不能塞在这里
    expect(toolResult?.content).toContain('2560×1440');
    expect(toolResult?.content).not.toContain('base64');

    // 图片以一条带附件的 user 轮次进去，模型才真的看得到
    const imageTurn = second.filter(
      (turn) => turn.role === 'user' && (turn.attachments ?? []).some((item) => item.kind === 'screenshot')
    );
    expect(imageTurn).toHaveLength(1);
  });

  it('模型连续要东西超过上限就停下，不再弹确认框', async () => {
    const { platform } = createToolCapablePlatform();
    // 每一轮都要一个文件
    const { provider, captures } = createScriptedProvider([
      { text: '再要一个。', toolCalls: [fileCall('a.md', 'call_1')] },
      { text: '再要一个。', toolCalls: [fileCall('b.md', 'call_2')] },
      { text: '再要一个。', toolCalls: [fileCall('c.md', 'call_3')] },
      { text: '再要一个。', toolCalls: [fileCall('d.md', 'call_4')] },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一堆文件');
    for (let index = 0; index < MAX_ROUNDS_FOR_TEST; index += 1) {
      if (!chat.getState().toolRequest) break;
      await chat.getState().resolveToolRequest([true]);
    }

    expect(chat.getState().toolRequest).toBeNull();
    expect(chat.getState().error).toContain('已经停下');
    // 上限是必要的：每一轮都要用户点一次确认，没有上限的话用户会被弹到烦
    expect(captures.length).toBeLessThanOrEqual(MAX_ROUNDS_FOR_TEST + 1);
  });

  it('等用户批准的时候不许发新消息', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我先看一下。', toolCalls: [fileCall('notes.md')] },
      { text: '好。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('看看 notes.md');
    expect(chat.getState().toolRequest).not.toBeNull();

    await chat.getState().send('再来一条');

    // 新消息插进来的话，工具结果就对不上 id 了
    expect(captures).toHaveLength(1);
  });

  it('能力没开就不把工具给模型', async () => {
    const { provider, captures } = createScriptedProvider([{ text: '好。' }]);
    const { chat } = await setup(provider);

    await chat.getState().send('你好');

    // 浏览器模式读不了文件也截不了屏，所以一个工具都不该传
    expect(captures[0]?.tools).toEqual([]);
  });
});

describe('工具调用的进度、部分成功与取消', () => {
  it('模型攒工具调用时把进度推给界面，收尾后清空', async () => {
    const { platform } = createToolCapablePlatform();
    const seen: number[] = [];

    // 一个会推两次进度的 provider
    const provider: ModelProvider = {
      id: 'progressing',
      label: '会推进度的 provider',
      performsNetworkRequest: false,
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
      async streamChat(_input, onDelta, onToolProgress) {
        onDelta('我先看一下。');
        onToolProgress?.([{ index: 0, name: 'read_file', argumentChars: 0 }]);
        onToolProgress?.([{ index: 0, name: 'read_file', argumentChars: 12 }]);
        seen.push(1);
        return {
          outcome: 'complete',
          text: '我先看一下。',
          toolCalls: [fileCall('notes.md')],
        };
      },
      abort() {
        /* 不用 */
      },
    };

    const { chat } = await setup(provider, platform);
    await chat.getState().send('看看');

    // 那几秒里界面本来只有一个光标 —— 现在至少有「它在要东西」这件事可见
    expect(seen).toHaveLength(1);
    // 这一轮结束之后不能再显示「正在准备」
    expect(chat.getState().toolProgress).toEqual([]);
    expect(chat.getState().toolRequest).not.toBeNull();
  });

  it('一个成功一个失败时逐项记下来，两边结果都发回模型', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      {
        text: '我读这两个。',
        toolCalls: [fileCall('notes.md', 'call_ok'), fileCall('../secret.txt', 'call_bad')],
      },
      { text: '一个读到了，另一个不行。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读两个文件');
    await chat.getState().resolveToolRequest([true, true]);

    const outcome = chat.getState().toolOutcome;
    expect(outcome).toHaveLength(2);
    expect(outcome?.[0]?.ok).toBe(true);
    expect(outcome?.[1]?.ok).toBe(false);
    // 失败原因要用户也看得到，不能只发回给模型
    expect(outcome?.[1]?.detail).toContain('超出');

    // 但两条工具结果都要发回模型 —— 缺一条它就以为另一个也失败了，会去重试
    const toolTurns = (captures[1]?.messages ?? []).filter((turn) => turn.role === 'tool');
    expect(toolTurns).toHaveLength(2);
    expect(toolTurns[0]?.content).toContain('内容:notes.md');
    expect(toolTurns[1]?.content).toContain('读取失败');
  });

  it('执行期间点停止就不再往下做，也不发下一轮请求', async () => {
    let release!: () => void;
    const base = createToolCapablePlatform();
    const platform: PlatformService = {
      ...base.platform,
      readFile: async (relativePath: string) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { relativePath, content: 'x', bytes: 1, truncated: false };
      },
    };

    const { provider, captures } = createScriptedProvider([
      {
        text: '我读这两个。',
        toolCalls: [fileCall('a.md', 'call_1'), fileCall('b.md', 'call_2')],
      },
      { text: '不该走到这里。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读两个');
    const running = chat.getState().resolveToolRequest([true, true]);

    // 等第一个读开始，然后按停止
    await new Promise((resolve) => setTimeout(resolve, 0));
    chat.getState().stop();
    release();
    await running;

    const outcome = chat.getState().toolOutcome;
    expect(outcome?.[1]?.detail).toBe('已取消');
    // 用户既然按了停止，就不该再替他发一轮请求
    expect(captures).toHaveLength(1);
    expect(chat.getState().lastOutcome).toBe('aborted');
  });

  it('读取超时会给出一条明确的工具结果，而不是一直等下去', async () => {
    const base = createToolCapablePlatform();
    const platform: PlatformService = {
      ...base.platform,
      // 永远不返回
      readFile: () => new Promise(() => undefined),
    };

    const { provider, captures } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('slow.md')] },
      { text: '读不到。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一个很大的文件');

    vi.useFakeTimers();
    try {
      const running = chat.getState().resolveToolRequest([true]);
      await vi.advanceTimersByTimeAsync(16_000);
      await running;
    } finally {
      vi.useRealTimers();
    }

    const outcome = chat.getState().toolOutcome;
    expect(outcome?.[0]?.ok).toBe(false);
    expect(outcome?.[0]?.detail).toContain('秒');

    // 超时也必须有工具结果：否则模型会一直等着，或者在下一轮重新请求
    const toolTurns = (captures[1]?.messages ?? []).filter((turn) => turn.role === 'tool');
    expect(toolTurns).toHaveLength(1);
    expect(toolTurns[0]?.content).toContain('失败');
  });

  it('会话一换，待处理的请求和结果都复位', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('notes.md')] },
      { text: '好。' },
    ]);
    const { chat, conversations } = await setup(provider, platform);

    await chat.getState().send('读一下');
    expect(chat.getState().toolRequest).not.toBeNull();

    // 正常路径上界面上不让切，但删除会话、重置数据绕不过去
    const created = await conversations.getState().createConversation();
    conversations.setState({ activeId: created.id });

    expect(chat.getState().toolRequest).toBeNull();
    expect(chat.getState().toolProgress).toEqual([]);
    expect(chat.getState().toolOutcome).toBeNull();
  });

  it('上一轮的执行结果不会挂在这一轮上', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('notes.md')] },
      { text: '读完了。' },
      { text: '这是新的一轮。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一下');
    await chat.getState().resolveToolRequest([true]);
    expect(chat.getState().toolOutcome).not.toBeNull();

    await chat.getState().send('新问题');
    expect(chat.getState().toolOutcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 上下文裁剪（上下文管理第一步）
// ---------------------------------------------------------------------------

describe('历史裁剪与工具链', () => {
  async function seedLongConversation(
    services: ReturnType<typeof createTestServices>,
    conversations: ReturnType<typeof createConversationsStore>,
    count: number
  ) {
    const created = await conversations.getState().createConversation();
    for (let index = 0; index < count; index += 1) {
      await services.storage.conversations.appendMessage({
        conversationId: created.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `历史第 ${index} 条`,
        status: 'complete',
      });
    }
    await conversations.getState().reloadActiveMessages();
  }

  it('历史被裁掉之后，工具调用链仍然完整', async () => {
    // 这一条守的是最容易出错的那个组合：**裁剪 + 工具链**。
    // 一旦裁掉了 assistant(tool_calls) 却留下了 tool 结果，服务端会直接拒绝整次请求。
    const { platform } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我看一下。', toolCalls: [fileCall('notes.md', 'call_trim')] },
      { text: '看完了。' },
    ]);
    const { chat, conversations, services } = await setup(provider, platform);

    await seedLongConversation(services, conversations, 45);
    // 45 条历史 + 这一轮的 user 消息，远超条数上限，必定触发裁剪
    await chat.getState().send('看看 notes.md');
    await chat.getState().resolveToolRequest([true]);

    const second = captures[1]?.messages ?? [];

    // 1) 历史确实被裁了
    expect(second.length).toBeLessThanOrEqual(41 + 3);
    expect(second.some((turn) => turn.content === '历史第 0 条')).toBe(false);

    // 2) 工具链没有被裁断：tool 结果前面要紧跟着发起它的那条 assistant
    const toolIndex = second.findIndex((turn) => turn.role === 'tool');
    expect(toolIndex).toBeGreaterThan(0);
    expect(second[toolIndex - 1]?.toolCalls?.[0]?.id).toBe('call_trim');
    expect(second[toolIndex]?.toolCallId).toBe('call_trim');

    // 3) 首条是 user，不是「助手自说自话」开头
    expect(second[0]?.role).toBe('user');

    // 4) 附件仍然挂在回答上，重放历史时它就是上下文
    const answer = conversations
      .getState()
      .messages.filter((message) => message.role === 'assistant')
      .at(-1);
    expect(answer?.attachments?.[0]?.name).toBe('notes.md');
  });

  it('裁剪不会把命令附带的工具轮次算进预算', async () => {
    // 工具轮次由 MAX_TOOL_ROUNDS 单独管。把它们也塞进历史预算的话，
    // 长对话里最后一个工具结果会被裁掉 —— 那正是模型最需要的那条。
    const { platform } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我看一下。', toolCalls: [fileCall('notes.md', 'call_keep')] },
      { text: '看完了。' },
    ]);
    const { chat, conversations, services } = await setup(provider, platform);

    await seedLongConversation(services, conversations, 60);
    await chat.getState().send('看看 notes.md');
    await chat.getState().resolveToolRequest([true]);

    const second = captures[1]?.messages ?? [];
    const toolTurns = second.filter((turn) => turn.role === 'tool');

    expect(toolTurns).toHaveLength(1);
    expect(toolTurns[0]?.content).toContain('内容:notes.md');
  });
});

// ---------------------------------------------------------------------------
// 跨消息附件去重（只在组装请求时去重，不动持久化消息）
// ---------------------------------------------------------------------------

function sameFile() {
  return {
    kind: 'file' as const,
    name: 'notes.md',
    relativePath: 'notes.md',
    content: '一样的内容',
    bytes: 12,
    truncated: false,
  };
}

describe('附件去重', () => {
  it('同一个文件分两次发送，发给模型的历史里只注入一次', async () => {
    const { provider, captures } = createScriptedProvider([{ text: '好。' }, { text: '好。' }]);
    const { chat, conversations } = await setup(provider);

    chat.getState().attach(sameFile());
    await chat.getState().send('第一次');
    chat.getState().attach(sameFile());
    await chat.getState().send('第二次');

    const second = captures[1]?.messages ?? [];
    const injected = second
      .flatMap((turn) => turn.attachments ?? [])
      .filter((item) => item.kind === 'file' && item.relativePath === 'notes.md');

    expect(injected).toHaveLength(1);

    // 但用户自己的两条消息一条都没少，附件也都还在 ——
    // 用户确实发过两次，那是事实，界面和数据库都不能改
    const userMessages = conversations.getState().messages.filter((item) => item.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.attachments).toHaveLength(1);
    expect(userMessages[1]?.attachments).toHaveLength(1);
  });

  it('同路径不同内容时两个版本都发给模型', async () => {
    const { provider, captures } = createScriptedProvider([{ text: '好。' }, { text: '好。' }]);
    const { chat } = await setup(provider);

    chat.getState().attach({ ...sameFile(), content: '第一版内容' });
    await chat.getState().send('旧版');
    chat.getState().attach({ ...sameFile(), content: '第二版内容' });
    await chat.getState().send('新版');

    const second = captures[1]?.messages ?? [];
    const injected = second
      .flatMap((turn) => turn.attachments ?? [])
      .filter((item) => item.kind === 'file' && item.relativePath === 'notes.md');

    expect(injected).toHaveLength(2);
  });

  it('工具调用产生的截图与历史里的截图重复时只保留一份，且配对不被打断', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我截个图。', toolCalls: [{ id: 'call_shot', name: 'take_screenshot', arguments: '{}' }] },
      { text: '看到了。' },
    ]);
    const { chat, conversations, services, settings } = await setup(provider, platform);
    await settings.getState().setScreenshotEnabled(true);

    // 历史里已经有一张截图，内容和工具将要抓到的那张完全一样
    const created = await conversations.getState().createConversation();
    await services.storage.conversations.appendMessage({
      conversationId: created.id,
      role: 'user',
      content: '这是我之前发过的截图',
      status: 'complete',
      attachments: [
        {
          kind: 'screenshot',
          name: '屏幕截图',
          dataUrl: 'data:image/png;base64,SHOT',
          width: 2560,
          height: 1440,
          bytes: 2048,
        },
      ],
    });
    await conversations.getState().reloadActiveMessages();

    await chat.getState().send('帮我看看屏幕');
    await chat.getState().resolveToolRequest([true]);

    const second = captures[1]?.messages ?? [];
    const screenshots = second
      .flatMap((turn) => turn.attachments ?? [])
      .filter((item) => item.kind === 'screenshot');

    // 历史一份 + 工具一份，是同一张图 —— 只留一份
    expect(screenshots).toHaveLength(1);

    // 首条仍然是 user，没有变成「助手自说自话」开头
    expect(second[0]?.role).toBe('user');

    // 工具链配对完整：tool 结果紧跟在发起它的 assistant 后面，id 对得上
    const toolIndex = second.findIndex((turn) => turn.role === 'tool');
    expect(toolIndex).toBeGreaterThan(0);
    expect(second[toolIndex - 1]?.toolCalls?.[0]?.id).toBe('call_shot');
    expect(second[toolIndex]?.toolCallId).toBe('call_shot');

    // 那条「这是刚才抓到的截图」的话还在，只是图片被去掉了
    const noteTurn = second.find((turn) => turn.content.includes('屏幕截图'));
    expect(noteTurn).toBeDefined();
  });

  it('工具读到的文件与用户手动发的是同一份时只留一份', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我先看一下。', toolCalls: [fileCall('notes.md', 'call_dup')] },
      { text: '看完了。' },
    ]);
    const { chat, conversations, services } = await setup(provider, platform);

    // 历史里用户已经手动发过 notes.md，内容和工具读到的完全一样（内容:notes.md）
    const created = await conversations.getState().createConversation();
    await services.storage.conversations.appendMessage({
      conversationId: created.id,
      role: 'user',
      content: '这是我发的文件',
      status: 'complete',
      attachments: [
        {
          kind: 'file',
          name: 'notes.md',
          relativePath: 'notes.md',
          content: '内容:notes.md',
          bytes: 12,
          truncated: false,
        },
      ],
    });
    await conversations.getState().reloadActiveMessages();

    await chat.getState().send('再看看 notes.md');
    await chat.getState().resolveToolRequest([true]);

    const second = captures[1]?.messages ?? [];
    const files = second
      .flatMap((turn) => turn.attachments ?? [])
      .filter((item) => item.kind === 'file' && item.relativePath === 'notes.md');

    // 历史里那份 + 回答上挂的那份，是同一个文件 —— 只留一份
    expect(files).toHaveLength(1);

    // 但工具结果里的正文仍然在：模型要能读到内容
    const toolTurn = second.find((turn) => turn.role === 'tool');
    expect(toolTurn?.content).toContain('内容:notes.md');
  });
});

describe('附件去重 × 历史裁剪的顺序', () => {
  it('旧消息里的附件被预算裁掉时，较新消息里的同一附件必须留下', async () => {
    // 这个组合最容易写错：先去重再裁剪，去重会把保留权交给**最早**那份，
    // 而最早那份恰恰最可能被字节预算淘汰 —— 结果两边都没了。
    const { provider, captures } = createScriptedProvider([{ text: '好。' }, { text: '好。' }]);
    const { chat, conversations, services } = await setup(provider);

    const fileA = {
      kind: 'file' as const,
      name: 'a.md',
      relativePath: 'a.md',
      content: '只有这一小段',
      bytes: 18,
      truncated: false,
    };

    // 第一条：用户带着附件 A（它会被后来的预算淘汰）
    chat.getState().attach(fileA);
    await chat.getState().send('第一次带上 a.md');

    const conversationId = conversations.getState().activeId ?? '';

    // 中间塞进足够大的历史，确保字节预算会把最早那条挤掉
    const chunk = 'x'.repeat(1_500_000);
    for (let index = 0; index < 3; index += 1) {
      await services.storage.conversations.appendMessage({
        conversationId,
        role: 'user',
        content: `大消息 ${index}`,
        status: 'complete',
        attachments: [
          {
            kind: 'file',
            name: 'big.txt',
            relativePath: `big-${index}.txt`,
            content: chunk,
            bytes: chunk.length,
            truncated: false,
          },
        ],
      });
    }
    await conversations.getState().reloadActiveMessages();

    // 最近一条：再次带上同一个附件 A
    chat.getState().attach(fileA);
    await chat.getState().send('再看一次 a.md');

    const second = captures[1]?.messages ?? [];
    const injected = second
      .flatMap((turn) => turn.attachments ?? [])
      .filter((item) => item.kind === 'file' && item.relativePath === 'a.md');

    // 只剩最近这一份时，附件必须还在 —— 否则模型会说「我看不到 a.md」
    expect(injected).toHaveLength(1);
    // 最近那条消息本身也还在
    expect(second.some((turn) => turn.content === '再看一次 a.md')).toBe(true);
    expect(second[0]?.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// 工具执行超时后的恢复
//
// 超时不是「一次失败」，而是「这一轮必须能干净地结束」：
// 模型要收到明确的超时结果，状态要复位，用户要能接着聊，
// 而且下一轮不能拖着上一轮的工具链。
// ---------------------------------------------------------------------------

describe('工具执行超时后的恢复', () => {
  /** 让 readFile 永远不返回 —— 模拟一个卡住的读取 */
  function hangingPlatform() {
    const base = createToolCapablePlatform();
    const platform: PlatformService = {
      ...base.platform,
      readFile: () => new Promise<never>(() => undefined),
    };
    return { platform };
  }

  /** 跑一次「超时」的工具轮次。整个过程在假时钟下推进，不用真等 15 秒。 */
  async function runTimedOutRound(
    chat: ReturnType<typeof createChatStore>,
    approvals: boolean[] = [true]
  ) {
    vi.useFakeTimers();
    try {
      const running = chat.getState().resolveToolRequest(approvals);
      await vi.advanceTimersByTimeAsync(16_000);
      await running;
    } finally {
      vi.useRealTimers();
    }
  }

  it('超时后模型收到的是一条明确的超时结果，而不是空结果', async () => {
    const { platform } = hangingPlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('slow.md', 'call_slow')] },
      { text: '读不到就算了。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一个可能很大的文件');
    await runTimedOutRound(chat);

    const second = captures[1]?.messages ?? [];
    const toolTurn = second.find((turn) => turn.role === 'tool');

    expect(toolTurn).toBeDefined();
    // 要说清「是什么超时了」「等了多久放弃」，不能只写「失败」
    expect(toolTurn?.content).toContain('读取失败');
    expect(toolTurn?.content).toContain('超过');
    expect(toolTurn?.content).toContain('秒');
    // id 仍然对得上：超时也是一条正常的工具结果
    expect(toolTurn?.toolCallId).toBe('call_slow');
  });

  it('超时后状态完全复位，不会停在 sending / streaming / toolRequest', async () => {
    const { platform } = hangingPlatform();
    const { provider } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('slow.md')] },
      { text: '读不到。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一下');
    await runTimedOutRound(chat);

    const state = chat.getState();
    expect(state.sending).toBe(false);
    expect(state.streaming).toBe(false);
    expect(state.streamingMessageId).toBeNull();
    expect(state.toolRequest).toBeNull();
    expect(state.toolProgress).toEqual([]);
    // 这一轮本身是正常结束的（超时是工具层面的事，不是整轮失败）
    expect(state.lastOutcome).toBe('complete');
    expect(state.error).toBeNull();
  });

  it('超时后用户能继续提问，新请求里不带上一轮残留的工具链', async () => {
    const { platform } = hangingPlatform();
    const { provider, captures } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('slow.md', 'call_slow')] },
      { text: '读不到就算了。' },
      { text: '那就聊点别的。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读一下');
    await runTimedOutRound(chat);

    // 接着问一个新的问题 —— 这就是「超时之后还能不能正常用」的验收点
    await chat.getState().send('那算了，先聊别的');

    const third = captures[2]?.messages ?? [];
    expect(third.length).toBeGreaterThan(0);
    // 上一轮的工具链一条都不能跟过来
    expect(third.some((turn) => turn.role === 'tool')).toBe(false);
    expect(third.some((turn) => (turn.toolCalls?.length ?? 0) > 0)).toBe(false);
    expect(third.some((turn) => Boolean(turn.toolCallId))).toBe(false);

    // 新的回答正常产生了
    const last = captures[captures.length - 1];
    expect(last).toBeDefined();
    expect(chat.getState().error).toBeNull();
  });

  it('一个超时、一个成功时，两条工具结果都齐全，配对不被打断', async () => {
    const base = createToolCapablePlatform();
    const platform: PlatformService = {
      ...base.platform,
      readFile: (relativePath: string) =>
        relativePath === 'slow.md'
          ? new Promise<never>(() => undefined)
          : Promise.resolve({
              relativePath,
              content: '内容:' + relativePath,
              bytes: 12,
              truncated: false,
            }),
    };

    const { provider, captures } = createScriptedProvider([
      {
        text: '我读这两个。',
        toolCalls: [fileCall('slow.md', 'call_slow'), fileCall('ok.md', 'call_ok')],
      },
      { text: '一个没读到，一个读到了。' },
    ]);
    const { chat } = await setup(provider, platform);

    await chat.getState().send('读两个文件');
    await runTimedOutRound(chat, [true, true]);

    const second = captures[1]?.messages ?? [];
    const toolTurns = second.filter((turn) => turn.role === 'tool');

    // 两个调用都要有结果 —— 少一个服务端就会拒绝整次请求
    expect(toolTurns).toHaveLength(2);
    expect(toolTurns[0]?.toolCallId).toBe('call_slow');
    expect(toolTurns[1]?.toolCallId).toBe('call_ok');
    expect(toolTurns[0]?.content).toContain('读取失败');
    expect(toolTurns[1]?.content).toContain('内容:ok.md');

    // 界面上逐项列出：一项失败、一项成功
    const items = chat.getState().toolOutcome;
    expect(items).toHaveLength(2);
    expect(items?.[0]?.ok).toBe(false);
    expect(items?.[1]?.ok).toBe(true);

    // assistant(tool_calls) 紧挨着第一条工具结果
    const toolIndex = second.findIndex((turn) => turn.role === 'tool');
    expect(second[toolIndex - 1]?.toolCalls).toHaveLength(2);
  });

  it('超时后不留半截消息：助手回答照常落库，没有消息卡在 streaming', async () => {
    const { platform } = hangingPlatform();
    const { provider } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('slow.md')] },
      { text: '读不到就算了。' },
    ]);
    const { chat, conversations } = await setup(provider, platform);

    await chat.getState().send('读一下');
    await runTimedOutRound(chat);

    const messages = conversations.getState().messages;
    // 用户问了一句、助手答了两句（先说要读，再说读不到）
    expect(messages.filter((item) => item.role === 'user')).toHaveLength(1);
    expect(messages.filter((item) => item.role === 'assistant')).toHaveLength(2);

    // 没有一条消息卡在 streaming 状态
    expect(messages.every((item) => item.status !== 'streaming')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 重置本地数据后清理聊天临时状态
//
// 重置清的是持久化数据，清不到内存里的东西 —— 比如一条已经过时的错误提示。
// 用 settings 上的递增信号（dataResetVersion）通知，依赖方向只有 chat → settings。
// ---------------------------------------------------------------------------

describe('重置本地数据后清理聊天临时状态', () => {
  /** 一个必然失败的 provider，用来制造一条真实的 error */
  function failingProvider(message: string): ModelProvider {
    return {
      id: 'failing',
      label: '必然失败的 provider',
      performsNetworkRequest: false,
      async testConnection() {
        return { ok: true, message: 'ok' };
      },
      async streamChat() {
        throw new Error(message);
      },
      abort() {
        /* 不用中断能力 */
      },
    };
  }

  it('重置成功后，聊天顶部的旧错误被清掉', async () => {
    const { chat, settings } = await setup(failingProvider('这个模型不支持图片输入。'));

    await chat.getState().send('看看这张截图');
    expect(chat.getState().error).not.toBeNull();

    await settings.getState().resetAll();

    // 重置只清持久化数据，这条提示是内存里的 —— 正是这个 bug 的形态
    expect(chat.getState().error).toBeNull();
  });

  it('待确认的工具请求也一并清掉', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('notes.md')] },
      { text: '好。' },
    ]);
    const { chat, settings } = await setup(provider, platform);

    await chat.getState().send('看看 notes.md');
    expect(chat.getState().toolRequest).not.toBeNull();

    await settings.getState().resetAll();

    expect(chat.getState().toolRequest).toBeNull();
    expect(chat.getState().toolProgress).toEqual([]);
  });

  it('工具执行结果、待发附件和流式残留都清空', async () => {
    const { platform } = createToolCapablePlatform();
    const { provider } = createScriptedProvider([
      { text: '我读一下。', toolCalls: [fileCall('notes.md')] },
      { text: '读完了。' },
    ]);
    const { chat, settings } = await setup(provider, platform);

    await chat.getState().send('看看 notes.md');
    await chat.getState().resolveToolRequest([true]);
    expect(chat.getState().toolOutcome).not.toBeNull();

    // 流式进度和待发附件很难在测试里稳定停在中间，直接摆上去测清理
    chat.setState({
      toolProgress: [{ index: 0, name: 'read_file', argumentChars: 12 }],
      streamingText: '半截文本',
      lastOutcome: 'complete',
      pendingAttachments: [
        {
          kind: 'file',
          name: 'notes.md',
          relativePath: 'notes.md',
          content: '内容',
          bytes: 2,
          truncated: false,
        },
      ],
    });

    await settings.getState().resetAll();

    const state = chat.getState();
    expect(state.toolOutcome).toBeNull();
    expect(state.toolProgress).toEqual([]);
    expect(state.streamingText).toBe('');
    expect(state.lastOutcome).toBeNull();
    expect(state.pendingAttachments).toEqual([]);
  });

  it('没发生重置时，普通的聊天错误不会被误清', async () => {
    const { chat, settings } = await setup(failingProvider('出错了'));

    await chat.getState().send('你好');
    expect(chat.getState().error).not.toBeNull();

    // 一次普通的设置写入：重置信号没推进，不该触发清理
    await settings.getState().setScreenshotEnabled(false);

    expect(chat.getState().error).not.toBeNull();
  });

  it('版本号没变时不会清理，变了才清', async () => {
    const { chat, settings } = await setup(failingProvider('出错了'));
    await chat.getState().send('你好');
    const version = settings.getState().dataResetVersion;

    // 同一个版本号重复写入：不该清
    settings.setState({ dataResetVersion: version });
    expect(chat.getState().error).not.toBeNull();

    // 版本号推进：清
    settings.setState({ dataResetVersion: version + 1 });
    expect(chat.getState().error).toBeNull();
  });

  it('重置失败时不推进信号，聊天状态保持原样', async () => {
    const base = createBrowserStorage(createMemoryStorage());
    const failingStorage: StorageService = {
      ...base,
      reset: async () => {
        throw new Error('删除凭据失败');
      },
    };

    const { chat, settings } = await setup(
      failingProvider('出错了'),
      undefined,
      failingStorage
    );

    await chat.getState().send('你好');
    const before = chat.getState().error;
    expect(before).not.toBeNull();
    const versionBefore = settings.getState().dataResetVersion;

    await expect(settings.getState().resetAll()).rejects.toThrow();

    // 没成功就不推进信号，也不清 —— 用户正看着的那条提示不能被抹掉
    expect(settings.getState().dataResetVersion).toBe(versionBefore);
    expect(chat.getState().error).toBe(before);
  });

  it('重置后仍然可以新建会话并正常发送', async () => {
    const { provider } = createScriptedProvider([{ text: '重置后的新回复。' }]);
    const { chat, conversations, settings } = await setup(provider);

    await chat.getState().send('重置前');
    await settings.getState().resetAll();
    // App 在重置成功之后会重新加载会话列表，这里照做
    await conversations.getState().load();

    await chat.getState().send('重置后');

    expect(chat.getState().error).toBeNull();
    const messages = conversations.getState().messages;
    expect(messages.some((item) => item.content.includes('重置后的新回复'))).toBe(true);
  });

  it('两个独立的 store 实例互不影响（订阅是按实例的，不是全局总线）', async () => {
    const first = await setup(failingProvider('出错了'));
    const second = await setup(failingProvider('出错了'));

    await first.chat.getState().send('你好');
    await second.chat.getState().send('你好');

    first.settings.setState({
      dataResetVersion: first.settings.getState().dataResetVersion + 1,
    });

    expect(first.chat.getState().error).toBeNull();
    // 另一个实例的信号没动，它不该被牵连
    expect(second.chat.getState().error).not.toBeNull();
  });
});
