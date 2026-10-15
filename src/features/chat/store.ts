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
import { createLogger, toUserFacingError } from '@/lib/log';
import { summarizeForNotification } from '@/lib/text';
import type { ConversationsStore } from '@/features/conversations/store';
import type { SettingsStore } from '@/features/settings/store';

const logger = createLogger('chat');

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
  // `streaming` 要等几次存储 await 之后才会变成 true。单靠它拦不住用户
  // 在首个请求刚开始的这段窗口里快速连发，两个 send 会互相覆盖流式状态。
  let sendInFlight = false;

  /**
   * 回复有结果之后发一条系统通知。
   *
   * 三个刻意的地方：
   *
   * 1. **只有「说完了」和「出错了」才发**，用户自己点停止不发 ——
   *    他就在屏幕前，而且是他自己按的，再弹一条纯属添乱。
   * 2. **该不该打扰由平台层判断**（窗口在前台就跳过），这里只管说「有结果了」。
   *    前端拿不到窗口的焦点状态，硬做就得再加一条查询命令。
   * 3. **发不出去不影响对话**。通知是附加品，它失败绝不能让一轮已经成功的对话
   *    看起来像失败了，所以这里吞掉异常、只记日志。
   */
  async function notifyReplyFinished(summary: string): Promise<void> {
    const settingsState = settings.getState();

    // 先看环境有没有这个能力，而不是直接调用再吞异常 ——
    // 「不支持」是可预期的状态，不该用异常来表达；否则日志里每次回复都留一条噪音
    if (!settingsState.platformCapabilities.includes('notification')) return;
    if (!settingsState.settings.notification.onReplyComplete) return;

    const conversationState = conversations.getState();
    const active = conversationState.conversations.find(
      (item) => item.id === conversationState.activeId
    );
    const title = active?.title.trim() || settingsState.settings.persona.assistantName;

    try {
      await services.platform.showNotification({
        title,
        body: summarizeForNotification(summary),
      });
    } catch (error) {
      // 只是「这条通知没发出去」，不是对话失败
      logger.warn('发送回复完成通知失败', error);
    }
  }

  return create<ChatState>((set, get) => ({
    streaming: false,
    streamingMessageId: null,
    streamingText: '',
    error: null,
    lastOutcome: null,

    async send(rawText) {
      const text = rawText.trim();
      if (text.length === 0) return;
      if (sendInFlight || get().streaming) return;
      // 必须同步占锁，再进入任何 await；这样第二次调用会立刻被忽略。
      sendInFlight = true;

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

        // 用户中途点了停止就不打扰他：他就在屏幕前，而且是他自己按的
        if (result.outcome === 'complete') {
          await notifyReplyFinished(result.text);
        }
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
        const message = toUserFacingError(error, '生成回复时出了点问题，请重试。');
        set({ error: message });

        // 出错了也该告诉用户 —— 尤其是他切走的时候，否则消息就一直悄无声息地失败
        await notifyReplyFinished(message);
      } finally {
        sendInFlight = false;
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
