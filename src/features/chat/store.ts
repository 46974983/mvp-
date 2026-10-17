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
import type { ChatAttachment, ChatRequest, ChatTurn, StreamOutcome, ToolCall } from '@/types';
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

/**
 * 一次对话里最多允许几轮「模型要东西 → 用户批 → 再问」。
 *
 * 上限是必须的：模型可能陷进「再要一个文件」的循环，而**每一轮都要用户点一次确认** ——
 * 没有上限的话，用户会被弹到烦，最后闭眼点允许。
 */
const MAX_TOOL_ROUNDS = 3;

export interface ChatState {
  /** 已开始一轮发送，但占位消息还没落库时也要算忙碌 */
  sending: boolean;
  streaming: boolean;
  /** 正在流式写入的那条消息 id，界面据此决定渲染哪段文本 */
  streamingMessageId: string | null;
  /** 正在流式写入的累计文本 */
  streamingText: string;
  /** 面向用户的错误提示，null 表示没有错误 */
  error: string | null;
  /** 上一次流式调用的收尾状态，界面用它提示「已停止」 */
  lastOutcome: StreamOutcome | null;
  /**
   * 已经挂上、但还没发出去的附件。
   *
   * 它们在**发送之前**一直留在内存里，只有点了发送才会写进消息。
   * 这样「挑了几个文件又反悔」不会在数据库里留下任何痕迹。
   */
  pendingAttachments: ChatAttachment[];
  /**
   * 模型请求访问内容、正在等用户批准。null 表示没有待处理的请求。
   *
   * 它还在的时候不许发新消息：那一轮的上下文会被插进来，工具结果就对不上了。
   */
  toolRequest: ToolRequest | null;

  send(text: string): Promise<void>;
  /**
   * 用户对「模型请求访问」做出决定之后继续这一轮对话。
   *
   * `approvals` 逐项对应 `toolRequest.calls`；没写到的项按「允许」处理。
   */
  resolveToolRequest(approvals: boolean[]): Promise<void>;
  /** 挂一个附件到待发送列表 */
  attach(attachment: ChatAttachment): void;
  /** 按下标移除待发送的附件 */
  detach(index: number): void;
  clearAttachments(): void;
  stop(): void;
  clearError(): void;
}

/** 一次等待用户批准的访问请求 */
export interface ToolRequest {
  /** 发起这次请求的那条助手消息 */
  messageId: string;
  /** 它当时说的话 —— 工具调用那一轮也可能带了文字，不能丢 */
  text: string;
  calls: ToolCall[];
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
  let cancelRequested = false;
  /**
   * 工具调用产生的中间轮次（assistant 的 tool_calls + 对应的 tool 结果）。
   *
   * 它们**只活在这一轮对话里**：协议要求工具结果必须和发起它的调用成对出现，
   * 而消息表里存的是「助手说了什么」这个投影，没有 `tool_call_id` 这种东西。
   * 所以重放历史时不复刻协议形状，只靠附件把内容带回去（见 README）。
   */
  let toolTurns: ChatTurn[] = [];
  /**
   * 当前这一轮占位消息的 id。
   *
   * 失败时要靠它找到「该标记成 error 的那条消息」——
   * `streamingMessageId` 要等几次 await 之后才赋值，
   * 而错误可能就发生在那些 await 里（比如建完占位消息、还没开始流式就挂了）。
   */
  let currentPlaceholderId: string | null = null;

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

  return create<ChatState>((set, get) => {
  // -------------------------------------------------------------------------
  // 工具调用（阶段 E）
  // -------------------------------------------------------------------------

  /**
   * 这次请求允许模型用哪些工具。
   *
   * **能力没开就不给** —— 截屏关着时不把 `take_screenshot` 传上去，
   * 模型连它存在都不知道。这比「先给它、执行时再拒」对用户友好：
   * 不会出现「模型一直在请求一个永远批不下来的东西」。
   */
  function availableTools(): string[] {
    const state = settings.getState();
    const capabilities = state.platformCapabilities;
    const tools: string[] = [];

    if (capabilities.includes('file-read') && state.fileAccessDirectory.length > 0) {
      tools.push('read_file');
    }
    if (capabilities.includes('screenshot') && state.screenshotEnabled) {
      tools.push('take_screenshot');
    }

    return tools;
  }

  /** 从模型给的参数里取 `path`。解析失败就当作没给 —— 不猜。 */
  function readPathArgument(raw: string): string | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const value = (parsed as { path?: unknown }).path;
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    } catch {
      return null;
    }
  }

