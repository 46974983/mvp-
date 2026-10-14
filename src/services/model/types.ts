/**
 * 模型层接口（ModelProvider）
 * ----------------------------------------------------------------------------
 * 对应技术方案第 5 节。这一层的存在意义：
 *   阶段 A 用 MockModelProvider（不联网），阶段 B 换成 Rust 侧发出的真实请求。
 *   界面对话框只认这个接口，不认「谁来回答」。换实现时界面不用动。
 *
 * 关键约束（来自 5. 数据与安全）：
 *   - apiKey 只在内存里传递，本层不得把 config 写进任何持久化位置或日志。
 *   - 系统提示词与用户消息在 ChatRequest 里是两个字段，不混在一起。
 */

import type { ChatRequest, ModelConfig, OperationResult, StreamResult } from '@/types';

export interface ModelProvider {
  /** 实现标识，展示在设置页，让用户知道「现在到底是谁在回答」 */
  readonly id: string;
  readonly label: string;
  /** 是否真的会发起网络请求。阶段 A 为 false，界面据此显示「离线模拟」提示。 */
  readonly performsNetworkRequest: boolean;

  /** 测试连接：只返回面向用户的一句话结论，不暴露请求头、状态码细节 */
  testConnection(config: ModelConfig): Promise<OperationResult>;

  /**
   * 流式对话。每产出一段文本调用一次 onDelta。
   * onDelta 收到的是「累计至今的完整文本」，不是增量片段 —— 界面直接覆盖渲染即可，
   * 不用自己维护拼接状态。
   */
  streamChat(input: ChatRequest, onDelta: (text: string) => void): Promise<StreamResult>;

  /** 中断当前流式调用。已生成的内容由调用方保留。 */
  abort(): void;
}
