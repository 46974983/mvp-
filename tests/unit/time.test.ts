import { describe, expect, it } from 'vitest';
import { conversationPreview, formatListTime } from '@/lib/time';

/** 固定一个「现在」，否则用例会随实际时间漂移 */
const NOW = new Date(2026, 9, 14, 15, 30, 0).getTime(); // 2026-10-14 15:30

describe('会话列表的时间展示', () => {
  it('今天的会话显示时分', () => {
    const morning = new Date(2026, 9, 14, 9, 5, 0).getTime();
    expect(formatListTime(morning, NOW)).toBe('09:05');
  });

  it('昨天的会话显示「昨天」', () => {
    const yesterday = new Date(2026, 9, 13, 23, 0, 0).getTime();
    expect(formatListTime(yesterday, NOW)).toBe('昨天');
  });

  it('今年的更早会话显示月日', () => {
    const earlier = new Date(2026, 8, 3, 10, 0, 0).getTime();
    expect(formatListTime(earlier, NOW)).toBe('9月3日');
  });

  it('跨年的会话带上年份，避免「1月5日」分不清是哪年', () => {
    const lastYear = new Date(2025, 0, 5, 10, 0, 0).getTime();
    expect(formatListTime(lastYear, NOW)).toBe('2025/01/05');
  });
});

describe('会话摘要', () => {
  it('取最后一条非空消息，跳过流式过程中的空占位', () => {
    expect(conversationPreview(['第一句', '第二句', ''])).toBe('第二句');
  });

  it('全部为空时给出「还没有消息」', () => {
    expect(conversationPreview([])).toBe('还没有消息');
    expect(conversationPreview(['', '   '])).toBe('还没有消息');
  });

  it('清掉 Markdown 记号并折叠空白', () => {
    expect(conversationPreview(['## 标题\n\n**加粗**   内容'])).toBe('标题 加粗 内容');
  });

  it('代码块折叠成「代码块」而不是倾倒整段代码', () => {
    expect(conversationPreview(['看这里 ```ts\nlet a = 1;\n``` 结束'])).toBe('看这里 代码块 结束');
  });

  it('过长的摘要被截断', () => {
    const preview = conversationPreview(['一'.repeat(100)], 20);
    expect(preview).toHaveLength(21);
    expect(preview.endsWith('…')).toBe(true);
  });
});