  function baseName(path: string): string {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? path;
  }

  /**
   * 执行用户批准的访问请求，把结果整理成要发回模型的轮次。
   *
   * 注意这里**不做任何路径安全检查** —— 检查在 Rust 的 `read_authorized_file` 里。
   * 模型给的路径是不可信输入，但它是通过那条命令读的，
   * 四道防线（绝对路径、`..`、符号链接、前缀比对）一道都不会少。
   */
  async function executeToolCalls(
    calls: ToolCall[],
    approvals: boolean[]
  ): Promise<{ turns: ChatTurn[]; attachments: ChatAttachment[] }> {
    const turns: ChatTurn[] = [];
    const attachments: ChatAttachment[] = [];
    const screenshots: ChatAttachment[] = [];

    for (const [index, call] of calls.entries()) {
      // 没明确说「不允许」的都算允许：默认值在界面上是全选中的
      const allowed = approvals[index] !== false;

      if (!allowed) {
        turns.push({
          role: 'tool',
          content: '用户拒绝了这次访问。不要重复请求同一个东西，改用用户已经提供的信息回答。',
          toolCallId: call.id,
        });
        continue;
      }

      if (call.name === 'read_file') {
        const path = readPathArgument(call.arguments);
        if (!path) {
          turns.push({
            role: 'tool',
            content: '参数不合法：没有给出 path，或者 path 不是字符串。',
            toolCallId: call.id,
          });
          continue;
        }

        try {
          const file = await settings.getState().readFile(path);
          attachments.push({
            kind: 'file',
            name: baseName(path),
            relativePath: path,
            content: file.content,
            bytes: file.bytes,
            truncated: file.truncated,
          });
          turns.push({
            role: 'tool',
            content:
              `--- 文件：${path} ---\n${file.content}` +
              (file.truncated ? '\n（以上只是这个文件的开头部分，内容较长已被截断）' : ''),
            toolCallId: call.id,
          });
        } catch (cause) {
          turns.push({
            role: 'tool',
            content: `读取失败：${toUserFacingError(cause, '读取这个文件时出错了。')}`,
            toolCallId: call.id,
          });
        }
        continue;
      }

      if (call.name === 'take_screenshot') {
        try {
          const shot = await settings.getState().takeScreenshot();
          const attachment: ChatAttachment = {
            kind: 'screenshot',
            name: `屏幕截图 ${shot.width}×${shot.height}`,
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height,
            bytes: shot.bytes,
          };
          screenshots.push(attachment);
          turns.push({
            role: 'tool',
            // 工具结果只能是文本，图片走不通这条路 ——
            // 所以图片单独作为一条消息附在后面（见下面的 user 轮次）
            content: `已抓取一张 ${shot.width}×${shot.height} 的屏幕截图，图片作为下一条消息附上。`,
            toolCallId: call.id,
          });
        } catch (cause) {
          turns.push({
            role: 'tool',
            content: `截屏失败：${toUserFacingError(cause, '抓取屏幕时出错了。')}`,
            toolCallId: call.id,
          });
        }
        continue;
      }

      turns.push({
        role: 'tool',
        content: `不支持的工具：${call.name}。`,
        toolCallId: call.id,
      });
    }

    // 截图必须以「一条带图片的消息」的形式进去，不能塞进工具结果里。
    // 这里用一个明确的 user 轮次，模型能看到「这是刚抓的图」。
    if (screenshots.length > 0) {
      turns.push({
        role: 'user',
        content: '（这是刚才抓到的屏幕截图）',
        attachments: screenshots,
      });
      attachments.push(...screenshots);
    }

    return { turns, attachments };
  }

