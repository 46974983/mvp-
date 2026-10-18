import { describe, expect, it } from 'vitest';
import {
  createSeenAttachments,
  dedupeAttachments,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  rememberAttachments,
  sameAttachment,
  trimHistory,
  turnBytes,
} from '@/features/chat/history';
import type { ChatAttachment, ChatTurn } from '@/types';

function user(content: string, attachments: ChatAttachment[] = []): ChatTurn {
  return { role: 'user', content, attachments: attachments.length > 0 ? attachments : undefined };
}

function assistant(content: string): ChatTurn {
  return { role: 'assistant', content };
}

function bigFile(content: string): ChatAttachment {
  return {
    kind: 'file',
    name: 'big.txt',
    relativePath: 'big.txt',
    content,
    bytes: content.length,
    truncated: false,
  };
}

/** 造一段 n 条、用户与助手交替、以用户开头的历史 */
function conversation(n: number): ChatTurn[] {
  return Array.from({ length: n }, (_, index) =>
    index % 2 === 0 ? user(`问题 ${index}`) : assistant(`回答 ${index}`)
  );
}

function totalBytes(turns: readonly ChatTurn[]): number {
  return turns.reduce((sum, turn) => sum + turnBytes(turn), 0);
}

describe('历史裁剪', () => {
  it('空历史裁完还是空', () => {
    expect(trimHistory([])).toEqual([]);
  });

  it('短历史原样保留', () => {
    const turns = [user('你好'), assistant('你好，有什么可以帮你的？'), user('看看这个')];
    expect(trimHistory(turns)).toEqual(turns);
  });

  it('恰好到条数上限时不裁', () => {
    const turns = conversation(MAX_HISTORY_MESSAGES);
    expect(trimHistory(turns)).toHaveLength(MAX_HISTORY_MESSAGES);
  });

  it('超过一条就只丢掉最旧的那一条（连同被挤到开头的助手消息）', () => {
    // 41 条、以用户开头：留下最新的 40 条之后，第一条是助手消息，
    // 按「首条必须是 user」的规则再丢掉它 —— 所以是 39 条。
    // 这个数字不是凑的，是两条规则叠加的结果。
    const turns = conversation(MAX_HISTORY_MESSAGES + 1);
    const kept = trimHistory(turns);

    expect(kept).toHaveLength(MAX_HISTORY_MESSAGES - 1);
    expect(kept[0]?.role).toBe('user');
    // 保留的一定是最新那一批
    expect(kept.at(-1)).toEqual(turns.at(-1));
  });

  it('首条永远是 user：切在助手消息上时把它丢掉', () => {
    // 条数够、字节也够，只有「开头是助手」这一个问题
    const turns = [assistant('开场白'), user('问题'), assistant('回答'), user('再问')];
    const kept = trimHistory(turns);

    expect(kept[0]?.role).toBe('user');
    expect(kept).toHaveLength(3);
  });

  it('字节上限生效：大附件把老消息挤出去', () => {
    // 每条约 1.5 MB，四条总量超过 4 MB
    const chunk = 'x'.repeat(1_500_000);
    const turns = Array.from({ length: 4 }, (_, index) => user(`第 ${index} 条`, [bigFile(chunk)]));

    const kept = trimHistory(turns);

    expect(kept.length).toBeLessThan(4);
    // 留下来的总量必须真的在上限以内 —— 只看条数是不够的
    expect(totalBytes(kept)).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    // 留下来的是最新的那些
    expect(kept.at(-1)).toEqual(turns.at(-1));
  });

  it('附件内容计入字节预算，纯文本不计', () => {
    // 同样是两条消息：带大附件的那组必须被裁，不带的不该被裁
    const chunk = 'x'.repeat(3_000_000);
    const withAttachment = [user('看看', [bigFile(chunk)]), user('再看', [bigFile(chunk)])];
    const plain = [user('看看'), user('再看')];

    expect(trimHistory(withAttachment).length).toBeLessThan(withAttachment.length);
    expect(trimHistory(plain)).toHaveLength(2);
  });

  it('中文按 UTF-8 字节算，不按字符数算', () => {
    // 4000 个汉字是 12000 字节。按字符数算会低估三倍
    const chinese = '字'.repeat(4000);
    const bytes = turnBytes(user(chinese));

    expect(bytes).toBeGreaterThan(chinese.length * 2);
  });

  it('只有附件、没有文字的消息也算一条', () => {
    const turns = [user(''), user('', [bigFile('内容')]), user('最后一句')];
    const kept = trimHistory(turns);

    // 中间那条虽然 content 是空的，但它是合法的一条消息，不该被跳过
    expect(kept).toHaveLength(3);
  });

  it('单条就超预算时兜底保留它 —— 不能发一个没有用户消息的请求', () => {
    // 6 MB 的附件：按预算一条都放不下
    const turns = [user('很早的问题'), user('这个很大', [bigFile('x'.repeat(6_000_000))])];
    const kept = trimHistory(turns);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.content).toBe('这个很大');
  });

  it('找不到 user 消息时返回空，不硬塞助手消息', () => {
    expect(trimHistory([assistant('只有助手说的话')])).toEqual([]);
  });

  it('裁剪结果是一段连续的末尾，中间不挖洞', () => {
    // 越旧越先丢：留下的一定是原数组的一个后缀
    const turns = conversation(MAX_HISTORY_MESSAGES + 10);
    const kept = trimHistory(turns);
    const suffix = turns.slice(turns.length - kept.length);

    expect(kept).toEqual(suffix);
  });
});

