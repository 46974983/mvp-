import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
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
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { personaSchema, useSettingsStore, type PersonaForm as PersonaFormValues } from '@/features';

export function PersonaForm() {
  const persona = useSettingsStore((state) => state.settings.persona);
  const savePersona = useSettingsStore((state) => state.savePersona);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PersonaFormValues>({
    resolver: zodResolver(personaSchema),
    defaultValues: persona,
  });

  /**
   * 表单跟着 store 走。
   * 为什么需要这一步：React Hook Form 的 defaultValues 只在挂载时读一次。
   * 设置页在「重置本地数据」之后并不会卸载，没有这行的话，用户重置完
   * 会看到一份已经不存在的旧配置 —— 这比「空着」更糟，因为它看起来像是生效了。
   */
  useEffect(() => {
    reset(persona);
  }, [persona, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const result = await savePersona(values);
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>人格配置</CardTitle>
        <CardDescription>
          MVP 只做简单文本人格：一个名字、一个称呼、一段固定提示词，不做情绪和记忆系统。
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="cfg-assistant-name">助手名称</Label>
            <Input
              id="cfg-assistant-name"
              data-testid="persona-assistant-name"
              placeholder="小枢"
              aria-invalid={Boolean(errors.assistantName)}
              {...register('assistantName')}
            />
            {errors.assistantName && (
              <p role="alert" className="text-[11px] text-destructive">
                {errors.assistantName.message}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cfg-user-name">用户称呼</Label>
            <Input
              id="cfg-user-name"
              data-testid="persona-user-name"
              placeholder="老大"
              aria-invalid={Boolean(errors.userName)}
              {...register('userName')}
            />
            {errors.userName && (
              <p role="alert" className="text-[11px] text-destructive">
                {errors.userName.message}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cfg-system-prompt">系统提示词</Label>
          <Textarea
            id="cfg-system-prompt"
            data-testid="persona-system-prompt"
            rows={4}
            placeholder="你是一个……"
            aria-invalid={Boolean(errors.systemPrompt)}
            {...register('systemPrompt')}
          />
          {errors.systemPrompt && (
            <p role="alert" className="text-[11px] text-destructive">
              {errors.systemPrompt.message}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            这段文字在每次请求时作为独立的 system 字段发给模型，不和用户消息混在一起。
          </p>
        </div>
      </CardContent>

      <CardActions>
        <Button variant="primary" data-testid="save-persona" onClick={() => void onSubmit()}>
          <Save className="size-3.5" aria-hidden />
          保存人格
        </Button>
      </CardActions>
    </Card>
  );
}
