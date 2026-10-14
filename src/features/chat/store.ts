/**
 * 聊天 store（Zustand）
 * ----------------------------------------------------------------------------
 * 这是整个应用里唯一编排「一轮对话」的地方：落用户消息 → 建占位消息 → 调 provider
 * 流式产出 → 收尾写状态 → 失败时给用户一句能看懂的话。
 *
 * 一个刻意的设计：流式过程中，字符**不写回会话 store**，而是存在本 store 的
 * streamingText 里，界面渲染时按 id 覆盖。原因有两个：
 *   1. 每来一段就重排整个消息数组，长会话下会明显掉帧；
 *   2. 真正的落盘由节流器负责（见 STREAM_PERSIST_INTERVAL_MS），
 *      避免把整份数据 JSON 化几十次每秒。
 * 收尾时统一 reload 一次，内存与存储重新对齐。
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ChatRequest, StreamOutcome } from '@/types';
import type { Services } from '@/services/container';
import { toUserFacingError } from '@/lib/log';
import type { ConversationsStore } from '@/features/conversations/store';
import type { SettingsStore } from '@/features/settings/store';

/** 流式过程中落盘的节流间隔：太长丢内容，太短白费 IO */
const STREAM_PERSIST_INTERVAL_MS = 400;

/** 传给模型的历史轮数上限。MVP 不做摘要压缩，先简单截断，避免请求无限膨胀。 */
const MAX_HISTORY_TURNS = 40;

export interface ChatState {
  streaming: boolean;
  /** 正在流式写入的那条消息 id，界面据此决定渲染哪段文本 */
  streamingMessageId: string | null;
  /** 正在流式写入的累计文本 */
  streamingText: string;
  /** 面向用户的错误提示，null 表示没有错误 */
  error: string | null;
  /** 上一次流式调用的收尾状态，界面用它提示「已停止」 */
  lastOutcome: StreamOutcome | null;

  send(text: string): Promise<void>;
  stop(): void;
  clearError(): void;
}

export type ChatStore = UseBoundStore<StoreApi<ChatState>>;

export function createChatStore(
  services: Services,
  conversations: ConversationsStore,
  settings: SettingsStore
): ChatStore {
  const repo = services.storage.conversations;

  return create<ChatState>((set, get) => ({
    streaming: false,
    streamingMessageId: null,
    streamingText: '',
    error: null,
    lastOutcome: null,

    async send(rawText) {
      const text = rawText.trim();
      if (text.length === 0) return;
      if (get().streaming) return;

      set({ error: null, lastOutcome: null });

      try {
        // ---- 1. 没有会话就先建一个，别让用户卡在空状态里 ----
        let conversationId = conversations.getState().activeId;
        if (!conversationId) {
          const created = await conversations.getState().createConversation();
          conversationId = created.id;
        }

        // ---- 2. 用户消息先落库，再谈回复 ----
        await repo.appendMessage({
          conversationId,
          role: 'user',
          content: text,
          status: 'complete',
        });
        await conversations.getState().reloadConversations();
        await conversations.getState().reloadActiveMessages();

        // ---- 3. 助手占位消息，状态先标成 streaming ----
        const placeholder = await repo.appendMessage({
          conversationId,
          role: 'assistant',
          content: '',
          status: 'streaming',
        });

        // 关键一步：把占位消息同步进会话消息列表。
        // 少了这一步，界面在整段生成过程中看不到任何东西 —— 没有气泡、没有光标、
        // 流式文本也没有落点，回复会「最后一次性蹦出来」。
        await conversations.getState().reloadActiveMessages();

        set({
          streaming: true,
          streamingMessageId: placeholder.id,
          streamingText: '',
        });

        // ---- 4. 组装请求：系统提示词与用户消息严格分开两个字段 ----
        const { modelConfig, settings: appSettings } = settings.getState();
        const history = conversations
          .getState()
          .messages.filter(
            (message) => message.id !== placeholder.id && message.content.trim().length > 0
          )
          .map((message) => ({ role: message.role, content: message.content }));

        const request: ChatRequest = {
          model: modelConfig.modelName,
          systemPrompt: appSettings.persona.systemPrompt,
          messages: history.slice(-MAX_HISTORY_TURNS),
        };

        // ---- 5. 流式消费 ----
        let buffer = '';
        let lastPersistAt = 0;
        let writeChain: Promise<unknown> = Promise.resolve();

        const persist = (force: boolean): Promise<unknown> => {
          const now = Date.now();
          if (!force && now - lastPersistAt < STREAM_PERSIST_INTERVAL_MS) return writeChain;
          lastPersistAt = now;
          const snapshot = buffer;
          // 串行化写入，避免并发写导致「后写的被先写的盖掉」
          writeChain = writeChain.then(() =>
            repo.updateMessage(placeholder.id, { content: snapshot })
          );
          return writeChain;
        };

        const result = await services.model.streamChat(request, (accumulated) => {
          buffer = accumulated;
          set({ streamingText: accumulated });
          void persist(false);
        });

        // ---- 6. 收尾：把最终文本和状态一次性写实 ----
        await persist(true);
        await repo.updateMessage(placeholder.id, {
          content: result.text,
          status: result.outcome === 'complete' ? 'complete' : 'aborted',
        });
        await conversations.getState().reloadActiveMessages();
        await conversations.getState().reloadConversations();

        set({ lastOutcome: result.outcome });
      } catch (error) {
        // 失败也要留下痕迹：把占位消息标成 error，并把已生成的部分留住
        const messageId = get().streamingMessageId;
        if (messageId) {
          await repo
            .updateMessage(messageId, {
              content: get().streamingText,
              status: 'error',
            })
            .catch(() => undefined);
        }
        set({
          error: toUserFacingError(error, '生成回复时出了点问题，请重试。'),
        });
      } finally {
        set({ streaming: false, streamingMessageId: null });
        await conversations.getState().reloadActiveMessages().catch(() => undefined);
      }
    },

    stop() {
      if (!get().streaming) return;
      // provider 会立刻唤醒挂起的等待；已生成的内容由 send() 的收尾逻辑保留
      services.model.abort();
    },

    clearError() {
      set({ error: null });
    },
  }));
}