// ---------------------------------------------------------------------------
// 附件身份与去重
// ---------------------------------------------------------------------------

function fileAt(relativePath: string, content: string): ChatAttachment {
  return {
    kind: 'file',
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
    content,
    bytes: content.length,
    truncated: false,
  };
}

function shot(dataUrl: string): ChatAttachment {
  return {
    kind: 'screenshot',
    name: '屏幕截图',
    dataUrl,
    width: 2560,
    height: 1440,
    bytes: 1024,
  };
}

function userWith(content: string, attachments: ChatAttachment[]): ChatTurn {
  return { role: 'user', content, attachments };
}

/** 数一下一串消息里带了几份附件 */
function countAttachments(turns: readonly ChatTurn[]): number {
  return turns.reduce((sum, turn) => sum + (turn.attachments?.length ?? 0), 0);
}

describe('附件身份', () => {
  it('同一路径、同一内容算同一份', () => {
    expect(sameAttachment(fileAt('a.md', '内容'), fileAt('a.md', '内容'))).toBe(true);
  });

  it('同一路径、内容不同算两份 —— 文件改过了', () => {
    expect(sameAttachment(fileAt('a.md', '旧内容'), fileAt('a.md', '新内容'))).toBe(false);
  });

  it('不同路径、同一内容算两份（既定规则：路径是身份的一部分）', () => {
    // 按内容合并会让模型引用到一个它没见过的路径，所以刻意不合并
    expect(sameAttachment(fileAt('a.md', '一样的'), fileAt('b.md', '一样的'))).toBe(false);
  });

  it('截图按图片数据判身份，不看名字和尺寸', () => {
    const first = shot('data:image/png;base64,AAA');
    const sameAgain = { ...shot('data:image/png;base64,AAA'), name: '另一张' };
    const different = shot('data:image/png;base64,BBB');

    expect(sameAttachment(first, sameAgain)).toBe(true);
    expect(sameAttachment(first, different)).toBe(false);
  });

  it('文件与截图永远不是同一份', () => {
    expect(sameAttachment(fileAt('a.md', 'x'), shot('data:image/png;base64,AAA'))).toBe(false);
  });
});

