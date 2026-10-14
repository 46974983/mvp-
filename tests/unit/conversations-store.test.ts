import { describe, expect, it } from 'vitest';
import { createConversationsStore } from '@/features/conversations/store';
import { createTestServices } from './helpers';

async function setup() {
  const services = createTestServices();
  const store = createConversationsStore(services);

  const seed = async (title: string, contents: string[] = []) => {
    const conversation = await services.storage.conversations.createConversation({ title });
    for (const content of contents) {
      await services.storage.conversations.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        content,
      });
    }
    return conversation;
  };

  return { services, store, seed };
}

describe('会话列表加载', () => {
  it('没有历史数据时列表为空，且明确进入已加载状态', async () => {
    const { store } = await setup();
    await store.getState().load();

    expect(store.getState().conversations).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().loaded).toBe(true);
  });

  it('自动恢复最近一次会话，并把它到消息一起加载出来', async () => {
    const { store, services, seed } = await setup();
    const older = await seed('旧会话');
    const recent = await seed('新会话', ['最近说过的话']);
    await services.storage.conversations.touchConversation(recent.id, Date.now() + 60_000);

    await store.getState().load();

    expect(store.getState().activeId).toBe(recent.id);
    expect(store.getState().messages.map((message) => message.content)).toEqual([
      '最近说过的话',
    ]);
    expect(store.getState().conversations[0]?.id).toBe(recent.id);
    expect(older.id).not.toBe(store.getState().activeId);
  });
});

describe('新建与切换会话', () => {
  it('新建的会话立即成为当前会话，消息区清空', async () => {
    const { store } = await setup();
    await store.getState().load();

    const created = await store.getState().createConversation();

    expect(store.getState().activeId).toBe(created.id);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().conversations).toHaveLength(1);
  });

  it('切换会话时加载对应消息', async () => {
    const { store, seed } = await setup();
    const first = await seed('甲', ['甲的消息']);
    const second = await seed('乙', ['乙的消息']);

    await store.getState().load();
    await store.getState().select(first.id);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['甲的消息']);

    await store.getState().select(second.id);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['乙的消息']);
  });

  it('切换到一个不存在的会话时消息为空，不报错', async () => {
    const { store } = await setup();
    await store.getState().select('conv-missing');
    expect(store.getState().messages).toEqual([]);
  });
});

describe('重命名', () => {
  it('重命名成功后列表里的标题同步更新', async () => {
    const { store, seed } = await setup();
    const conversation = await seed('原名');
    await store.getState().load();

    const result = await store.getState().renameConversation(conversation.id, '新名字');

    expect(result.ok).toBe(true);
    expect(store.getState().conversations[0]?.title).toBe('新名字');
  });

  it('重命名不存在的会话时返回失败结果，而不是抛异常', async () => {
    const { store } = await setup();
    const result = await store.getState().renameConversation('conv-missing', '随便');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/会话不存在/);
  });
});

describe('删除与会话回退', () => {
  it('删掉当前会话后自动退到列表里的下一条', async () => {
    const { store, seed, services } = await setup();
    const older = await seed('旧会话');
    const recent = await seed('新会话');
    await services.storage.conversations.touchConversation(recent.id, Date.now() + 60_000);

    await store.getState().load();
    expect(store.getState().activeId).toBe(recent.id);

    await store.getState().deleteConversation(recent.id);

    expect(store.getState().conversations.map((item) => item.id)).toEqual([older.id]);
    expect(store.getState().activeId).toBe(older.id);
  });

  it('删掉最后一个会话后回到空状态', async () => {
    const { store, seed } = await setup();
    const only = await seed('唯一的会话');
    await store.getState().load();

    await store.getState().deleteConversation(only.id);

    expect(store.getState().conversations).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState().messages).toEqual([]);
  });

  it('删除非当前会话时，当前会话保持不变', async () => {
    const { store, seed, services } = await setup();
    const keep = await seed('要留的');
    const drop = await seed('要删的');
    await services.storage.conversations.touchConversation(keep.id, Date.now() + 60_000);

    await store.getState().load();
    await store.getState().deleteConversation(drop.id);

    expect(store.getState().activeId).toBe(keep.id);
  });
});
