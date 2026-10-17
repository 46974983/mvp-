/**
 * 桌面版模型实现（Tauri → Rust → 模型服务）
 * ----------------------------------------------------------------------------
 * 阶段 A 的离线实现和这个实现的差别，不在「有没有回复」，而在三件事：
 *
 * 1. **请求从 Rust 发出**，不是从 WebView 发出。WebView 的 CSP 里
 *    connect-src 只放开了 IPC，它根本没有外网出口。
 * 2. **API Key 不经过前端**。`stream_chat` 命令没有 Key 参数 ——
 *    Rust 自己去系统凭据存储里取。前端从头到尾搬不动凭据。
 * 3. **中断是真的中断**。`abort()` 调 Rust 的 `cancel_chat`，
 *    Rust 侧的读取循环最多 200ms 内收手，已生成的部分照样保留。
 */

import { Channel, invoke } from '@tauri-apps/api/core';

import type {
  ChatRequest,
  ModelConfig,
  OperationResult,
  PendingToolCall,
  StreamResult,
} from '@/types';
import type { ModelProvider } from './types';

/** Rust 通过 Channel 推过来的事件 */
type StreamEvent =
  | {
      type: 'delta';
      /** 累计至今的完整文本 */
      text: string;
    }
  | {
      type: 'tool_call';
      /** 当前已收到的工具调用清单 */
      calls: PendingToolCall[];
    };

export function createTauriModelProvider(): ModelProvider {
  return {
    id: 'tauri-openai',
    label: 'OpenAI 兼容接口（Rust 侧发起）',
    performsNetworkRequest: true,

    async testConnection(config: ModelConfig): Promise<OperationResult> {
      // 表单里刚填的 Key 会一起传过去；留空则用系统凭据存储里已保存的那份
      return invoke<OperationResult>('test_connection', { config });
    },

    async streamChat(
      input: ChatRequest,
      onDelta: (text: string) => void,
      onToolProgress?: (calls: PendingToolCall[]) => void
    ): Promise<StreamResult> {
      // Channel 是 Tauri 2 给「Rust 主动推消息」准备的通道。
      // 用它而不是轮询命令，是因为流式输出天然是推送语义。
      const channel = new Channel<StreamEvent>();
      channel.onmessage = (event) => {
        if (event.type === 'delta') onDelta(event.text);
        else if (event.type === 'tool_call') onToolProgress?.(event.calls);
      };

      return invoke<StreamResult>('stream_chat', {
        request: input,
        onEvent: channel,
      });
    },

    abort(): void {
      // 不 await：abort 是同步接口，而且中断请求本身不需要结果。
      // 失败也不提示 —— 用户点「停止」时最不想要的就是一个错误弹窗。
      void invoke('cancel_chat');
    },
  };
}
