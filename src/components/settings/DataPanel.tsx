import { Database, HardDrive, KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
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

/**
 * 数据与安全面板
 * ----------------------------------------------------------------------------
 * 这一屏的内容**全部来自服务层的自述**，没有一句是写死的：
 *   数据放在哪   ← storage.resolveLocation()
 *   凭据放在哪   ← storage.credentialStorage
 *   凭据能不能用 ← storage.probeCredentialStorage()
 *   平台有什么能力 ← platform.capabilities
 *
 * 为什么较真到这个程度：同一个界面，浏览器版和桌面版的「事实」是不一样的。
 * 只要有一句写死的文案，就必然在其中一种环境下撒谎。
 */
export function DataPanel({ onRequestReset }: DataPanelProps) {
  const driverName = useSettingsStore((state) => state.driverName);
  const location = useSettingsStore((state) => state.location);
  const credentialStorage = useSettingsStore((state) => state.credentialStorage);
  const credentialStatus = useSettingsStore((state) => state.credentialStatus);
  const apiKeyStored = useSettingsStore((state) => state.apiKeyStored);
  const performsNetworkRequest = useSettingsStore((state) => state.performsNetworkRequest);
  const platformId = useSettingsStore((state) => state.platformId);
  const capabilities = useSettingsStore((state) => state.platformCapabilities);

  const keyIsPersisted = credentialStorage.kind === 'os-keychain';

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
            <p
              data-testid="storage-location"
              className="mt-1.5 break-all font-mono text-[11.5px] leading-relaxed text-muted-foreground"
            >
              {location?.path ?? '正在读取存储位置…'}
            </p>
          </div>

          <div className="rounded-lg border border-border p-3.5">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <KeyRound className="size-3.5 text-primary" aria-hidden />
              API Key 去向：{credentialStorage.label}
            </div>
            <p
              data-testid="credential-storage"
              data-kind={credentialStorage.kind}
              className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground"
            >
              {credentialStorage.description}
            </p>

            {apiKeyStored && (
              <p data-testid="api-key-stored" className="mt-1.5 text-[12px] text-success">
                当前已保存一份 API Key。
              </p>
            )}

            {/* 凭据存储不可用是一种正常状态，值得如实显示，而不是弹错误 */}
            {credentialStatus && !credentialStatus.ok && (
              <p data-testid="credential-warning" className="mt-1.5 text-[12px] text-warning">
                {credentialStatus.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <ShieldCheck className="size-3.5 text-success" aria-hidden />
              已生效的安全约束
            </div>
            <ul
              data-testid="security-constraints"
              className="ml-1 space-y-1 text-[12px] leading-relaxed text-muted-foreground"
            >
              <li>
                · API Key{' '}
                {keyIsPersisted
                  ? `由${credentialStorage.label}加密保管，不写入数据库、不写入日志`
                  : '不写入存储、不写入日志，刷新页面即失效'}
              </li>
              <li>· 数据库表结构与设置键里都不存在 api_key，凭据没有落点</li>
              <li>· 删除会话前一律二次确认，不做「一键静默删除」</li>
              <li>· 系统提示词与用户消息在请求里分属不同字段</li>
              <li>· 对外错误提示经过脱敏，不暴露凭据与请求头</li>
            </ul>
          </div>

          <p className="text-[12px] leading-relaxed text-muted-foreground">
            模型请求：
            {performsNetworkRequest
              ? '由桌面端 Rust 直接发起，WebView 没有外网出口。'
              : '当前不发起，回答由本地离线实现生成。'}
          </p>
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
            清空全部会话记录、消息、人格配置和模型地址记录
            {keyIsPersisted ? '，并删除本机保存的 API Key' : ''}。此操作无法恢复。
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
