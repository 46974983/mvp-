import { describe, expect, it } from 'vitest';
import { baseKeyFromCode, captureAccelerator, formatAccelerator } from '@/lib/accelerator';

const NO_MODIFIER = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const CTRL = { ...NO_MODIFIER, ctrlKey: true };

/**
 * 全局快捷键的键名转换
 * ----------------------------------------------------------------------------
 * 这个文件里最重要的一组用例是「必须带修饰键」——
 * 放过去一条，用户在任何程序里打那个键都会被截走。
 */
describe('修饰键是硬要求', () => {
  it('没有修饰键的按键被拒，并说明为什么', () => {
    const result = captureAccelerator('KeyK', NO_MODIFIER);

    expect(result.accelerator).toBeUndefined();
    expect(result.reason).toContain('修饰键');
    // 说明里要讲清后果，而不只是「不允许」
    expect(result.reason).toContain('抢走');
  });

  it('只按修饰键本身不算数', () => {
    // ControlLeft 不是可用的基础键
    expect(captureAccelerator('ControlLeft', CTRL).accelerator).toBeUndefined();
    expect(captureAccelerator('ShiftLeft', { ...NO_MODIFIER, shiftKey: true }).accelerator).toBeUndefined();
  });

  it('带上任意一个修饰键就通过', () => {
    expect(captureAccelerator('KeyK', CTRL).accelerator).toBe('CommandOrControl+K');
    expect(captureAccelerator('KeyK', { ...NO_MODIFIER, altKey: true }).accelerator).toBe('Alt+K');
    expect(captureAccelerator('KeyK', { ...NO_MODIFIER, shiftKey: true }).accelerator).toBe(
      'Shift+K'
    );
    expect(captureAccelerator('KeyK', { ...NO_MODIFIER, metaKey: true }).accelerator).toBe(
      'Super+K'
    );
  });
});

describe('组合键的拼装', () => {
  it('多个修饰键按固定顺序拼，不受按下顺序影响', () => {
    // 顺序固定才有稳定的字符串，否则同一个键位每次录出来都不一样
    const result = captureAccelerator('KeyK', {
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    });
    expect(result.accelerator).toBe('CommandOrControl+Alt+Shift+Super+K');
  });

  it('Ctrl 用 CommandOrControl 表示（跨平台写法）', () => {
    expect(captureAccelerator('KeyK', CTRL).accelerator?.startsWith('CommandOrControl')).toBe(true);
  });
});

describe('键名转换', () => {
  it('字母、数字、功能键', () => {
    expect(baseKeyFromCode('KeyA')).toBe('A');
    expect(baseKeyFromCode('KeyZ')).toBe('Z');
    expect(baseKeyFromCode('Digit0')).toBe('0');
    expect(baseKeyFromCode('Digit9')).toBe('9');
    expect(baseKeyFromCode('F1')).toBe('F1');
    expect(baseKeyFromCode('F12')).toBe('F12');
    expect(baseKeyFromCode('F24')).toBe('F24');
  });

  it('常用命名键', () => {
    expect(baseKeyFromCode('Space')).toBe('Space');
    expect(baseKeyFromCode('Enter')).toBe('Enter');
    expect(baseKeyFromCode('ArrowUp')).toBe('Up');
    expect(baseKeyFromCode('ArrowDown')).toBe('Down');
    expect(baseKeyFromCode('Backquote')).toBe('Backquote');
  });

  it('不支持或超出范围的键返回 null', () => {
    expect(baseKeyFromCode('F25')).toBeNull();
    expect(baseKeyFromCode('Escape')).toBeNull();
    expect(baseKeyFromCode('ControlLeft')).toBeNull();
    expect(baseKeyFromCode('MetaRight')).toBeNull();
    expect(baseKeyFromCode('')).toBeNull();
  });

  it('不支持的键给出可读的提示，而不是静默忽略', () => {
    const result = captureAccelerator('Escape', CTRL);
    expect(result.accelerator).toBeUndefined();
    expect(result.reason).toBeTruthy();
    // 要告诉用户有哪些是能用的，否则他只能瞎试
    expect(result.reason).toContain('方向键');
  });
});

describe('展示用格式化', () => {
  it('把 CommandOrControl 说成人话', () => {
    // 直接显示 CommandOrControl 会让用户以为是另一个键
    expect(formatAccelerator('CommandOrControl+Shift+K')).toBe('Ctrl + Shift + K');
    expect(formatAccelerator('Super+Space')).toBe('Win + Space');
    expect(formatAccelerator('Alt+F4')).toBe('Alt + F4');
  });

  it('认不出的部分原样保留，不吞掉信息', () => {
    expect(formatAccelerator('Ctrl+WeirdKey')).toBe('Ctrl + WeirdKey');
  });
});
