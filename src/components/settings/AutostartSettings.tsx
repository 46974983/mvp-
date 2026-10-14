import { useState } from 'react';
import { Loader2, Rocket } from 'lucide-react';
import { toast } from 'sonner';
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
 * 开机自启
 * ----------------------------------------------------------------------------
 * 这一项和别的设置不一样：**状态存在系统里，不在我们的数据库里**。
 * 注册表那条记录随时可能被用户在「任务管理器 → 启动应用」里关掉。
 * 所以我们每次去问系统，界面上看到的永远是真实的。
 *
 * 另一件必须说清楚的事：自启注册的是**当前这个 exe 的绝对路径**。
 * 把文件挪走之后自启会静默失效（系统仍然认为它是开着的），
 * 所以这里把路径显示出来 —— 让用户知道「注册的到底是哪个文件」，
 * 也为开发时误开自启提个醒（那时注册的是 target/debug 下的路径）。
 */
export function AutostartSettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const autostartEnabled = useSettingsStore((state) => state.autostartEnabled);
  const autostartExePath = useSettingsStore((state) => state.autostartExePath);
  const setAutostart = useSettingsStore((state) => state.setAutostart);

  const [working, setWorking] = useState(false);

  const supported = capabilities.includes('autostart');
  const spec = PLATFORM_CAPABILITY_SPECS.autostart;

  async function handleToggle(enabled: boolean) {
    setWorking(true);
    try {
      const result = await setAutostart(enabled);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>开机自启</CardTitle>
        <CardDescription>
          登录系统后自动把助手跑起来，配合托盘常驻 —— 不用每次手动开。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="autostart-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '当前运行环境没有开机自启这回事（浏览器里关掉标签页就结束了）。桌面版本里它可用。'
              : '正在探测当前环境的平台能力…'}
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="autostart">开机时自动启动</Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {supported
                ? '状态来自系统本身：如果你在「任务管理器 → 启动应用」里把它关了，这里的开关会跟着变。'
                : spec.description}
            </p>
          </div>
          {working ? (
            <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <Switch
              id="autostart"
              data-testid="autostart-switch"
              checked={supported ? autostartEnabled : false}
              disabled={!supported || working}
              onCheckedChange={(checked) => void handleToggle(checked)}
            />
          )}
        </div>

        {supported && autostartExePath.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/50 p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Rocket className="size-3" aria-hidden />
              注册的启动路径
            </div>
            <p
              data-testid="autostart-exe-path"
              className="mt-1 break-all font-mono text-[11px] leading-relaxed text-foreground/80"
            >
              {autostartExePath}
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              这是当前这个可执行文件的位置。把它挪走之后自启会失效 ——
              重新开关一次这个开关就能把路径刷新过来。
            </p>
          </div>
        )}

        {!supported && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            桌面版本会把启动项写进当前用户的注册表，不需要管理员权限。
          </p>
        )}
      </CardContent>

      {supported && (
        <div className="mx-5 mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-relaxed text-muted-foreground">
          <span>想彻底取消自启，除了这里，也可以在系统的「启动应用」里关掉。</span>
        </div>
      )}
    </Card>
  );
}
