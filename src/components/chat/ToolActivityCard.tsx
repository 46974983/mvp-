import { useEffect, useState } from 'react';
import {
  Check,
  FileText,
  Loader2,
  MonitorSmartphone,
  ShieldQuestion,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/features';
import type { PendingToolCall, ToolCall } from '@/features';

/** 工具名翻成人话 */
function toolLabel(name: string): { text: string; icon: 'file' | 'screen' } {
  if (name === 'read_file') return { text: '读取文件', icon: 'file' };
  if (name === 'take_screenshot') return { text: '抓取屏幕', icon: 'screen' };
  return { text: `未知操作「${name}」`, icon: 'file' };
}

/** 一个请求对应的人话说明，以及它会不会读到什么 */
function describe(call: ToolCall): { label: string; detail: string; icon: 'file' | 'screen' } {
  if (call.name === 'read_file') {
    let path = '（没给出路径）';
    try {
      const parsed: unknown = JSON.parse(call.arguments);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { path?: unknown }).path === 'string') {
        path = (parsed as { path: string }).path;
      }
    } catch {
      // 参数坏掉时不必在这里报错 —— 模型会从工具结果里知道「参数不合法」
    }
    return {
      label: `读取文件「${path}」`,
      detail: '只能读你已授权目录里的文件，超出范围会被拒绝。',
      icon: 'file',
    };
  }

  if (call.name === 'take_screenshot') {
    return {
      label: '抓一张屏幕截图',
      detail: '拍的是主屏的整块画面 —— 屏幕上当时有什么就会拍到什么。',
      icon: 'screen',
    };
  }

  return { label: `未知操作「${call.name}」`, detail: '这个操作不会被允许。', icon: 'file' };
}

function ItemIcon({ kind }: { kind: 'file' | 'screen' }) {
  return kind === 'file' ? (
    <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  ) : (
    <MonitorSmartphone className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  );
}

/**
 * 工具调用的活动卡片
 * ----------------------------------------------------------------------------
 * 一个组件，三种状态，因为它们占的是同一块位置，而且不会同时出现：
 *
 *   1. **准备中** —— 模型正在攒工具调用。没有这个的话，那几秒里界面上只有光标，
 *      用户不知道它是在思考还是卡住了。多个调用会逐个冒出来。
 *   2. **待确认** —— 停下来问用户给不给。这是阶段 E 里最需要谨慎的一块。
 *   3. **执行结果** —— 逐项列出成功/失败。**失败原因用户也要看得到**，
 *      否则一个文件读失败、另一个成功时，用户只看到一句含糊的最终回答。
 *
 * 三条贯穿始终的原则：
 *   - 默认全选，但每项都能单独关掉（「我同意的是这一件」）
 *   - **不做「记住这次选择」**：一次授权长期有效等于把开关做废了
 *   - 拒绝/失败都要有明确的文字，不能只是静默跳过
 */
