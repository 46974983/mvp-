/**
 * MockModelProvider —— 阶段 A 的模型实现
 * ----------------------------------------------------------------------------
 * 技术方案第 5 节明确写着：「浏览器 Demo 仅允许使用 mock 数据，不连接真实模型」。
 * 原因是 API Key 不能明文落在浏览器里，真实请求要等阶段 B 由 Rust 侧发出。
 * 所以阶段 A 的这个实现不是「偷懒的占位」，而就是本阶段该有的东西。
 *
 * 它做得和真 provider 一样：
 *   - 同样的接口、同样的流式回调语义（每次给累计全文）
 *   - 支持真正的中断（abort 会立刻唤醒挂起的等待，不等定时器跑完）
 *   - testConnection 走的是和真实实现同一套校验规则
 * 唯一不同的是：它从本地文案池里取话，不发网络请求。
 */

import type { ChatRequest, ModelConfig, OperationResult, StreamResult } from '@/types';
import { validateModelConfig } from './schema';
import type { ModelProvider } from './types';

export interface MockModelProviderOptions {
  /** 首字前的等待，用来模拟「模型在想」 */
  thinkingDelayMs?: number;
  /** 每段之间的间隔 */
  chunkDelayMs?: number;
  /** 每次吐多少个字 */
  chunkSize?: number;
  /** 自定义文案生成器（测试里用来让输出完全确定） */
  replyBuilder?: (input: ChatRequest) => string;
}

const DEFAULTS = {
  thinkingDelayMs: 220,
  chunkDelayMs: 16,
  chunkSize: 2,
} as const;

const TEMPLATES: Array<(question: string) => string> = [
  (question) =>
    `收到，你说的是「${question}」。

这是**离线模拟回答**，不联网、不调用任何模型。它只出现在浏览器模式里 —— 想让模型真的回答，用桌面版本，API Key 会交给系统凭据管理器保管。

现在已经跑起来的几件事：

- 会话列表按最后更新时间倒序，最近聊的排最前
- 首条用户消息会自动成为会话标题
- 每条回复都记了状态，「说完的」和「被打断的」重启后仍然分得出来`,

  (question) =>
    `关于「${question}」，先给结论：流程是通的，剩下的是打磨。

值得盯的几处：

1. 输入框的多行体验和回车发送的分寸
2. 长会话滚到底部的位置是否自然
3. 出错时的措辞——要说清「哪一步出错了」，但不说出请求头、Key 这类东西

\`\`\`ts
// 桌面模式下，这段循环跑在 Rust 侧，前端只负责把累计文本画出来
for await (const delta of stream) {
  onDelta(accumulated + delta)
}
\`\`\``,

  (question) =>
    `「${question}」——这个答案取决于后面接哪个模型。

现在回答你的是 MockModelProvider，输出取自本地文案池，所以它答得再顺也证明不了模型能力。它能证明的是别的东西：

- 流式渲染在长文本下会不会抖
- 点「停止」之后，已经生成的部分有没有被保住

> 提示：右上角可以切换浅色 / 深色主题，选择会被记住。`,
];

function hashText(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function defaultReplyBuilder(input: ChatRequest): string {
  const lastUserTurn = [...input.messages].reverse().find((turn) => turn.role === 'user');
  const question = lastUserTurn?.content.trim() || '（没有内容）';
  const template = TEMPLATES[hashText(question) % TEMPLATES.length];
  return template ? template(question) : question;
}

export class MockModelProvider implements ModelProvider {
  readonly id = 'mock';
  readonly label = '离线模拟回答';
  readonly performsNetworkRequest = false;

  private readonly options: Required<MockModelProviderOptions>;
  private aborted = false;
  /** 用来在 abort 时立刻唤醒正在等待的定时器 */
  private wakePending: (() => void) | null = null;

  constructor(options: MockModelProviderOptions = {}) {
    this.options = {
      thinkingDelayMs: options.thinkingDelayMs ?? DEFAULTS.thinkingDelayMs,
      chunkDelayMs: options.chunkDelayMs ?? DEFAULTS.chunkDelayMs,
      chunkSize: options.chunkSize ?? DEFAULTS.chunkSize,
      replyBuilder: options.replyBuilder ?? defaultReplyBuilder,
    };
  }

  async testConnection(config: ModelConfig): Promise<OperationResult> {
    // 先走和真实实现相同的校验规则，再补一句说明当前生效的是哪个实现
    const validation = validateModelConfig(config);
    if (!validation.ok) return validation;

    return {
      ok: true,
      message:
        `配置格式没问题，模型「${config.modelName}」已记录。` +
        '当前是浏览器的离线模式，本次没有发起任何网络请求；' +
        '想验证真实连通性，请用桌面版本（npm run dev:desktop，或打包好的 exe）。',
    };
  }

  async streamChat(
    input: ChatRequest,
    onDelta: (text: string) => void
  ): Promise<StreamResult> {
    this.aborted = false;
    const fullText = this.options.replyBuilder(input);

    let emitted = '';
    await this.sleep(this.options.thinkingDelayMs);

    let cursor = 0;
    while (cursor < fullText.length) {
      if (this.aborted) break;
      cursor = Math.min(cursor + this.options.chunkSize, fullText.length);
      emitted = fullText.slice(0, cursor);
      onDelta(emitted);
      if (cursor >= fullText.length) break;
      await this.sleep(this.options.chunkDelayMs);
    }

    return { outcome: this.aborted ? 'aborted' : 'complete', text: emitted, toolCalls: [] };
  }

  abort(): void {
    this.aborted = true;
    this.wakePending?.();
  }

  /**
   * 可被 abort 打断的等待。
   * 不用 AbortSignal，是因为这里要的是「立刻醒过来」而不是「抛一个异常」——
   * 中断不是错误，是用户的正常操作。
   */
  private sleep(ms: number): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakePending = null;
        resolve();
      }, ms);
      this.wakePending = () => {
        clearTimeout(timer);
        this.wakePending = null;
        resolve();
      };
    });
  }
}
