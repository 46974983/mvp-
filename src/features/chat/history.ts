/**
 * 历史裁剪（上下文管理第一步：确定性裁剪）
 * ----------------------------------------------------------------------------
 * 「确定性」是这一步的关键：**还没引入摘要，也没有任何模型参与**。
 * 输入同样的一串消息，永远得到同样的一串结果 —— 出问题时能复现、能单测。
 *
 * 自动摘要是后面的事，这里刻意不做：把「按规则砍」和「用模型压」混在一起，
 * 一旦上下文出错就分不清是哪一环干的。
 */

import type { ChatAttachment, ChatTurn } from '@/types';

/**
 * 历史条数上限。
 *
 * **单位是消息条数，不是「轮」。** 一轮对话是「用户 + 助手」两条，
 * 所以 40 条大约等于 20 轮。以前这个常量叫 `MAX_HISTORY_TURNS`，
 * 名字和实际单位对不上，已改名。
 */
export const MAX_HISTORY_MESSAGES = 40;

/**
 * 历史部分的 UTF-8 字节上限。
 *
 * 为什么条数之外还要一个字节上限：**一条消息可以特别大**。
 * 带一张 2560×1440 截图的附件消息，base64 之后约 2.7 MB ——
 * 在条数上它只算 1 条，所以「40 条」最坏能拼出上百 MB 的请求体。
 *
 * 4 MB 这个数是这么定的：
 *   - 比一张截图的 base64（约 2.7 MB）大一些，保证**最近那张图能进上下文**；
 *     定得比它还小的话，带图的对话每次都会把图裁掉，「支持多模态」就白做了；
 *   - 又把最坏情况（40 条 × 约 2.7 MB ≈ 108 MB）压到 4 MB。
 */
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

/**
 * 一条消息进到请求体里占多少字节。
 *
 * 按**序列化之后再算 UTF-8 长度**，而不是 `content.length`：
 *   - 附件（尤其是截图的 dataURL）不在 `content` 里，按 content 算会当成 0；
 *   - 中文在 UTF-8 里是 3 字节，按字符数算会低估三倍。
 */
export function turnBytes(turn: ChatTurn): number {
  return new TextEncoder().encode(JSON.stringify(turn)).length;
}

/**
 * 按规则裁剪历史。
 *
 * 四条规则，顺序有意义：
 *
 * 1. **从最新往回取**，越旧的越先被丢掉 —— 上下文的价值随时间递减。
 * 2. **条数和字节两个上限都要满足**。碰到任一上限就停（不是跳过继续找：
 *    历史必须是一段连续的末尾，中间挖洞会让对话读起来前言不搭后语）。
 * 3. **首条必须是 `user`**。切在助手消息上，请求就以「助手自说自话」开头，
 *    有些服务端会挑这个毛病。多出来的开头几条直接丢掉。
 * 4. **兜底：一条都没留下时，至少带上最新那条 `user`。**
 *    把它也丢掉的话，这次请求里就没有「用户说了什么」了 ——
 *    宁可超一点预算，也不能发一个没有用户消息的请求。
 *
 * 注意：**这个函数只看传进来的消息**。工具调用的中间轮次（`toolTurns`）
 * 不经过这里，它们由工具轮数上限单独管着 —— 详见 `store.ts` 的调用处。
 */
export function trimHistory(turns: readonly ChatTurn[]): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let bytes = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;

    if (kept.length >= MAX_HISTORY_MESSAGES) break;

    const size = turnBytes(turn);
    if (bytes + size > MAX_HISTORY_BYTES) break;

    kept.push(turn);
    bytes += size;
  }

  kept.reverse();

  while (kept.length > 0 && kept[0]?.role !== 'user') {
    kept.shift();
  }

  if (kept.length === 0) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn?.role === 'user') return [turn];
    }
  }

  return kept;
}

// ---------------------------------------------------------------------------
// 附件身份与去重
// ---------------------------------------------------------------------------

