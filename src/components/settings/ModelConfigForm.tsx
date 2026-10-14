import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Loader2, PlugZap, Save } from 'lucide-react';
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
import {
  modelConfigSchema,
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
 * 和 MockModelProvider 的 testConnection 用的是同一份 —— 所以「表单能存下来的」
 * 和「测试连接会通过」的永远一致，不会出现两套标准。
 *
 * 注意这里没有出现任何 @/services 的 import：组件层只认 @/features 这层领域服务。
 * 想换 provider、换存储，都不需要动这个文件。
 *
 * 关于「保存」：阶段 A 里保存只是写进内存。界面上明确说了这件事（见下方说明），
 * 而不是让用户以为已经落盘。这是技术方案第 5 节的硬约束，不在这里打折。
 */
export function ModelConfigForm() {
  const modelConfig = useSettingsStore((state) => state.modelConfig);
  const updateModelConfig = useSettingsStore((state) => state.updateModelConfig);
  const testConnection = useSettingsStore((state) => state.testConnection);
  const platformId = useSettingsStore((state) => state.platformId);

  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    trigger,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ModelConfigFormValues>({
    resolver: zodResolver(modelConfigSchema),
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
    await updateModelConfig(values);
    setTestResult(null);
    toast.success('配置已应用：地址与模型名写入本地，API Key 只保留在本次会话。');
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
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型配置</CardTitle>
        <CardDescription>
          第一版只接 OpenAI 兼容接口，填地址 / Key / 模型名即可。
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
            兼容 OpenAI 格式的服务都可以，例如 DeepSeek、本地 Ollama。
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cfg-api-key">API Key</Label>
          <div className="relative">
            <Input
              id="cfg-api-key"
              data-testid="model-api-key"
              type={showKey ? 'text' : 'password'}
              placeholder="sk-..."
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
          <p className="text-[11px] text-muted-foreground">
            Key 只留在内存里：不写入本地存储、不写进日志、刷新即清空。阶段 B 由系统安全存储接管。
          </p>
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
        <span className="ml-auto text-[11px] text-muted-foreground">平台实现：{platformId}</span>
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
