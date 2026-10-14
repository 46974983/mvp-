import { Database, HardDrive, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardActions,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useSettingsStore } from '@/features';

/** 能力的中文名，纯粹为了好读；真正的可用性由 platformService 决定 */
const CAPABILITY_LABELS: Record<string, string> = {
  'file-read': '读取本地文件',
  screenshot: '截屏',
  notification: '系统通知',
  autostart: '开机自启',
};

const ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS);

interface DataPanelProps {
  onRequestReset: () => void;
}

export function DataPanel({ onRequestReset }: DataPanelProps) {
  const driverName = useSettingsStore((state) => state.storageDriverName);
  const description = useSettingsStore((state) => state.storageDescription);
  const platformId = useSettingsStore((state) => state.platformId);
  const capabilities = useSettingsStore((state) => state.platformCapabilities);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>数据与安全</CardTitle>
          <CardDescription>数据默认保存在本地，这是本产品的默认原则，不是可选项。</CardDescription>
        </CardHeader>

        <CardContent>
          <div className="rounded-lg border border-border bg-muted/50 p-3.5">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <Database className="size-3.5 text-primary" aria-hidden />
              当前存储实现：{driverName}
            </div>
            <p data-testid="storage-description" className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <ShieldCheck className="size-3.5 text-success" aria-hidden />
              已生效的安全约束
            </div>
            <ul className="ml-1 space-y-1 text-[12px] leading-relaxed text-muted-foreground">
              <li>· API Key 不写入存储、不写入日志，离开页面即失效</li>
              <li>· 删除会话前一律二次确认，不做「一键静默删除」</li>
              <li>· 系统提示词与用户消息在请求里分属不同字段</li>
              <li>· 对外错误提示经过脱敏，不暴露凭据与请求头</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>平台能力</CardTitle>
          <CardDescription>
            对应技术方案第 6 节：高权限能力逐项开放，默认关闭。当前平台实现为「{platformId}」。
          </CardDescription>
        </CardHeader>

        <CardContent>
          <ul data-testid="platform-capabilities" className="grid grid-cols-2 gap-2">
            {ALL_CAPABILITIES.map((capability) => {
              const available = capabilities.includes(capability);
              return (
                <li
                  key={capability}
                  data-capability={capability}
                  data-available={available ? 'true' : 'false'}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[12px]"
                >
                  {available ? (
                    <HardDrive className="size-3.5 shrink-0 text-success" aria-hidden />
                  ) : (
                    <TriangleAlert className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={available ? 'text-foreground' : 'text-muted-foreground'}>
                    {CAPABILITY_LABELS[capability]}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {available ? '可用' : '未开放'}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>重置本地数据</CardTitle>
          <CardDescription>
            清空全部会话记录、消息、人格配置和模型地址记录。API Key 本来就不落盘，无需清理。
          </CardDescription>
        </CardHeader>
        <CardActions>
          <Button variant="danger" data-testid="reset-data" onClick={onRequestReset}>
            重置全部本地数据
          </Button>
        </CardActions>
      </Card>
    </>
  );
}
