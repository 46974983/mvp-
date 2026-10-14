import { MessageSquare, Moon, Settings, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/useTheme';

export type AppPage = 'chat' | 'settings';

interface TitlebarProps {
  page: AppPage;
  onNavigate: (page: AppPage) => void;
  /** 生成中禁止跳页：切走会让流式状态和界面脱节 */
  navigationLocked?: boolean;
  onNavigateBlocked?: () => void;
}

export function Titlebar({
  page,
  onNavigate,
  navigationLocked = false,
  onNavigateBlocked,
}: TitlebarProps) {
  const { theme, toggle } = useTheme();

  const navItems: Array<{ id: AppPage; label: string; icon: typeof MessageSquare }> = [
    { id: 'chat', label: '聊天', icon: MessageSquare },
    { id: 'settings', label: '设置', icon: Settings },
  ];

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-3">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-[15px] text-primary">
          ◈
        </span>
        <span className="text-[13px] font-semibold text-foreground">桌面 AI 助手</span>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] tracking-wide text-muted-foreground">
          阶段 A
        </span>
      </div>

      <nav className="flex items-center gap-1" aria-label="主导航">
        {navItems.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant="ghost"
            size="sm"
            data-testid={`nav-${id}`}
            aria-current={page === id ? 'page' : undefined}
            className={cn(
              'px-3',
              page === id && 'bg-muted text-foreground hover:bg-muted'
            )}
            onClick={() => {
              if (navigationLocked) {
                onNavigateBlocked?.();
                return;
              }
              onNavigate(id);
            }}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </Button>
        ))}
      </nav>

      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="theme-toggle"
        title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        onClick={toggle}
      >
        {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </Button>
    </header>
  );
}
