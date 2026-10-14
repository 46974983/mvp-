import { useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { PLATFORM_CAPABILITY_SPECS, useSettingsStore } from '@/features';

/**
 * 通知设置
 * ----------------------------------------------------------------------------
 * 这张卡片要回答用户最关心的一个问题：**它什么时候会响**。
 *
 * 通知最容易变成骚扰功能，所以把规则明说出来：
 * 窗口正在前台时不发（你正看着呢），缩到托盘后跑完一定发。
 * 用户知道规律之后，就不会觉得「怎么时有时无」。
 *
 * 另外桌面版和浏览器版的授权方式完全不同，这里也是问服务层的能力集合，
 * 不写死「当前是哪个阶段」。
 */
export function NotificationSettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const onReplyComplete = useSettingsStore((state) => state.onReplyComplete);
  const setNotifyOnReplyComplete = useSettingsStore((state) => state.setNotifyOnReplyComplete);
  const sendTestNotification = useSettingsStore((state) => state.sendTestNotification);

  const [testing, setTesting] = useState(false);

  const supported = capabilities.includes('notification');
  const spec = PLATFORM_CAPABILITY_SPECS.notification;

  async function handleToggle(enabled: boolean) {
    const result = await setNotifyOnReplyComplete(enabled);
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
  }

  async function handleTest() {
    setTesting(true);
    try {
      // delivered=false 不是失败，是一句说明（没授权 / 被跳过），所以用 warning 而不是 error
      const outcome = await sendTestNotification();
      if (outcome.delivered) toast.success(outcome.reason);
      else toast.warning(outcome.reason);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知</CardTitle>
        <CardDescription>
          回复在后台生成完成时提醒你 —— 长回答不用一直盯着等。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="notification-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '当前浏览器没有提供通知接口，这一项不可用。桌面版本里它可用。'
              : '正在探测当前环境的平台能力…'}
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor="notify-on-reply-complete">回复生成完成时提醒我</Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {supported
                ? '窗口正在前台时不会打扰你；缩到托盘或切走之后，回复一完成就会提醒。出错了同样会提醒。'
                : spec.description}
            </p>
          </div>
          <Switch
            id="notify-on-reply-complete"
            data-testid="notification-switch"
            checked={supported ? onReplyComplete : false}
            disabled={!supported}
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          停止生成不会发通知 —— 那是你自己按的，你就在屏幕前。
        </p>
      </CardContent>

      <CardActions>
        <Button
          variant="outline"
          data-testid="test-notification"
          disabled={!supported || testing}
          onClick={() => void handleTest()}
        >
          {testing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <BellRing className="size-3.5" aria-hidden />
          )}
          {testing ? '发送中…' : '发一条测试通知'}
        </Button>
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          测试通知会立刻发出，不受「窗口在前台就不打扰」的限制。
        </span>
      </CardActions>
    </Card>
  );
}
