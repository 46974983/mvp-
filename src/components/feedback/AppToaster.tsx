import { Toaster } from 'sonner';
import { useTheme } from '@/hooks/useTheme';

/**
 * 全局提示（Toast）
 * ----------------------------------------------------------------------------
 * 包一层而不是直接在 App 里写 <Toaster>，是为了让「提示样式跟着主题走」这件事
 * 只有一个出处。App 不需要知道 sonner 的存在。
 */
export function AppToaster() {
  const { theme } = useTheme();

  return (
    <Toaster
      position="top-center"
      theme={theme}
      toastOptions={{ className: 'text-[13px]' }}
    />
  );
}