  /**
   * 跑一轮模型调用。
   *
   * 「一轮」= 建占位消息 → 发请求 → 流式写进去 → 收尾。
   * 工具调用会让这件事再来一遍，所以抽出来而不是复制两遍。
   *
   * 这一轮如果模型要求访问东西，**不在这里执行，而是停下来等用户批准** ——
   * 返回值通过 `toolRequest` 这个状态交给界面。
   */
  async function runRound(conversationId: string, attachments: ChatAttachment[]): Promise<void> {
    const placeholder = await repo.appendMessage({
      conversationId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      // 模型读过的文件挂在这一条回答上：重放历史时它们就是上下文，
      // 界面也能说明「这条回答参考了什么」
      attachments,
    });

    currentPlaceholderId = placeholder.id;

    // 关键一步：把占位消息同步进会话消息列表。
    // 少了这一步，界面在整段生成过程中看不到任何东西 —— 没有气泡、没有光标、
    // 流式文本也没有落点，回复会「最后一次性蹦出来」。
    await conversations.getState().reloadActiveMessages();

    if (cancelRequested) {
      await repo.updateMessage(placeholder.id, { status: 'aborted' });
      await conversations.getState().reloadActiveMessages();
      set({ lastOutcome: 'aborted' });
      return;
    }

    set({
      sending: false,
      streaming: true,
      streamingMessageId: placeholder.id,
      streamingText: '',
    });

    // 系统提示词与用户消息严格分开两个字段
    const { modelConfig, settings: appSettings } = settings.getState();
    const history = conversations
      .getState()
      .messages.filter(
        (message) =>
          message.id !== placeholder.id &&
          // 只发附件不写字的消息也要进历史 —— 单看 content 会把它整条丢掉，
          // 于是模型在下一轮就看不到那张图了
          (message.content.trim().length > 0 || message.attachments.length > 0)
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        attachments: message.attachments.length > 0 ? message.attachments : undefined,
      }));

    const request: ChatRequest = {
      model: modelConfig.modelName,
      systemPrompt: appSettings.persona.systemPrompt,
      // 工具中间轮次接在历史之后：它们只属于这一轮对话，不落库
      messages: [...history.slice(-MAX_HISTORY_TURNS), ...toolTurns],
      tools: availableTools(),
    };

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

    // 收尾：把最终文本和状态一次性写实
    await persist(true);
    await repo.updateMessage(placeholder.id, {
      content: result.text,
      status: result.outcome === 'complete' ? 'complete' : 'aborted',
    });
    await conversations.getState().reloadActiveMessages();
    await conversations.getState().reloadConversations();

    set({ lastOutcome: result.outcome, streamingMessageId: null, streamingText: '' });

    if (result.outcome !== 'complete') {
      toolTurns = [];
      return;
    }

    // 模型要求访问东西 —— 停下来等用户批准。
    // **每一次都要问**，不做「记住这次选择」：自动化任务不是一次授权长期有效的东西。
    if (result.toolCalls.length > 0) {
      const roundsUsed = toolTurns.filter((turn) => (turn.toolCalls?.length ?? 0) > 0).length;
      if (roundsUsed >= MAX_TOOL_ROUNDS) {
        toolTurns = [];
        set({
          error: `模型连续 ${MAX_TOOL_ROUNDS} 轮要求更多内容，已经停下。可以把它想要的东西直接附在消息里再问一次。`,
        });
        return;
      }

      set({
        toolRequest: { messageId: placeholder.id, text: result.text, calls: result.toolCalls },
      });
      return;
    }

    toolTurns = [];
    await notifyReplyFinished(result.text);
  }

  /** 一轮失败时的统一收尾：留下痕迹、给一句人话、清掉中间状态 */
  async function failCurrentRound(error: unknown, fallback: string): Promise<void> {
    // 先看这一轮的占位消息，再看流式那条 —— 错误可能发生在流式开始之前
    const messageId = currentPlaceholderId ?? get().streamingMessageId;
    if (messageId) {
      await repo
        .updateMessage(messageId, { content: get().streamingText, status: 'error' })
        .catch(() => undefined);
    }

    const message = toUserFacingError(error, fallback);
    toolTurns = [];
    set({ error: message, toolRequest: null });

    await notifyReplyFinished(message);
  }

    return {
    streaming: false,
    sending: false,
    streamingMessageId: null,
    streamingText: '',
    error: null,
    lastOutcome: null,
    pendingAttachments: [],
    toolRequest: null,

    attach(attachment) {
      // 同一种附件重复挂上去没有意义（尤其是截图，同一张挂两次纯属浪费），
      // 但也不拦着 —— 用户想同时看两个不同文件是完全合理的
      set({ pendingAttachments: [...get().pendingAttachments, attachment] });
    },

    detach(index) {
      set({
        pendingAttachments: get().pendingAttachments.filter((_, i) => i !== index),
      });
    },

    clearAttachments() {
      set({ pendingAttachments: [] });
    },

    async send(rawText) {
      const text = rawText.trim();
      // 只挂附件、不写字也是合法的一次发送 —— 单看 text 会把这种情况吞掉
      const attachments = get().pendingAttachments;
      if (text.length === 0 && attachments.length === 0) return;
      if (conversations.getState().switchingConversation) return;
      // 还在等用户批准模型的访问请求时，不许发新消息 ——
      // 否则那一轮的上下文会被新消息插进来，工具结果就对不上了
      if (sendInFlight || get().sending || get().streaming || get().toolRequest) return;
      // 必须同步占锁，再进入任何 await；这样第二次调用会立刻被忽略。
      sendInFlight = true;
      cancelRequested = false;
      // 新一轮对话，工具调用的中间轮次清空
      toolTurns = [];

      set({
        sending: true,
        error: null,
        lastOutcome: null,
        streamingMessageId: null,
        streamingText: '',
        toolRequest: null,
        // 附件从「待发送」挪进消息里，这一步之后它们归消息所有。
        // 在这里就清空，而不是等发送成功 —— 否则用户在网络往返期间
        // 能看到同一份附件既是待发送、又已经进了消息。
        pendingAttachments: [],
      });

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
          // 附件内容跟着消息一起存：多轮对话要重发整段历史，
          // 历史里的图片只剩引用的话，第二轮开始模型就看不到它了
          attachments,
        });
        await conversations.getState().reloadConversations();
        await conversations.getState().reloadActiveMessages();

        if (cancelRequested) {
          set({ lastOutcome: 'aborted' });
          return;
        }

        await runRound(conversationId, []);
      } catch (error) {
        await failCurrentRound(error, '生成回复时出了点问题，请重试。');
      } finally {
        sendInFlight = false;
        cancelRequested = false;
        set({ sending: false, streaming: false, streamingMessageId: null });
        await conversations.getState().reloadActiveMessages().catch(() => undefined);
      }
    },

    async resolveToolRequest(approvals) {
      const request = get().toolRequest;
      if (!request) return;

      const conversationId = conversations.getState().activeId;
      if (!conversationId) {
        set({ toolRequest: null });
        return;
      }

      sendInFlight = true;
      cancelRequested = false;
      set({ toolRequest: null, sending: true, error: null, lastOutcome: null });

      try {
        const outcome = await executeToolCalls(request.calls, approvals);

        // 模型的「工具调用」那条消息在这一轮里只是协议的一部分，
        // 它已经作为一条普通消息落过库了（内容是它说的话）。
        // 这里把它补回成带 tool_calls 的形状再发回去。
        toolTurns.push({
          role: 'assistant',
          content: request.text,
          toolCalls: request.calls,
        });
        toolTurns.push(...outcome.turns);

        await runRound(conversationId, outcome.attachments);
      } catch (error) {
        await failCurrentRound(error, '执行模型的访问请求时出了点问题。');
      } finally {
        sendInFlight = false;
        cancelRequested = false;
        set({ sending: false, streaming: false, streamingMessageId: null });
        await conversations.getState().reloadActiveMessages().catch(() => undefined);
      }
    },

    stop() {
      if (get().sending) {
        // 凭据读取、落库等准备工作不能被强制中断；等它们结束后不再启动模型请求。
        cancelRequested = true;
        return;
      }
      if (!get().streaming) return;
      // provider 会立刻唤醒挂起的等待；已生成的内容由 send() 的收尾逻辑保留
      services.model.abort();
    },

    clearError() {
      set({ error: null });
    },
    };
  });
}
