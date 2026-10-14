import { describe, expect, it } from 'vitest';
import {
  createBrowserStorage,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_PERSONA,
  defaultSettings,
  deriveTitleFromMessage,
} from '@/services/storage';
import { createMemoryStorage } from './helpers';

function setup() {
  const webStorage = createMemoryStorage();
  return { webStorage, storage: createBrowserStorage(webStorage) };
}

describe('会话仓储', () => {
  it('新建会话使用默认标题，并记下创建与更新时间', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    expect(conversation.title).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(conversation.archived).toBe(false);
    expect(conversation.createdAt).toBe(conversation.updatedAt);
  });

  it('会话列表按最后更新时间倒序，最近聊的排最前', async () => {
    const { storage } = setup();
    const first = await storage.conversations.createConversation({ title: '第一个' });
    const second = await storage.conversations.createConversation({ title: '第二个' });

    await storage.conversations.touchConversation(first.id, Date.now() + 10_000);

    const list = await storage.conversations.listConversations();
    expect(list.map((item) => item.title)).toEqual(['第一个', '第二个']);
    expect(list[1]?.id).toBe(second.id);
  });

  it('重命名时清理首尾空白，空白标题回退为「未命名会话」', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    const renamed = await storage.conversations.renameConversation(
      conversation.id,
      '  讨论下一步计划  '
    );
    expect(renamed?.title).toBe('讨论下一步计划');

    const blanked = await storage.conversations.renameConversation(conversation.id, '   ');
    expect(blanked?.title).toBe('未命名会话');
  });

  it('重命名不存在的会话时返回 null，不抛异常', async () => {
    const { storage } = setup();
    expect(await storage.conversations.renameConversation('missing', 'x')).toBeNull();
  });

  it('删除会话会级联删掉它的消息，不影响其他会话', async () => {
    const { storage } = setup();
    const doomed = await storage.conversations.createConversation();
    const kept = await storage.conversations.createConversation();

    await storage.conversations.appendMessage({
      conversationId: doomed.id,
      role: 'user',
      content: '这条会被一起删掉',
    });
    await storage.conversations.appendMessage({
      conversationId: kept.id,
      role: 'user',
      content: '这条要留着',
    });

    await storage.conversations.deleteConversation(doomed.id);

    expect(await storage.conversations.getConversation(doomed.id)).toBeNull();
    expect(await storage.conversations.listMessages(doomed.id)).toEqual([]);
    expect(await storage.conversations.listMessages(kept.id)).toHaveLength(1);
  });
});

describe('消息写入', () => {
  it('首条用户消息自动成为会话标题', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    await storage.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '帮我梳理一下这个流程\n后面还有第二行',
    });

    const updated = await storage.conversations.getConversation(conversation.id);
    expect(updated?.title).toBe('帮我梳理一下这个流程');
  });

  it('过长的首条消息会被截断并加省略号', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    await storage.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '一'.repeat(50),
    });

    const updated = await storage.conversations.getConversation(conversation.id);
    expect(updated?.title).toHaveLength(19);
    expect(updated?.title.endsWith('…')).toBe(true);
  });

  it('后续用户消息不再改写标题', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    await storage.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '第一句',
    });
    await storage.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '第二句',
    });

    const updated = await storage.conversations.getConversation(conversation.id);
    expect(updated?.title).toBe('第一句');
  });

  it('助手占位消息默认状态是 streaming，可被改成 aborted', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    const placeholder = await storage.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    expect(placeholder.status).toBe('streaming');

    const patched = await storage.conversations.updateMessage(placeholder.id, {
      content: '半句话',
      status: 'aborted',
    });
    expect(patched?.status).toBe('aborted');
    expect(patched?.content).toBe('半句话');
  });

  it('往不存在的会话里写消息会明确报错', async () => {
    const { storage } = setup();
    await expect(
      storage.conversations.appendMessage({
        conversationId: 'conv-not-exist',
        role: 'user',
        content: '你好',
      })
    ).rejects.toThrow(/会话不存在/);
  });

  it('消息按创建顺序返回', async () => {
    const { storage } = setup();
    const conversation = await storage.conversations.createConversation();

    for (const content of ['第一条', '第二条', '第三条']) {
      await storage.conversations.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        content,
      });
    }

    const messages = await storage.conversations.listMessages(conversation.id);
    expect(messages.map((message) => message.content)).toEqual([
      '第一条',
      '第二条',
      '第三条',
    ]);
  });
});

