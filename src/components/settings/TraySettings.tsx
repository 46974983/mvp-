import { Minimize2 } from 'lucide-react';
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

/**
 * 托盘与窗口
 * ----------------------------------------------------------------------------
 * 这一屏要做的事只有一件：**不让用户被困住**。
 *
 * 「关掉窗口但程序还在跑」是桌面助手的常见设计，也是最容易被误解的设计 ——
 * 用户点完叉发现进程还在，第一反应是「这软件关不掉」。
 * 所以要写清三件事：
 *   1. 关闭按钮现在到底是「隐藏」还是「退出」；
 *   2. 想真正退出该去哪（托盘右键菜单）；
 *   3. 藏起来之后怎么把窗口找回来（双击托盘图标）。
 *
 * 界面上的可用性判断来自服务层探测的能力集合，不是判断「现在是哪个阶段」——
 * 浏览器模式下这张卡片会如实说明「这里没有系统托盘」。
 */
export function TraySettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const closeToTray = useSettingsStore((state) => state.closeToTray);
  const setCloseToTray = useSettingsStore((state) => state.setCloseToTray);
  const hideToTray = useSettingsStore((state) => state.hideToTray);

  const supported = capabilities.includes('tray');
  const spec = PLATFORM_CAPABILITY_SPECS.tray;

  async function handleToggle(enabled: boolean) {
    const result = await setCloseToTray(enabled);
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
  }

  async function handleHide() {
    const result = await hideToTray();
    // 成功时不弹提示 —— 窗口马上就不见了，用户看不到那条 toast
    if (!result.ok) toast.error(result.message);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>托盘与窗口</CardTitle>
        <CardDescription>
          这是个常驻型助手：默认情况下关掉窗口只是退到托盘，应用仍在后台运行。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="tray-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '当前运行环境没有系统托盘，所以这一项不可用 —— 浏览器里关掉标签页就是关掉了。桌面版本（Tauri）里它可用。'
              : '正在探测当前环境的平台能力…'}
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="close-to-tray">关闭窗口时缩到系统托盘</Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {supported
                ? '开启后，点窗口右上角的关闭按钮只会把窗口藏起来，应用继续在后台运行。要真正结束应用，用托盘图标右键菜单里的「退出」。'
                : spec.description}
            </p>
          </div>
          <Switch
            id="close-to-tray"
            data-testid="close-to-tray-switch"
            checked={supported ? closeToTray : false}
            disabled={!supported}
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        </div>

        {supported && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              variant="outline"
              data-testid="hide-to-tray"
              onClick={() => void handleHide()}
            >
              <Minimize2 className="size-3.5" aria-hidden />
              现在就隐藏到托盘
            </Button>
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              把窗口找回来：双击托盘图标，或右键托盘图标选「显示主窗口」。
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
