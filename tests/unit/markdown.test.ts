import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown, stripMarkdown } from '@/lib/markdown';

describe('HTML 转义', () => {
  it('转义尖括号、& 和引号', () => {
    expect(escapeHtml('<a href="x">A & B</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;A &amp; B&lt;/a&gt;'
    );
  });

  it('原始 HTML 标签不可能被渲染出来', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('代码块里的标签同样被转义', () => {
    const html = renderMarkdown('```\n<b>加粗</b>\n```');
    expect(html).toContain('&lt;b&gt;加粗&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('行内语法', () => {
  it('加粗、斜体、删除线、行内代码', () => {
    expect(renderMarkdown('这是 **重点**')).toBe('<p>这是 <strong>重点</strong></p>');
    expect(renderMarkdown('*斜体* 开头')).toBe('<p><em>斜体</em> 开头</p>');
    expect(renderMarkdown('~~删掉~~')).toBe('<p><del>删掉</del></p>');
    expect(renderMarkdown('用 `npm run dev` 启动')).toBe(
      '<p>用 <code class="inline-code">npm run dev</code> 启动</p>'
    );
  });

  it('行内代码里的星号不被当作语法', () => {
    expect(renderMarkdown('`a * b`')).toBe(
      '<p><code class="inline-code">a * b</code></p>'
    );
  });
});

describe('代码块', () => {
  it('带语言的代码块会记下语言名', () => {
    expect(renderMarkdown('```ts\nlet a = 1;\n```')).toBe(
      '<pre class="code-block" data-lang="ts"><code>let a = 1;</code></pre>'
    );
  });

  it('未闭合的代码块照样渲染 —— 流式输出中途就是这个形态', () => {
    const html = renderMarkdown('```js\nlet a = 2;');
    expect(html).toContain('class="code-block"');
    expect(html).toContain('let a = 2;');
    // 不应该把裸反引号留在屏幕上
    expect(html).not.toContain('```');
  });

  it('代码块不会嵌进段落里', () => {
    const html = renderMarkdown('看这段：\n```ts\nlet a = 1;\n```');
    expect(html).toBe(
      '<p>看这段：</p>\n<pre class="code-block" data-lang="ts"><code>let a = 1;</code></pre>'
    );
  });

  it('多行代码保留换行（外层用 white-space: pre 渲染）', () => {
    const html = renderMarkdown('```\n第一行\n第二行\n```');
    expect(html).toContain('第一行\n第二行');
  });
});

describe('块级语法', () => {
  it('标题只做到三级，更深的降级到三级', () => {
    expect(renderMarkdown('# 一级')).toBe('<h1>一级</h1>');
    expect(renderMarkdown('## 二级')).toBe('<h2>二级</h2>');
    expect(renderMarkdown('#### 四级')).toBe('<h3>四级</h3>');
  });

  it('无序列表与有序列表', () => {
    expect(renderMarkdown('- 甲\n- 乙')).toBe('<ul><li>甲</li><li>乙</li></ul>');
    expect(renderMarkdown('1. 甲\n2. 乙')).toBe('<ol><li>甲</li><li>乙</li></ol>');
  });

  it('列表项的缩进续行会并进上一条，而不是断成新段落', () => {
    const html = renderMarkdown('- 第一项\n  续行内容\n- 第二项');
    expect(html).toBe('<ul><li>第一项 续行内容</li><li>第二项</li></ul>');
  });

  it('引用与分割线', () => {
    expect(renderMarkdown('> 提示一句')).toBe('<blockquote>提示一句</blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('连续文本行用 br 连接在同一个段落里', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行<br>第二行</p>');
  });

  it('空行分段落', () => {
    expect(renderMarkdown('第一段\n\n第二段')).toBe('<p>第一段</p>\n<p>第二段</p>');
  });

  it('混合文档的块顺序保持原样', () => {
    const html = renderMarkdown('# 标题\n\n- 甲\n\n> 引用');
    expect(html).toBe('<h1>标题</h1>\n<ul><li>甲</li></ul>\n<blockquote>引用</blockquote>');
  });
});

describe('边界情况', () => {
  it('空输入返回空字符串', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('只有空白时不产生空段落', () => {
    expect(renderMarkdown('   \n\n  ')).toBe('');
  });

  it('stripMarkdown 去掉记号，用于列表摘要', () => {
    expect(stripMarkdown('# 标题 **加粗** `代码`')).toBe('标题 加粗 代码');
    expect(stripMarkdown('```js\nlet a = 1;\n``` 后面的话')).toBe('后面的话');
  });
});
