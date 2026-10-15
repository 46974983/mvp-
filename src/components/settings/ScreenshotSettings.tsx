import { useState } from 'react';
import { Loader2, MonitorSmartphone, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PLATFORM_CAPABILITY_SPECS, useSettingsStore } from '@/features';

/** 把字节数说成人话 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 截屏
 * ----------------------------------------------------------------------------
 * 这是全项目**最敏感**的一项：文件读取至少要用户先授权一个目录，
 * 而截屏一次就拍到屏幕上所有东西 —— 包括别的窗口、通知弹窗、你正在输的密码框。
 *
 * 所以这张卡片不只是「一个开关加一个按钮」，它要把三件事说清楚：
 *
 * 1. **默认关闭。** 技术方案第 6 节的原话是「默认关闭高风险自动化能力」。
 * 2. **拍到什么。** 抓的是主屏的整块画面，不是某个窗口、不是某块区域。
 * 3. **用完去哪了。** 只在内存里，不落盘 —— 没有文件、没有路径、关掉即丢。
 *
 * 另外这道门在 Rust 侧也有一份（`permissions::ensure_enabled`）。
 * 界面上把按钮禁掉只是体验，命令是可以被直接调用的。
 */
export function ScreenshotSettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const enabled = useSettingsStore((state) => state.screenshotEnabled);
  const lastScreenshot = useSettingsStore((state) => state.lastScreenshot);
  const setScreenshotEnabled = useSettingsStore((state) => state.setScreenshotEnabled);
  const takeScreenshot = useSettingsStore((state) => state.takeScreenshot);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = capabilities.includes('screenshot');
  const spec = PLATFORM_CAPABILITY_SPECS.screenshot;

  async function handleToggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await setScreenshotEnabled(next);
      if (result.ok) toast.success(result.message);
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCapture() {
    setBusy(true);
    setError(null);
    try {
      await takeScreenshot();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>截屏</CardTitle>
        <CardDescription>
          让助手看到你屏幕上的画面。默认关闭，需要你明确开启。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="screenshot-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '浏览器抓不了屏幕 —— 网页只能拿到它自己那一页里的东西。桌面版本里这一项可用。'
              : '正在探测当前环境的平台能力…'}
            <p className="mt-1 text-[11px]">桌面版本里能做的事：{spec.description}。</p>
          </div>
        )}

        {supported && (
          <div className="space-y-3">
            {/* 拍到什么、拍完去哪了 —— 这一段是这一项的「权限说明」 */}
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                <p className="text-foreground/80">
                  开启后，助手能抓取主屏的整块画面 —— 不只是本窗口，
                  屏幕上当时有什么就会拍到什么，包括其他窗口和通知。
                </p>
                <p>截图只在内存里传递，不会写到磁盘上；关掉这个开关时，上一次的画面也会立刻丢弃。</p>
              </div>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="screenshot">允许助手截屏</Label>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  开关关着的时候，即使有人直接调用截屏命令也会被拒绝。
                </p>
              </div>
              {busy ? (
                <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              ) : (
                <Switch
                  id="screenshot"
                  data-testid="screenshot-switch"
                  checked={enabled}
                  onCheckedChange={(checked) => void handleToggle(checked)}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="take-screenshot"
                disabled={!enabled || busy}
                onClick={() => void handleCapture()}
              >
                <MonitorSmartphone className="size-3.5" aria-hidden />
                抓一张试试
              </Button>
              {!enabled && (
                <span className="text-[11px] text-muted-foreground">
                  先打开上面的开关才能试。
                </span>
              )}
            </div>

            {error && (
              <p
                role="alert"
                data-testid="screenshot-error"
                className="text-[11px] leading-relaxed text-warning"
              >
                {error}
              </p>
            )}

            {lastScreenshot && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span data-testid="screenshot-meta">
                    {lastScreenshot.width}×{lastScreenshot.height} ·{' '}
                    {formatBytes(lastScreenshot.bytes)} · {lastScreenshot.monitor}
                  </span>
                  {lastScreenshot.monitorCount > 1 && (
                    <span className="text-warning">
                      （检测到 {lastScreenshot.monitorCount} 块屏幕，这里只截了主屏）
                    </span>
                  )}
                </div>
                <img
                  data-testid="screenshot-preview"
                  src={lastScreenshot.dataUrl}
                  alt="刚抓到的屏幕画面"
                  className="mt-2 max-h-56 w-full rounded-md border border-border object-contain"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  这张图只在内存里。刷新页面或者关掉开关就没了，磁盘上不会留下任何东西。
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
