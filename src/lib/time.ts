/**
 * 时间与摘要的展示格式化
 * ----------------------------------------------------------------------------
 * 抽出来的理由：这些是「展示规则」，不是「业务规则」。业务规则（比如会话按什么排序）
 * 在仓储层；这里只负责把时间戳变成人看得懂的字。纯函数，好测。
 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 列表里的相对时间：今天给时分，昨天给「昨天」，更早给月日 */
export function formatListTime(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);

  if (date.toDateString() === today.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';

  const sameYear = date.getFullYear() === today.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 消息气泡下方的绝对时间 */
export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 会话列表的摘要文案。
 * 用「最后一条非空消息」而不是「最后一条消息」：流式回复刚开始时内容是空的，
 * 直接取最后一条会让列表闪成空白。
 */
export function conversationPreview(contents: string[], maxLength = 42): string {
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const raw = contents[index] ?? '';
    const plain = raw
      .replace(/```[\s\S]*?```/g, ' 代码块 ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_~#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length === 0) continue;
    return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
  }
  return '还没有消息';
}
