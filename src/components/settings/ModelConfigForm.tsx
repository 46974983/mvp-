import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, KeyRound, Loader2, PlugZap, Save, ShieldCheck } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toUserFacingError } from '@/lib/log';
import {
  modelConfigSchema,
  modelConfigSchemaForStoredKey,
  useSettingsStore,
  type ModelConfigForm as ModelConfigFormValues,
} from '@/features';

interface FieldErrorProps {
  message?: string;
}

function FieldError({ message }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p role="alert" className="text-[11px] text-destructive">
      {message}
    </p>
  );
}

/**
 * 模型配置表单
 * ----------------------------------------------------------------------------
 * 用 React Hook Form + Zod（技术方案第 4 节的要求）。校验规则来自 modelConfigSchema，
 * 和 provider 的 testConnection 用的是同一份 —— 所以「表单能存下来的」
 * 和「测试连接会通过」的永远一致，不会出现两套标准。
 *
 * 这里没有出现任何 @/services 的 import：组件层只认 @/features 这层领域服务。
 *
 * 关于 Key 的文案**不是写死的**，而是读 `credentialStorage`：
 *   浏览器模式 → 「只留内存，刷新即失效」
 *   桌面模式   → 「由 Windows 凭据管理器保管」
 * 同一份界面要如实描述两种事实，靠的只能是「问服务层」，不是靠判断当前是什么阶段。
 */
export function ModelConfigForm() {
  const modelConfig = useSettingsStore((state) => state.modelConfig);
  const updateModelConfig = useSettingsStore((state) => state.updateModelConfig);
  const testConnection = useSettingsStore((state) => state.testConnection);
  const clearApiKey = useSettingsStore((state) => state.clearApiKey);

  const credentialStorage = useSettingsStore((state) => state.credentialStorage);
  const apiKeyStored = useSettingsStore((state) => state.apiKeyStored);
  const providerLabel = useSettingsStore((state) => state.providerLabel);

  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const keyIsPersisted = credentialStorage.kind === 'os-keychain';

  const {
    register,
    handleSubmit,
    getValues,
    trigger,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ModelConfigFormValues>({
    resolver: zodResolver(
      keyIsPersisted && apiKeyStored ? modelConfigSchemaForStoredKey(true) : modelConfigSchema
    ),
    defaultValues: modelConfig,
  });

  /**
   * 表单跟着 store 走（同 PersonaForm 的理由）：
   * defaultValues 只在挂载时读一次，重置数据后设置页不会卸载，
   * 不重置表单就会留在旧值上。
   */
  useEffect(() => {
    reset(modelConfig);
  }, [modelConfig, reset]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await updateModelConfig(values);
      setTestResult(null);
      toast.success(
        keyIsPersisted
          ? '配置已保存：地址与模型名写入本地，API Key 交给系统凭据管理器。'
          : '配置已应用：地址与模型名写入本地，API Key 只保留在本次会话。'
      );
    } catch (error) {
      toast.error(toUserFacingError(error, '保存模型配置失败，请重试。'));
    }
  });

  async function handleTest() {
    // 先本地校验。校验不过就不去问 provider —— 连地址都不合法时，
    // 「连接失败」这种提示只会让人往错的方向查。
    const valid = await trigger();
    if (!valid) {
      setTestResult({ ok: false, message: '请先修正表单中标出的问题，再测试连接。' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection(getValues()));
    } catch (error) {
      setTestResult({
        ok: false,
        message: toUserFacingError(error, '测试连接失败，请检查配置后重试。'),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleClearKey() {
    try {
      await clearApiKey();
      setTestResult(null);
      toast.success('已清除本机保存的 API Key');
    } catch (error) {
      toast.error(toUserFacingError(error, '清除 API Key 失败，请重试。'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型配置</CardTitle>
        <CardDescription>
          第一版只接 OpenAI 兼容接口，填地址 / Key / 模型名即可。
          当前由「{providerLabel}」负责发起请求。
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="space-y-1.5">
          <Label htmlFor="cfg-api-url">API 地址</Label>
          <Input
            id="cfg-api-url"
            data-testid="model-api-url"
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
            aria-invalid={Boolean(errors.apiUrl)}
            {...register('apiUrl')}
          />
          <FieldError message={errors.apiUrl?.message} />
          <p className="text-[11px] text-muted-foreground">
            兼容 OpenAI 格式的服务都可以，例如 DeepSeek、本地 Ollama。地址以 /v1 结尾。
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cfg-api-key">API Key</Label>
          <div className="relative">
            <Input
              id="cfg-api-key"
              data-testid="model-api-key"
              type={showKey ? 'text' : 'password'}
              placeholder={apiKeyStored ? '已保存，留空则沿用' : 'sk-...'}
              autoComplete="off"
              aria-invalid={Boolean(errors.apiKey)}
              className="pr-9"
              {...register('apiKey')}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              data-testid="toggle-api-key"
              title={showKey ? '隐藏' : '显示'}
              aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
              className="absolute top-0.5 right-0.5"
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? (
                <EyeOff className="size-3.5" aria-hidden />
              ) : (
                <Eye className="size-3.5" aria-hidden />
              )}
            </Button>
          </div>
          <FieldError message={errors.apiKey?.message} />

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {credentialStorage.description}
          </p>

          {/* 只在「确实存进去了」时才显示已保存状态。浏览器模式下它永远是未保存。 */}
          {keyIsPersisted && (
            <div
              data-testid="api-key-status"
              data-stored={apiKeyStored ? 'true' : 'false'}
              className="flex items-center gap-1.5 text-[11px]"
            >
              {apiKeyStored ? (
                <>
                  <ShieldCheck className="size-3 text-success" aria-hidden />
                  <span className="text-success">已保存到{credentialStorage.label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="clear-api-key"
                    className="h-5 px-1.5 text-[11px]"
                    onClick={() => void handleClearKey()}
                  >
                    清除
                  </Button>
                </>
              ) : (
                <>
                  <KeyRound className="size-3 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">尚未保存 API Key</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cfg-model-name">模型名称</Label>
          <Input
            id="cfg-model-name"
            data-testid="model-name"
            placeholder="gpt-4o-mini"
            autoComplete="off"
            aria-invalid={Boolean(errors.modelName)}
            {...register('modelName')}
          />
          <FieldError message={errors.modelName?.message} />
        </div>
      </CardContent>

      <CardActions>
        <Button
          variant="primary"
          data-testid="test-connection"
          disabled={testing}
          onClick={() => void handleTest()}
        >
          {testing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <PlugZap className="size-3.5" aria-hidden />
          )}
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button
          variant="outline"
          data-testid="save-model"
          disabled={isSubmitting}
          onClick={() => void onSubmit()}
        >
          <Save className="size-3.5" aria-hidden />
          保存配置
        </Button>
      </CardActions>

      {testResult && (
        <div
          data-testid="test-result"
          data-ok={testResult.ok ? 'true' : 'false'}
          className={
            testResult.ok
              ? 'mx-5 mb-5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[12px] leading-relaxed text-foreground'
              : 'mx-5 mb-5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-relaxed text-foreground'
          }
        >
          {testResult.message}
        </div>
      )}
    </Card>
  );
}