export function ToolActivityCard() {
  const progress = useChatStore((state) => state.toolProgress);
  const request = useChatStore((state) => state.toolRequest);
  const outcome = useChatStore((state) => state.toolOutcome);
  const resolve = useChatStore((state) => state.resolveToolRequest);
  const sending = useChatStore((state) => state.sending);

  // 默认全部允许；换了一批请求就重置
  const [selected, setSelected] = useState<boolean[]>([]);
  useEffect(() => {
    setSelected(request ? request.calls.map(() => true) : []);
  }, [request]);

  // 准备中优先：这时候请求还没成型，后面的状态都还不存在
  if (progress.length > 0) {
    return (
      <Shell testId="tool-progress" tone="neutral">
        <div className="flex items-start gap-2">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">模型正在准备访问请求…</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              它还没说完要读什么，先等一下 —— 下面这些是已经收到的。
            </p>
          </div>
        </div>

        <ul data-testid="tool-progress-list" className="mt-2.5 space-y-1.5">
          {progress.map((call: PendingToolCall) => {
            const info = toolLabel(call.name);
            return (
              <li
                key={call.index}
                data-testid="tool-progress-item"
                className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5"
              >
                <ItemIcon kind={info.icon} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                  {info.text}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  已收到 {call.argumentChars} 个字符
                </span>
              </li>
            );
          })}
        </ul>
      </Shell>
    );
  }

  if (request) {
    const allowedCount = selected.filter(Boolean).length;

    return (
      <Shell testId="tool-request" tone="warning">
        <div className="flex items-start gap-2">
          <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-foreground">模型想读一下这些内容，允许吗？</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              只有被允许的内容才会真正读出来发给模型。不允许的话，模型会被告知「用户拒绝了」。
            </p>
          </div>
        </div>

        <ul data-testid="tool-request-list" className="mt-2.5 space-y-1.5">
          {request.calls.map((call, index) => {
            const info = describe(call);
            const on = selected[index] !== false;

            return (
              <li
                key={call.id}
                data-testid="tool-request-item"
                data-allowed={on ? 'true' : 'false'}
                className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2"
              >
                <ItemIcon kind={info.icon} />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-foreground">{info.label}</p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    {info.detail}
                  </p>
                </div>

                <div className="flex shrink-0 gap-1">
                  <Button
                    variant={on ? 'primary' : 'ghost'}
                    size="sm"
                    data-testid="tool-allow"
                    className="h-6 px-2 text-[11px]"
                    onClick={() =>
                      setSelected((current) => current.map((value, i) => (i === index ? true : value)))
                    }
                  >
                    允许
                  </Button>
                  <Button
                    variant={on ? 'ghost' : 'danger'}
                    size="sm"
                    data-testid="tool-deny"
                    className="h-6 px-2 text-[11px]"
                    onClick={() =>
                      setSelected((current) =>
                        current.map((value, i) => (i === index ? false : value))
                      )
                    }
                  >
                    不允许
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            data-testid="tool-request-continue"
            disabled={sending}
            onClick={() => void resolve(selected)}
          >
            {allowedCount > 0 ? '按这个选择继续' : '全部不允许，继续'}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            已允许 {allowedCount} / {request.calls.length} 项
          </span>
        </div>
      </Shell>
    );
  }

  if (outcome && outcome.length > 0) {
    const failed = outcome.filter((item) => !item.ok).length;

    return (
      <Shell testId="tool-outcome" tone={failed > 0 ? 'warning' : 'neutral'}>
        <div className="flex items-start gap-2">
          {failed > 0 ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          <p className="text-[13px] font-medium text-foreground">
            刚才的访问结果（{outcome.length - failed} 项成功
            {failed > 0 ? `，${failed} 项失败` : ''}）
          </p>
        </div>

        <ul data-testid="tool-outcome-list" className="mt-2 space-y-1">
          {outcome.map((item, index) => (
            <li
              key={`${item.label}-${index}`}
              data-testid="tool-outcome-item"
              data-ok={item.ok ? 'true' : 'false'}
              className="flex items-start gap-2 text-[11px] leading-relaxed"
            >
              {item.ok ? (
                <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
              ) : (
                <X className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className={item.ok ? 'text-foreground/80' : 'text-foreground'}>{item.label}</span>
                <span className={item.ok ? 'text-muted-foreground' : 'text-warning'}>
                  {' '}
                  —— {item.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          完整结果（包括失败的那几项）都已经发回给模型了，它会据此继续回答。
        </p>
      </Shell>
    );
  }

  return null;
}

function Shell({
  children,
  testId,
  tone,
}: {
  children: React.ReactNode;
  testId: string;
  tone: 'warning' | 'neutral';
}) {
  return (
    <div className="shrink-0 border-t border-border bg-card px-6 py-3">
      <div className="mx-auto w-full max-w-3xl">
        <div
          data-testid={testId}
          className={
            tone === 'warning'
              ? 'rounded-xl border border-warning/50 bg-card p-3.5'
              : 'rounded-xl border border-border bg-card p-3.5'
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
