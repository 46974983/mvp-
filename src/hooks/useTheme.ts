import { create } from 'zustand';
import type { ThemeMode } from '@/types';

const THEME_KEY = 'desktop-ai-assistant:theme';

function readInitialTheme(): ThemeMode {
  const current = document.documentElement.dataset.theme;
  if (current === 'dark' || current === 'light') return current;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: ThemeMode): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
}

interface ThemeState {
  theme: ThemeMode;
  toggle(): void;
}

/**
 * 主题状态
 * ----------------------------------------------------------------------------
 * 为什么是 store 而不是 useState：顶栏（切换按钮）和 App（Toaster 的主题）
 * 都要读它。用组件内 state 就会出现「顶栏切了，别处不知道」的经典脱节。
 *
 * 首屏的主题由 index.html 里的内联脚本先定好，避免浅色闪一下再变深色；
 * 这个 store 只接管后续的切换。
 *
 * 一个细节：只有用户**主动切换**过才写 localStorage。没切过就不写，
 * 「跟随系统」这个默认行为才能在下次打开时继续成立。
 */
export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readInitialTheme(),

  toggle() {
    const next: ThemeMode = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // 存不了就算了，本次会话内切换仍然生效
    }
    set({ theme: next });
  },
}));

export function useTheme() {
  const theme = useThemeStore((state) => state.theme);
  const toggle = useThemeStore((state) => state.toggle);
  return { theme, toggle };
}
