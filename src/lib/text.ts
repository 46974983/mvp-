/**
 * 文本处理
 * ----------------------------------------------------------------------------
 * 目前只有一件事：把 Markdown 回复压成一句能进系统通知的短文本。
 *
 * 为什么需要它：通知的正文只有一两行的位置，直接塞原始 Markdown 会出现
 * 一排 `**`、`###` 和代码块围栏，用户得先「解析」一遍才知道说了什么。
 */

/** 代码块在通知里没有存在意义，删掉比留一行 ``` 好 */
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`]*)`/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const HEADING = /^\s{0,3}#{1,6}\s+/gm;
const QUOTE = /^\s{0,3}>\s?/gm;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+\.)\s+/gm;
const BOLD = /(\*\*|__)(.*?)\1/g;
const ITALIC = /(\*|_)(.*?)\1/g;
const WHITESPACE = /\s+/g;

/**
 * 把 Markdown 压成一句纯文本摘要。
 *
 * 只做「去格式 + 截断」，不做智能摘要 —— 通知的作用是让用户知道
 * 「哪个会话有结果了」，点开来看才是正文该待的地方。
 *
 * 截断按**码点**而不是 UTF-16 单元，否则遇到 emoji 会切出半个字符，
 * 变成一个方块。
 */
export function summarizeForNotification(markdown: string, limit = 60): string {
  const flattened = markdown
    .replace(FENCED_CODE, ' ')
    .replace(INLINE_CODE, '$1')
    .replace(IMAGE, '')
    .replace(LINK, '$1')
    .replace(HEADING, '')
    .replace(QUOTE, '')
    .replace(LIST_ITEM, '')
    .replace(BOLD, '$2')
    .replace(ITALIC, '$2')
    .replace(WHITESPACE, ' ')
    .trim();

  const codePoints = [...flattened];
  if (codePoints.length <= limit) return flattened;
  return `${codePoints.slice(0, limit).join('').trimEnd()}…`;
}
