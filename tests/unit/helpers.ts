/**
 * 测试夹具
 * ----------------------------------------------------------------------------
 * 单元测试不打真实浏览器、不碰 jsdom 的 localStorage（那会让用例之间互相污染），
 * 而是注入一套可控的 Services。这正是把 store 写成工厂函数、把存储写成接口的回报：
 * 业务逻辑可以在几毫秒内跑完，还完全确定。
 */

import { createServices, type Services } from '@/services/container';
import { createBrowserStorage, type StorageLike } from '@/services/storage';
import { MockModelProvider } from '@/services/model';
import { createBrowserPlatformService } from '@/services/platform';
import type { ChatRequest, ModelConfig, OperationResult, StreamResult } from '@/types';
import type { ModelProvider } from '@/services/model';

/** 内存版 Web Storage，形状与 localStorage 一致，但完全隔离 */
export function createMemoryStorage(): StorageLike & { raw(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    raw: () => Object.fromEntries(map.entries()),
  };
}

/** 零延迟的 mock provider：行为与线上一致，只是不等定时器 */
export function createInstantProvider(reply?: string): MockModelProvider {
  return new MockModelProvider({
    thinkingDelayMs: 0,
    chunkDelayMs: 0,
    chunkSize: 12,
    ...(reply === undefined ? {} : { replyBuilder: () => reply }),
  });
}

/** 只记录请求、立刻返回固定文本，用来验证「请求是怎么组装的」 */
export function createCapturingProvider(reply = '好的，收到。'): ModelProvider & {
  captures: ChatRequest[];
} {
  const captures: ChatRequest[] = [];
  return {
    id: 'capture',
    label: '记录型 provider',
    performsNetworkRequest: false,
    captures,
    async testConnection(): Promise<OperationResult> {
      return { ok: true, message: 'ok' };
    },
    async streamChat(input: ChatRequest, onDelta: (text: string) => void): Promise<StreamResult> {
      captures.push(input);
      onDelta(reply);
      return { outcome: 'complete', text: reply };
    },
    abort() {
      /* 不用中断能力 */
    },
  };
}

/**
 * 逐字吐出、每吐一个字就停住等测试放行的 provider。
 * 用来精确验证「流式过程中」的行为：中途停止、界面上看到了什么、落库写了几次。
 */
export function createStepProvider(text: string): ModelProvider & {
  release(): void;
  aborted: boolean;
} {
  let release: (() => void) | null = null;

  const provider = {
    id: 'step',
    label: '逐字 provider',
    performsNetworkRequest: false,
    aborted: false,

    async testConnection(): Promise<OperationResult> {
      return { ok: true, message: 'ok' };
    },

    async streamChat(
      _input: ChatRequest,
      onDelta: (value: string) => void
    ): Promise<StreamResult> {
      let emitted = '';
      for (const character of text) {
        if (provider.aborted) break;
        emitted += character;
        onDelta(emitted);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (provider.aborted) break;
      }
      return { outcome: provider.aborted ? 'aborted' : 'complete', text: emitted };
    },

    abort() {
      provider.aborted = true;
      const pending = release;
      release = null;
      pending?.();
    },

    release() {
      const pending = release;
      release = null;
      pending?.();
    },
  };

  return provider;
}

/** 组装一套测试用 Services；只覆盖需要替换的那部分 */
export function createTestServices(overrides: Partial<Services> = {}): Services {
  return createServices({
    storage: createBrowserStorage(createMemoryStorage()),
    model: createInstantProvider(),
    platform: createBrowserPlatformService(),
    ...overrides,
  });
}

/** 轮询等待条件成立，避免用例里写死 sleep 时长 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1500
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor 超时：等待的条件始终没有成立');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const VALID_MODEL_CONFIG: ModelConfig = {
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-1234567890',
  modelName: 'gpt-4o-mini',
};
