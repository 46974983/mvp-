import { describe, expect, it } from 'vitest';
import { summarizeForNotification } from '@/lib/text';

/**
 * 通知摘要
 * ----------------------------------------------------------------------------
 * 这个函数存在的理由：通知正文只有一两行的位置，直接塞原始 Markdown 会变成
 * 一排 `**`、`###` 和代码块围栏，用户得先「解析」一遍才知道说了什么。
 */
describe('通知摘要', () => {
  it('去掉标题、强调与行内代码的标记', () => {
    expect(summarizeForNotification('## 结论\n\n这段**回复**很*短*，还有 `code`。')).toBe(
      '结论 这段回复很短，还有 code。'
    );
  });

  it('代码块整段丢掉', () => {
    const text = '前面的话\n\n```ts\nconst a = 1;\n```\n\n后面的话';
    expect(summarizeForNotification(text)).toBe('前面的话 后面的话');
  });

  it('链接只留文字，图片整个丢掉', () => {
    expect(summarizeForNotification('见[文档](https://example.com)说明')).toBe('见文档说明');
    expect(summarizeForNotification('![截图](a.png)下面这段')).toBe('下面这段');
  });

  it('列表项与引用块的符号去掉', () => {
    expect(summarizeForNotification('- 第一\n- 第二')).toBe('第一 第二');
    expect(summarizeForNotification('> 引用的话')).toBe('引用的话');
    expect(summarizeForNotification('1. 第一步\n2. 第二步')).toBe('第一步 第二步');
  });

  it('换行与多余空白压成单个空格', () => {
    expect(summarizeForNotification('第一行\n\n\n第二行')).toBe('第一行 第二行');
  });

  it('超长按码点截断并加省略号', () => {
    const result = summarizeForNotification('一'.repeat(100), 10);
    expect(result).toBe(`${'一'.repeat(10)}…`);
  });

  it('不会把 emoji 切成半个字符', () => {
    // 按 UTF-16 单元截会把一个 emoji 劈成两半，渲染成一个方块
    const result = summarizeForNotification('😀'.repeat(50), 8);
    expect(result).toBe(`${'😀'.repeat(8)}…`);
    expect([...result].length).toBe(9);
  });

  it('短文本不截断也不加省略号', () => {
    expect(summarizeForNotification('就这一句')).toBe('就这一句');
  });

  it('没有内容时返回空串，而不是一堆残留符号', () => {
    expect(summarizeForNotification('')).toBe('');
    expect(summarizeForNotification('```\ncode\n```')).toBe('');
    expect(summarizeForNotification('   \n  ')).toBe('');
  });
});