describe('附件去重', () => {
  it('同一个文件分两次发送，只保留第一次那份', () => {
    const turns = [
      userWith('第一次', [fileAt('notes.md', '内容')]),
      assistant('好'),
      userWith('第二次', [fileAt('notes.md', '内容')]),
    ];

    const kept = dedupeAttachments(turns);

    expect(countAttachments(kept)).toBe(1);
    // 保留的是**第一次**出现的那份
    expect(kept[0]?.attachments).toHaveLength(1);
    // 第二轮那条消息本身还在（正文不能丢），只是不带附件了
    expect(kept[2]?.content).toBe('第二次');
    expect(kept[2]?.attachments).toBeUndefined();
    expect(kept).toHaveLength(3);
  });

  it('同一路径内容变化时两个版本都保留', () => {
    const turns = [
      userWith('旧版', [fileAt('notes.md', '第一版')]),
      assistant('好'),
      userWith('新版', [fileAt('notes.md', '第二版')]),
    ];

    expect(countAttachments(dedupeAttachments(turns))).toBe(2);
  });

  it('不同路径的同名文件都保留', () => {
    const turns = [
      userWith('这个', [fileAt('a/notes.md', '一样的内容')]),
      assistant('好'),
      userWith('那个', [fileAt('b/notes.md', '一样的内容')]),
    ];

    expect(countAttachments(dedupeAttachments(turns))).toBe(2);
  });

  it('同一张截图重复出现只保留一份', () => {
    const turns = [
      userWith('看图1', [shot('data:image/png;base64,SAME')]),
      assistant('看到了'),
      userWith('看图2', [shot('data:image/png;base64,SAME')]),
    ];

    expect(countAttachments(dedupeAttachments(turns))).toBe(1);
  });

  it('两张不同的截图（尺寸一样）不会被误判成同一张', () => {
    const turns = [
      userWith('第一张', [shot('data:image/png;base64,ONE')]),
      assistant('嗯'),
      userWith('第二张', [shot('data:image/png;base64,TWO')]),
    ];

    expect(countAttachments(dedupeAttachments(turns))).toBe(2);
  });

  it('附件全被去掉、正文又空的消息整条跳过', () => {
    const turns = [
      userWith('', [fileAt('notes.md', '内容')]),
      assistant('好'),
      // 这条只有附件没写字，附件又是重复的 —— 去掉之后什么都不剩
      userWith('', [fileAt('notes.md', '内容')]),
    ];

    const kept = dedupeAttachments(turns);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.attachments).toHaveLength(1);
  });

  it('没有附件的消息原样通过，一个都不少', () => {
    const turns = [user('一'), assistant('二'), user('三')];
    expect(dedupeAttachments(turns)).toEqual(turns);
  });

  it('共享已见集合时，后一批消息里的重复附件也会被去掉', () => {
    // 这就是「工具轮次里的附件与历史里的重复」那条规则的底层机制
    const seen = createSeenAttachments();
    const history = [userWith('', [shot('data:image/png;base64,SAME')])];
    rememberAttachments(history, seen);

    const toolTurns = [
      { role: 'user' as const, content: '（这是刚才抓到的屏幕截图）', attachments: [shot('data:image/png;base64,SAME')] },
    ];
    const kept = dedupeAttachments(toolTurns, seen);

    // 图片去掉了，但那句话还在 —— 它在对话里是有意义的
    expect(countAttachments(kept)).toBe(0);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.content).toContain('屏幕截图');
  });

  it('去重不修改传进来的消息对象', () => {
    // 只组装请求，不改任何已有数据 —— 持久化的东西一条都不能动
    const original = userWith('带附件', [fileAt('a.md', 'x')]);
    const duplicate = userWith('再来一次', [fileAt('a.md', 'x')]);
    const turns = [original, duplicate];

    dedupeAttachments(turns);

    expect(original.attachments).toHaveLength(1);
    expect(duplicate.attachments).toHaveLength(1);
  });
});