describe('设置为非敏感数据', () => {
  it('首次读取返回默认人格配置', async () => {
    const { storage } = setup();
    const settings = await storage.settings.getSettings();
    expect(settings.persona.assistantName.length).toBeGreaterThan(0);
    expect(settings.persona.systemPrompt.length).toBeGreaterThan(0);
  });

  it('可保存并读回人格配置', async () => {
    const { storage } = setup();
    await storage.settings.saveSettings({
      ...defaultSettings(),
      persona: { assistantName: '阿枢', userName: '老大', systemPrompt: '先给结论。' },
    });

    const settings = await storage.settings.getSettings();
    expect(settings.persona.assistantName).toBe('阿枢');
    expect(settings.persona.systemPrompt).toBe('先给结论。');
  });

  it('写进本地存储的内容里不含 API Key', async () => {
    const { webStorage, storage } = setup();
    await storage.settings.saveSettings({
      ...defaultSettings(),
      persona: { assistantName: '阿枢', userName: '老大', systemPrompt: '先给结论。' },
    });
    const conversation = await storage.conversations.createConversation();
    await storage.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'sk-should-never-be-persisted',
    });

    const persisted = JSON.stringify(webStorage.raw());
    expect(persisted).not.toMatch(/apiKey/i);
    // 备注：用户自己**输入**的正文当然会存下来，这是聊天记录的本分；
    // 这里要禁止的是「配置对象带着 Key 一起被序列化」。
  });
});

describe('数据损坏与写入失败', () => {
  it('存储里的数据损坏时退回空数据，不抛异常', async () => {
    const webStorage = createMemoryStorage();
    webStorage.setItem('desktop-ai-assistant:mvp', '{ 这不是合法 JSON');
    const storage = createBrowserStorage(webStorage);

    expect(await storage.conversations.listConversations()).toEqual([]);
    const settings = await storage.settings.getSettings();
    expect(settings.persona.assistantName.length).toBeGreaterThan(0);
  });

  it('结构不合法（缺少 conversations 数组）时同样退回空数据', async () => {
    const webStorage = createMemoryStorage();
    webStorage.setItem(
      'desktop-ai-assistant:mvp',
      JSON.stringify({ version: 1, settings: { persona: {} } })
    );
    const storage = createBrowserStorage(webStorage);

    expect(await storage.conversations.listConversations()).toEqual([]);
  });

  it('写入失败时抛出可读提示，而不是把原始异常直接甩给用户', async () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    const storage = createBrowserStorage(broken);

    await expect(storage.conversations.createConversation()).rejects.toThrow(
      /本地存储写入失败/
    );
  });

  it('reset 会清掉本实现管理的全部数据', async () => {
    const { webStorage, storage } = setup();
    await storage.conversations.createConversation();
    expect(Object.keys(webStorage.raw())).toHaveLength(1);

    await storage.reset();
    expect(webStorage.raw()).toEqual({});
  });
});

describe('标题推导规则', () => {
  it('取首行、去空白、超长截断', () => {
    expect(deriveTitleFromMessage('第一行\n第二行')).toBe('第一行');
    expect(deriveTitleFromMessage('   ')).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(deriveTitleFromMessage('短标题')).toBe('短标题');
    expect(deriveTitleFromMessage('一'.repeat(40))).toHaveLength(19);
  });
});

describe('模型配置与凭据去向', () => {
  it('saveModelConfig 只落非敏感投影，Key 不进存储', async () => {
    const { webStorage, storage } = setup();

    await storage.settings.saveModelConfig({
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'sk-should-not-be-stored-anywhere',
      modelName: 'gpt-4o-mini',
    });

    const persisted = JSON.stringify(webStorage.raw());
    expect(persisted).toContain('https://api.example.com/v1');
    expect(persisted).toContain('gpt-4o-mini');
    expect(persisted).not.toContain('sk-should-not-be-stored-anywhere');
    expect(persisted).not.toMatch(/apiKey/i);
  });

  it('保存后的模型投影能被读回来', async () => {
    const { storage } = setup();
    await storage.settings.saveModelConfig({
      apiUrl: 'https://api.example.com/v1',
      apiKey: '',
      modelName: 'my-model',
    });

    const settings = await storage.settings.getSettings();
    expect(settings.model.apiUrl).toBe('https://api.example.com/v1');
    expect(settings.model.modelName).toBe('my-model');
    // 人格配置不受影响
    expect(settings.persona.assistantName).toBe(DEFAULT_PERSONA.assistantName);
  });

  it('浏览器实现如实声明「凭据只留内存」，且永远报未保存', async () => {
    const { storage } = setup();

    expect(storage.credentialStorage.kind).toBe('memory');
    expect(await storage.settings.hasStoredApiKey()).toBe(false);

    // 清空是空操作，但接口必须存在 —— 调用方不该为「我在哪个环境」写分支
    await storage.settings.clearStoredApiKey();
    expect(await storage.settings.hasStoredApiKey()).toBe(false);
  });

  it('数据位置与凭据探针都能给出结论', async () => {
    const { storage } = setup();

    const location = await storage.resolveLocation();
    expect(location.path).toContain('localStorage');
    expect(location.driver).toBe(storage.driverName);

    const probe = await storage.probeCredentialStorage();
    expect(probe.ok).toBe(true);
    expect(probe.message.length).toBeGreaterThan(0);
  });
});
