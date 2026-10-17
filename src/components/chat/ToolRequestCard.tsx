import { useEffect, useState } from 'react';
import { FileText, MonitorSmartphone, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/features';
import type { ToolCall } from '@/features';

/** 一个调用对应的人话说明，以及它会不会被读到什么 */
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

/**
 * 「模型请求访问内容」的确认框
 * ----------------------------------------------------------------------------
 * 这是阶段 E 里最需要谨慎的一块：**模型自己想读东西了**。
 *
 * 三个刻意的设定：
 *
 * 1. **默认全选，但每一行都能单独关掉。** 默认全选是因为用户既然发了这条消息，
 *    多半就是想让模型看；但一行一行能关，才谈得上「我同意的是这一件」。
 * 2. **不做「记住这次选择」。** 每次请求都要重新确认 ——
 *    一次授权长期有效，等于把开关做废了。
 * 3. **拒绝也要告诉模型。** 否则它会一直重试同一个请求，
 *    用户看到的是「模型卡住了」而不是「我刚才拒绝了」。
 */
export function ToolRequestCard() {
  const request = useChatStore((state) => state.toolRequest);
  const resolve = useChatStore((state) => state.resolveToolRequest);
  const sending = useChatStore((state) => state.sending);

  // 默认全部允许；换了一批请求就重置
  const [selected, setSelected] = useState<boolean[]>([]);
  useEffect(() => {
    setSelected(request ? request.calls.map(() => true) : []);
  }, [request]);

  if (!request) return null;

  const allowedCount = selected.filter(Boolean).length;

  return (
    <div className="shrink-0 border-t border-border bg-warning/5 px-6 py-3">
      <div className="mx-auto w-full max-w-3xl">
        <div
          data-testid="tool-request"
          className="rounded-xl border border-warning/50 bg-card p-3.5"
        >
          <div className="flex items-start gap-2">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-foreground">
                模型想读一下这些内容，允许吗？
              </p>
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
                  {info.icon === 'file' ? (
                    <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <MonitorSmartphone
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  )}

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
                        setSelected((current) =>
                          current.map((value, i) => (i === index ? true : value))
                        )
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
        </div>
      </div>
    </div>
  );
}
