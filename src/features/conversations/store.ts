/**
 * 会话 store（Zustand）
 * ----------------------------------------------------------------------------
 * 职责：维护「有哪些会话、当前在看哪一个、这个会话的消息」这三件事。
 * 它不知道界面长什么样，也不知道怎么渲染 —— 只负责把仓储的数据变成界面能直接用的形状，
 * 并在写操作之后保持内存和存储一致。
 *
 * 为什么做成工厂函数 createConversationsStore(services) 而不是模块级单例：
 *   测试里可以喂一套假的 Services，不起浏览器、不碰 localStorage，直接验证业务逻辑。
 *   应用运行时再由 src/features/index.ts 组装出唯一实例。
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { Conversation, Message, OperationResult } from '@/types';
import type { Services } from '@/services/container';

export interface ConversationsState {
  conversations: Conversation[];
  activeId: string | null;
  /** 当前会话的消息。只有当前会话会加载到内存，避免开久了把全部历史堆在内存里。 */
  messages: Message[];
  /** 首次加载是否完成，用于区分「还没加载」和「真的没有会话」 */
  loaded: boolean;
  /** 切换会话时正在读取目标消息，读取完成前暂时禁止发送 */
  switchingConversation: boolean;

  load(): Promise<void>;
  select(conversationId: string | null): Promise<void>;
  createConversation(): Promise<Conversation>;
  renameConversation(conversationId: string, title: string): Promise<OperationResult>;
  deleteConversation(conversationId: string): Promise<void>;
  /** 重新拉取当前会话的消息（流式写入之后用） */
  reloadActiveMessages(): Promise<void>;
  reloadConversations(): Promise<void>;
}

export type ConversationsStore = UseBoundStore<StoreApi<ConversationsState>>;

export function createConversationsStore(services: Services): ConversationsStore {
  const repo = services.storage.conversations;
  let selectionVersion = 0;

  return create<ConversationsState>((set, get) => ({
    conversations: [],
    activeId: null,
    messages: [],
    loaded: false,
    switchingConversation: false,

    async load() {
      const version = ++selectionVersion;
      const conversations = await repo.listConversations();
      // 自动恢复最近一次会话：列表已经按 updatedAt 倒序，取第一条即可
      const activeId = conversations[0]?.id ?? null;
      const messages = activeId ? await repo.listMessages(activeId) : [];
      if (version === selectionVersion) {
        set({ conversations, activeId, messages, loaded: true, switchingConversation: false });
      }
    },

    async select(conversationId) {
      const version = ++selectionVersion;
      if (get().activeId === conversationId) {
        if (get().switchingConversation) set({ switchingConversation: false });
        return;
      }

      set({ switchingConversation: true });
      try {
        const messages = conversationId ? await repo.listMessages(conversationId) : [];
        if (version !== selectionVersion) return;
        set({ activeId: conversationId, messages, switchingConversation: false });
      } catch (error) {
        if (version === selectionVersion) set({ switchingConversation: false });
        throw error;
      }
    },

    async createConversation() {
      const version = ++selectionVersion;
      set({ switchingConversation: true });
      try {
        const conversation = await repo.createConversation();
        const conversations = await repo.listConversations();
        if (version === selectionVersion) {
          set({
            conversations,
            activeId: conversation.id,
            messages: [],
            switchingConversation: false,
          });
        }
        return conversation;
      } catch (error) {
        if (version === selectionVersion) set({ switchingConversation: false });
        throw error;
      }
    },

    async renameConversation(conversationId, title) {
      const updated = await repo.renameConversation(conversationId, title);
      if (!updated) return { ok: false, message: '会话不存在，可能已被删除。' };
      set({ conversations: await repo.listConversations() });
      return { ok: true, message: '已重命名。' };
    },

    async deleteConversation(conversationId) {
      const version = ++selectionVersion;
      const { activeId } = get();
      set({ switchingConversation: true });
      try {
        await repo.deleteConversation(conversationId);

        const conversations = await repo.listConversations();
        // 删掉的正是当前会话时，退到列表里的下一条；一条都没有就留空
        const nextActiveId =
          activeId === conversationId ? (conversations[0]?.id ?? null) : activeId;
        const messages = nextActiveId ? await repo.listMessages(nextActiveId) : [];
        if (version === selectionVersion) {
          set({
            conversations,
            activeId: nextActiveId,
            messages,
            switchingConversation: false,
          });
        }
      } catch (error) {
        if (version === selectionVersion) set({ switchingConversation: false });
        throw error;
      }
    },

    async reloadActiveMessages() {
      const { activeId } = get();
      if (!activeId) {
        set({ messages: [] });
        return;
      }
      set({ messages: await repo.listMessages(activeId) });
    },

    async reloadConversations() {
      set({ conversations: await repo.listConversations() });
    },
  }));
}