/**
 * 附件身份的判定规则
 * ----------------------------------------------------------------------------
 * 一条附件的身份 = **kind + 来源路径 + 内容**。
 *
 * | 情况 | 判定 | 理由 |
 * | --- | --- | --- |
 * | 同一路径、内容相同 | **同一份**（重复，只留第一次） | 同一个文件被分两次发过来 |
 * | 同一路径、内容不同 | **不同附件**（两份都留） | 文件改过了，两个版本都有信息 |
 * | 不同路径、内容相同 | **不同附件**（两份都留） | 路径是模型引用它的方式；两份文件可能各自演化 |
 * | 截图，图片数据相同 | **同一份** | 同一张截图 |
 * | 截图，图片数据不同 | **不同附件** | 哪怕尺寸完全一样，也是两张不同的画面 |
 *
 * 「不同路径、内容相同」这一条是**刻意这么定的**：按内容合并看起来更省，
 * 但会让模型引用到一个它没见过的路径 —— 用户明明发了两个文件，
 * 模型却只能看到其中一个的路径，后面追问就会答错。
 *
 * 实现上**不做哈希**：先按「kind + 路径 + 内容长度」分桶，再在桶里做完整比较。
 * 哈希会有碰撞，而碰撞的后果是**静默丢掉一张用户给的文件** ——
 * 那比多传一份严重得多。
 */
export type SeenAttachments = Map<string, ChatAttachment[]>;

export function createSeenAttachments(): SeenAttachments {
  return new Map();
}

/**
 * 分桶用的廉价键。
 *
 * 用 `\u0000` 分隔：路径里不会出现这个字符，拼接不会把两个不同的附件拼成同一个键。
 * 桶键只用来**缩小比较范围**，判重始终以 `sameAttachment` 为准。
 */
function bucketKeyOf(attachment: ChatAttachment): string {
  if (attachment.kind === 'file') {
    return ['file', attachment.relativePath, String(attachment.content.length)].join('\u0000');
  }
  return ['screenshot', String(attachment.dataUrl.length)].join('\u0000');
}

/** 两条附件是不是同一份。这是身份规则的唯一实现，别在别处另写一套。 */
export function sameAttachment(left: ChatAttachment, right: ChatAttachment): boolean {
  if (left.kind === 'file' && right.kind === 'file') {
    return left.relativePath === right.relativePath && left.content === right.content;
  }
  if (left.kind === 'screenshot' && right.kind === 'screenshot') {
    return left.dataUrl === right.dataUrl;
  }
  return false;
}

/** 登记一条附件。返回 false 表示这份之前已经出现过。 */
function claim(attachment: ChatAttachment, seen: SeenAttachments): boolean {
  const key = bucketKeyOf(attachment);
  const bucket = seen.get(key);

  if (!bucket) {
    seen.set(key, [attachment]);
    return true;
  }
  if (bucket.some((existing) => sameAttachment(existing, attachment))) {
    return false;
  }

  bucket.push(attachment);
  return true;
}

/** 把一组消息里的附件登记进去，不改变消息本身。 */
export function rememberAttachments(
  turns: readonly ChatTurn[],
  seen: SeenAttachments
): void {
  for (const turn of turns) {
    for (const attachment of turn.attachments ?? []) {
      claim(attachment, seen);
    }
  }
}

/**
 * 去掉**后面重复出现**的附件，保留第一次出现的那份。
 *
 * 只作用于「要发给模型的消息」，**不碰持久化的消息**：
 * 界面和数据库里的历史一条都不能改 —— 用户看到自己确实发过两次，
 * 那是事实；模型只需要看一遍。
 *
 * 一条消息如果附件全被去掉、正文又是空的，它就不带任何信息了，整条跳过。
 * 正文非空的那种保留（比如工具结果那条「这是刚才抓到的截图」+ 图片，
 * 图片重复了，但这句话本身还在对话里）。
 */
export function dedupeAttachments(
  turns: readonly ChatTurn[],
  seen: SeenAttachments = createSeenAttachments()
): ChatTurn[] {
  const kept: ChatTurn[] = [];

  for (const turn of turns) {
    const attachments = turn.attachments ?? [];
    if (attachments.length === 0) {
      kept.push(turn);
      continue;
    }

    const unique = attachments.filter((attachment) => claim(attachment, seen));

    if (unique.length === 0 && turn.content.trim().length === 0) continue;

    kept.push(
      unique.length === attachments.length
        ? turn
        : { ...turn, attachments: unique.length > 0 ? unique : undefined }
    );
  }

  return kept;
}
