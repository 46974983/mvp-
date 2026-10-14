import { useEffect, useRef, useState } from 'react';
import { Keyboard, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardActions,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { PLATFORM_CAPABILITY_SPECS, useSettingsStore } from '@/features';
import { captureAccelerator, formatAccelerator } from '@/lib/accelerator';

/**
 * 全局快捷键
 * ----------------------------------------------------------------------------
 * 这一项最容易出的问题不是「设不上」，而是**设上了没生效，而用户不知道**。
 *
 * 全局快捷键是抢系统资源的：同一个组合键全系统只有一个程序能占住。
 * 想设 `Ctrl+Shift+Space` 时它很可能已经被输入法或截图工具占了，
 * 那时注册会失败 —— 而用户看到的只是「按了没反应」。
 *
 * 所以这里把两件事分开显示：
 *   1. 你设的是哪个键；
 *   2. 它现在到底有没有生效（注册状态来自运行期，不是我们乐观假设的）。
 *
 * 另外录制时会拦掉「没有修饰键」的按键。单独注册一个 `K` 会把用户
 * 在任何程序里打的这个字母都截走 —— 那不是小失误，是能把系统弄得没法用。
 */
export function ShortcutSettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const globalShortcut = useSettingsStore((state) => state.globalShortcut);
  const globalShortcutRegistered = useSettingsStore(
    (state) => state.globalShortcutRegistered
  );
  const setGlobalShortcut = useSettingsStore((state) => state.setGlobalShortcut);

  const [capturing, setCapturing] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const captureRef = useRef<HTMLButtonElement | null>(null);

  const supported = capabilities.includes('global-shortcut');
  const spec = PLATFORM_CAPABILITY_SPECS['global-shortcut'];

  // 进入录制状态就把焦点抢过来，否则按键根本到不了这个按钮上
  useEffect(() => {
    if (capturing) captureRef.current?.focus();
  }, [capturing]);

  async function apply(accelerator: string | null) {
    setWorking(true);
    try {
      const result = await setGlobalShortcut(accelerator);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } finally {
      setWorking(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();

    if (event.code === 'Escape') {
      setCapturing(false);
      setHint(null);
      return;
    }

    const result = captureAccelerator(event.code, {
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });

    if (result.reason || !result.accelerator) {
      // 不默默忽略：用户按了没反应会以为键盘坏了，得说清为什么不收
      setHint(result.reason ?? '这个组合键不能用，换一个试试。');
      return;
    }

    setHint(null);
    setCapturing(false);
    void apply(result.accelerator);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>全局快捷键</CardTitle>
        <CardDescription>
          在任何程序里按一下就能把窗口叫到前台，再按一次收起来。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="shortcut-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '浏览器拿不到页面之外的按键，所以这一项不可用。桌面版本里它可用。'
              : '正在探测当前环境的平台能力…'}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="global-shortcut">唤起 / 收起窗口</Label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              ref={captureRef}
              type="button"
              id="global-shortcut"
              data-testid="shortcut-capture"
              data-capturing={capturing ? 'true' : 'false'}
              disabled={!supported || working}
              onClick={() => {
                setHint(null);
                setCapturing(true);
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => setCapturing(false)}
              className={
                capturing
                  ? 'min-w-[13rem] rounded-md border border-primary bg-input px-3 py-1.5 text-left font-mono text-[12px] text-foreground outline-none'
                  : 'min-w-[13rem] rounded-md border border-border bg-input px-3 py-1.5 text-left font-mono text-[12px] text-foreground outline-none transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-60'
              }
            >
              {capturing ? (
                <span className="text-muted-foreground">按下组合键…（Esc 取消）</span>
              ) : globalShortcut ? (
                formatAccelerator(globalShortcut)
              ) : (
                <span className="text-muted-foreground">点击这里录制快捷键</span>
              )}
            </button>

            {supported && globalShortcut.length > 0 && (
              <>
                <span
                  data-testid="shortcut-status"
                  data-registered={globalShortcutRegistered ? 'true' : 'false'}
                  className={
                    globalShortcutRegistered
                      ? 'text-[11px] text-success'
                      : 'text-[11px] text-warning'
                  }
                >
                  {globalShortcutRegistered ? '已生效' : '未生效'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="shortcut-clear"
                  disabled={working}
                  onClick={() => void apply(null)}
                >
                  清除
                </Button>
              </>
            )}

            {working && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
            )}
          </div>

          {hint && (
            <p
              role="alert"
              data-testid="shortcut-hint"
              className="text-[11px] leading-relaxed text-warning"
            >
              {hint}
            </p>
          )}

          {/* 设了但没生效，是这一项最需要讲清楚的状态 */}
          {supported && globalShortcut.length > 0 && !globalShortcutRegistered && (
            <p
              data-testid="shortcut-warning"
              className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning"
            >
              <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                这个组合键当前没生效，最可能是已被别的程序占用。
                换一个再录；换了几个都不行的话，可能是系统的热键资源满了。
              </span>
            </p>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {supported
              ? '必须带至少一个修饰键（Ctrl / Alt / Shift / Win）—— 单独一个按键会被从所有程序手里抢走。'
              : spec.description}
          </p>
        </div>
      </CardContent>

      {supported && (
        <CardActions>
          <span className="flex items-center gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Keyboard className="size-3" aria-hidden />
            默认不设：全局快捷键会占用一个全系统唯一的组合键，需要你主动指定。
          </span>
        </CardActions>
      )}
    </Card>
  );
}
