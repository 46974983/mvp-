/**
 * Markdown 渲染
 * ----------------------------------------------------------------------------
 * 为什么自己写而不引第三方：
 *   聊天场景只用到很小一部分 Markdown 语法，而流式渲染要求「渲染半截文本不能崩」。
 *   现成的库在遇到未闭合的代码块时行为各不相同，反而更难控。这里只手写需要的子集，
 *   并且明确处理「流式中间态」——未闭合的 ``` 当作「到结尾为止都是代码」，
 *   这样输出看起来是连续的，不会突然闪出一堆反引号。
 *
 * 安全：先整体转义 HTML，再做 Markdown 替换。用户消息和模型输出都走这里，
 * 所以 <script> 这类内容进不来。这是 XSS 防护的第一道，也是唯一必要的防线。
 *
 * 支持：标题 / 加粗 / 斜体 / 删除线 / 行内代码 / 代码块 / 引用 / 有序无序列表 / 分割线
 * 不支持（有意）：表格、图片、内联 HTML、脚注 —— 用不上，实现它们只会让解析器变脆。
 */

/** HTML 转义。导出让测试能直接验证，也让别处不用重复写一份。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 代码块占位符。用 NUL 包裹，正常文本里不可能出现。 */
const PREFIX = '\u0000CB';
const SUFFIX = '\u0000';
const PLACEHOLDER_RE = new RegExp(`${PREFIX}(\\d+)${SUFFIX}`, 'g');

function placeholder(index: number): string {
  return `${PREFIX}${index}${SUFFIX}`;
}

/** 行内语法。输入必须是已转义文本。 */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * 抽出代码块，换成占位符。
 * 正则同时匹配「已闭合」与「到文本结尾仍未闭合」——后者是流式渲染中途的常态。
 */
function extractCodeBlocks(escaped: string): { body: string; blocks: string[] } {
  const blocks: string[] = [];
  const body = escaped.replace(
    /```([\w#+-]*)\n?([\s\S]*?)(?:```|$)/g,
    (_match, lang: string, code: string) => {
      const index = blocks.length;
      const trimmed = code.replace(/\n$/, '');
      blocks.push(
        `<pre class="code-block" data-lang="${lang}"><code>${trimmed}</code></pre>`
      );
      return placeholder(index);
    }
  );
  return { body, blocks };
}

interface BlockContext {
  blocks: string[];
  /** 把含占位符的文本还原成最终 HTML */
  expand(text: string): string;
  /** 行内语法 + 占位符还原 */
  inline(text: string): string;
}

const ORDERED_MARKER = /^\s*\d+[.)]\s+/;
const UNORDERED_MARKER = /^\s*[-*+]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
/**
 * 引用标记。
 * 注意这里必须同时接受 `&gt;`：块级解析跑在「整体转义之后」，
 * 用户写的 `>` 早就变成 `&gt;` 了。只写 `/^>/` 会让引用永远匹配不上 ——
 * 这类 bug 不会报错，只会让功能静默失效，所以注释写明白。
 */
const QUOTE = /^(?:&gt;|>)\s?/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

function isBlockStart(line: string): boolean {
  return (
    /^\s*$/.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    UNORDERED_MARKER.test(line) ||
    ORDERED_MARKER.test(line) ||
    RULE.test(line.trim()) ||
    line.includes(PREFIX)
  );
}

/** 把一行里混着的「普通文字 + 代码块」按顺序铺开 */
function emitMixed(line: string, context: BlockContext, out: string[]): void {
  const chunks = line.split(PLACEHOLDER_RE);
  let buffer = '';

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? '';
    if (index % 2 === 0) {
      buffer += chunk;
      continue;
    }
    if (buffer.trim().length > 0) out.push(`<p>${context.inline(buffer)}</p>`);
    buffer = '';
    out.push(context.blocks[Number(chunk)] ?? '');
  }

  if (buffer.trim().length > 0) out.push(`<p>${context.inline(buffer)}</p>`);
}

function collectList(
  lines: string[],
  start: number,
  marker: RegExp,
  tag: 'ul' | 'ol',
  context: BlockContext,
  out: string[]
): number {
  const items: string[] = [];
  let cursor = start;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (marker.test(line)) {
      items.push(context.inline(line.replace(marker, '')));
      cursor += 1;
      continue;
    }
    // 缩进续行并进上一条，避免"折行"在列表里被切断
    if (items.length > 0 && /^\s+\S/.test(line)) {
      const last = items[items.length - 1] ?? '';
      items[items.length - 1] = `${last} ${context.inline(line.trim())}`;
      cursor += 1;
      continue;
    }
    break;
  }

  out.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
  return cursor;
}

function renderBlocks(body: string, blocks: string[]): string {
  const lines = body.split('\n');
  const out: string[] = [];

  const expand = (text: string): string =>
    text.replace(PLACEHOLDER_RE, (_match, index: string) => blocks[Number(index)] ?? '');

  const context: BlockContext = {
    blocks,
    expand,
    inline: (text: string) => expand(renderInline(text)),
  };

  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';

    if (/^\s*$/.test(line)) {
      cursor += 1;
      continue;
    }

    // 含代码块的行：单独铺开，保证 <pre> 不落进 <p> 里
    if (line.includes(PREFIX)) {
      emitMixed(line, context, out);
      cursor += 1;
      continue;
    }

    if (RULE.test(line.trim())) {
      out.push('<hr>');
      cursor += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length, 3);
      out.push(`<h${level}>${context.inline(heading[2] ?? '')}</h${level}>`);
      cursor += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const collected: string[] = [];
      while (cursor < lines.length && QUOTE.test(lines[cursor] ?? '')) {
        collected.push((lines[cursor] ?? '').replace(QUOTE, ''));
        cursor += 1;
      }
      out.push(`<blockquote>${context.inline(collected.join('<br>'))}</blockquote>`);
      continue;
    }

    if (UNORDERED_MARKER.test(line)) {
      cursor = collectList(lines, cursor, UNORDERED_MARKER, 'ul', context, out);
      continue;
    }

    if (ORDERED_MARKER.test(line)) {
      cursor = collectList(lines, cursor, ORDERED_MARKER, 'ol', context, out);
      continue;
    }

    // 段落：一直吃到下一个块级元素
    const paragraph: string[] = [];
    while (cursor < lines.length && !isBlockStart(lines[cursor] ?? '')) {
      paragraph.push(lines[cursor] ?? '');
      cursor += 1;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${context.inline(paragraph.join('<br>'))}</p>`);
    }
  }

  return out.join('\n');
}

/**
 * 把 Markdown 文本渲染成 HTML 字符串。
 * 返回值直接喂给 dangerouslySetInnerHTML —— 因为已做过整体转义，这是安全的。
 */
export function renderMarkdown(source: string): string {
  if (!source) return '';
  const { body, blocks } = extractCodeBlocks(escapeHtml(source));
  return renderBlocks(body, blocks);
}

/** 去掉 Markdown 记号的纯文本版本，用于会话列表的摘要 */
export function stripMarkdown(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
