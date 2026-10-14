/**
 * 全局快捷键的键名转换
 * ----------------------------------------------------------------------------
 * 把一次键盘事件转成 Tauri 认识的 accelerator 字符串（例如 `CommandOrControl+Shift+Space`）。
 *
 * 抽成纯函数是因为这里有一条**必须拦住**的规则：
 * **不允许没有修饰键的快捷键。**
 *
 * 单独一个 `K` 也是合法的 accelerator，但注册上去之后，用户在任何程序里打这个字母
 * 都会被这个应用截走 —— 那不是小失误，是能把系统弄得没法用。
 * 界面在这一层直接拒掉，Rust 侧还会再校验一次（前端不是可信边界）。
 */

export interface ModifierState {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * 用 `event.code` 而不是 `event.key` 来判断按了哪个键。
 *
 * `key` 会随输入法和键盘布局变化（中文输入法下可能是「中」、法语键盘上可能是别的字符），
 * `code` 是物理按键位置，稳定得多。
 */
const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: 'Minus',
  Equal: 'Equal',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  Backquote: 'Backquote',
};

/** 把 `event.code` 翻成 accelerator 里的那个键名；不认识的返回 null */
export function baseKeyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];

  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];

  const functionKey = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  if (functionKey?.[1]) return `F${functionKey[1]}`;

  return NAMED_KEYS[code] ?? null;
}

export interface CaptureResult {
  /** 录制成功时的 accelerator；失败时不存在 */
  accelerator?: string;
  /**
   * 这次按键为什么不能用作快捷键。
   * 界面要把这句话显示出来 —— 默默忽略会让用户以为键盘没反应。
   */
  reason?: string;
}

/** 把一次按键转成 accelerator */
export function captureAccelerator(code: string, modifiers: ModifierState): CaptureResult {
  const base = baseKeyFromCode(code);
  if (!base) {
    return { reason: '这个键不支持作为快捷键，换一个试试（字母、数字、F1–F24、方向键等都可以）。' };
  }

  const parts: string[] = [];
  // CommandOrControl 是 Tauri 的跨平台写法：Windows/Linux 上是 Ctrl，macOS 上是 Cmd
  if (modifiers.ctrlKey) parts.push('CommandOrControl');
  if (modifiers.altKey) parts.push('Alt');
  if (modifiers.shiftKey) parts.push('Shift');
  if (modifiers.metaKey) parts.push('Super');

  if (parts.length === 0) {
    return {
      reason:
        '必须带上至少一个修饰键（Ctrl / Alt / Shift / Win）。单独一个按键会把它从所有程序手里抢走。',
    };
  }

  return { accelerator: [...parts, base].join('+') };
}

/** accelerator 里的修饰键写法，用于给用户做展示 */
const MODIFIER_LABELS: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
  Super: 'Win',
  Command: 'Win',
  Cmd: 'Win',
  Meta: 'Win',
};

/**
 * 把 accelerator 转成适合展示的写法：`CommandOrControl+Shift+K` → `Ctrl + Shift + K`。
 * 用户看到 `CommandOrControl` 会以为是另一个键。
 */
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => MODIFIER_LABELS[part] ?? part)
    .join(' + ');
}
