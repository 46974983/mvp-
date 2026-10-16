import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, Plus, ShieldAlert, Square, Trash2, TriangleAlert } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { PLATFORM_CAPABILITY_SPECS, useSettingsStore } from '@/features';
import type { AutomationAction, AutomationReport, MouseButton } from '@/features';

/** 各类动作的数量上限，与 Rust 侧一致（见 docs/AUTOMATION_PROTOCOL.md） */
const MAX_ACTIONS = 20;
const MAX_TEXT_CHARS = 2000;
const MAX_TYPE_ACTIONS = 5;

/** 确认之后先等几秒再动手 —— 用户的手还在鼠标上 */
const COUNTDOWN_SECONDS = 3;

function defaultAction(kind: AutomationAction['kind']): AutomationAction {
  switch (kind) {
    case 'move':
      return { kind: 'move', x: 0, y: 0 };
    case 'click':
      return { kind: 'click', x: 0, y: 0, button: 'left' };
    case 'type':
      return { kind: 'type', text: '' };
    case 'wait':
      return { kind: 'wait', ms: 300 };
  }
}

/**
 * 预览文案。
 *
 * **和 Rust 侧 `AutomationAction::describe()` 是同一套说法**，刻意对齐：
 * 用户确认时看到的那句话，和执行报告里记的必须是同一句，
 * 否则「它到底做了什么」就有两种说法。
 */
function describe(action: AutomationAction): string {
  switch (action.kind) {
    case 'move':
      return `把鼠标移到 (${action.x}, ${action.y})`;
    case 'click': {
      const label = { left: '左键', right: '右键', middle: '中键' }[action.button];
      return `在 (${action.x}, ${action.y}) 点一下${label}`;
    }
    case 'type': {
      const trimmed = action.text.trim();
      const preview = [...trimmed].slice(0, 20).join('');
      return `输入「${preview}${[...trimmed].length > 20 ? '…' : ''}」`;
    }
    case 'wait':
      return `等 ${action.ms} 毫秒`;
  }
}

/** 本地先做一遍明显能查的检查，让用户在点「执行」之前就看到问题 */
function findLocalProblem(actions: AutomationAction[]): string | null {
  if (actions.length === 0) return '还没有添加任何动作。';
  if (actions.length > MAX_ACTIONS) return `一个任务最多 ${MAX_ACTIONS} 个动作。`;

  const typeCount = actions.filter((action) => action.kind === 'type').length;
  if (typeCount > MAX_TYPE_ACTIONS) return `一个任务最多 ${MAX_TYPE_ACTIONS} 个输入动作。`;

  let clicked = false;
  for (const [index, action] of actions.entries()) {
    const position = index + 1;
    if (action.kind === 'click') clicked = true;
    if (action.kind === 'type') {
      if (action.text.trim().length === 0) return `第 ${position} 个动作要输入的内容是空的。`;
      if ([...action.text].length > MAX_TEXT_CHARS) {
        return `第 ${position} 个动作要输入的字数超过了 ${MAX_TEXT_CHARS} 字的上限。`;
      }
      // 和 Rust 侧同一条规则：文字会打到当前有焦点的窗口上
      if (!clicked) return `第 ${position} 个是输入动作，但它前面没有点击动作 —— 先点一下目标位置。`;
    }
  }

  return null;
}

function formatElapsed(ms: number) {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * 键鼠模拟与自动化任务
 * ----------------------------------------------------------------------------
 * 这是全项目**权限最重**的一项。前面几项最坏是「看到了不该看的」，
 * 这一项能代替用户去操作别的程序 —— 最坏是「在用户没预期的地方点出了后果」。
 *
 * 所以界面上有三层东西，缺一不可：
 *   1. **开关**（默认关闭）—— 表达「我同意这件事存在」
 *   2. **预览 + 确认**（每次执行都要）—— 表达「我同意这一次做这些动作」
 *   3. **停止 + 报告** —— 出问题时能叫停，事后能回看它做了什么
 *
 * 协议与各项上限的理由写在 `docs/AUTOMATION_PROTOCOL.md`。
 */
export function AutomationSettings() {
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const loaded = useSettingsStore((state) => state.loaded);
  const enabled = useSettingsStore((state) => state.inputSimulationEnabled);
  const setEnabled = useSettingsStore((state) => state.setInputSimulationEnabled);
  const draft = useSettingsStore((state) => state.automationDraft);
  const setDraft = useSettingsStore((state) => state.setAutomationDraft);
  const running = useSettingsStore((state) => state.automationRunning);
  const report = useSettingsStore((state) => state.automationReport);
  const runAutomation = useSettingsStore((state) => state.runAutomation);
  const stopAutomation = useSettingsStore((state) => state.stopAutomation);
  const lastScreenshot = useSettingsStore((state) => state.lastScreenshot);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [countdown, setCountdown] = useState(0);
  /** 正在等待取自截图的动作下标；null 表示没在取点 */
  const [picking, setPicking] = useState<number | null>(null);
  const countdownTimer = useRef<number | null>(null);

  const supported = capabilities.includes('input-simulation');
  const spec = PLATFORM_CAPABILITY_SPECS['input-simulation'];
  const localProblem = useMemo(() => findLocalProblem(draft), [draft]);

  // 离开页面时把倒计时清掉，免得回来时莫名其妙开始执行
  useEffect(() => {
    return () => {
      if (countdownTimer.current !== null) window.clearInterval(countdownTimer.current);
    };
  }, []);

  function update(index: number, patch: Partial<AutomationAction>) {
    setDraft(
      draft.map((action, i) => (i === index ? ({ ...action, ...patch } as AutomationAction) : action))
    );
  }

  function changeKind(index: number, kind: AutomationAction['kind']) {
    setDraft(draft.map((action, i) => (i === index ? defaultAction(kind) : action)));
    setPicking(null);
  }

  function remove(index: number) {
    setDraft(draft.filter((_, i) => i !== index));
    setPicking(null);
  }

  function add(kind: AutomationAction['kind']) {
    if (draft.length >= MAX_ACTIONS) {
      setError(`一个任务最多 ${MAX_ACTIONS} 个动作。`);
      return;
    }
    setDraft([...draft, defaultAction(kind)]);
  }

  /** 在截图上点一下，把坐标填进正在取点的那个动作 */
  function handlePickOnImage(event: React.MouseEvent<HTMLImageElement>) {
    if (picking === null || !lastScreenshot) return;

    const rect = event.currentTarget.getBoundingClientRect();
    // 图是等比缩放显示的，所以要换算回原始像素 —— 原始像素就是屏幕坐标
    const x = Math.round(((event.clientX - rect.left) / rect.width) * lastScreenshot.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * lastScreenshot.height);

    update(picking, { x, y } as Partial<AutomationAction>);
    setPicking(null);
  }

  async function handleToggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await setEnabled(next);
      if (result.ok) toast.success(result.message);
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  async function doRun() {
    setConfirmOpen(false);
    setError(null);

    // 确认之后不立刻动手：用户的手还在鼠标上，第一条「移动」会把光标拽走。
    // 留几秒让他把手拿开 —— 确认弹窗里那句「请把手拿开」必须是真话。
    for (let left = COUNTDOWN_SECONDS; left > 0; left -= 1) {
      setCountdown(left);
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    setCountdown(0);

    try {
      await runAutomation(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const positionActions = draft
    .map((action, index) => ({ action, index }))
    .filter(
      (item): item is { action: Extract<AutomationAction, { x: number }>; index: number } =>
        item.action.kind === 'move' || item.action.kind === 'click'
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>自动化（键鼠模拟）</CardTitle>
        <CardDescription>
          按你确认过的动作列表去操作鼠标键盘。默认关闭，而且每一次执行都要重新确认。
        </CardDescription>
      </CardHeader>

      <CardContent>
        {!supported && (
          <div
            data-testid="automation-unavailable"
            className="rounded-lg border border-border bg-muted/50 p-3.5 text-[12px] leading-relaxed text-muted-foreground"
          >
            {loaded
              ? '浏览器动不了你的鼠标键盘。桌面版本里这一项可用。'
              : '正在探测当前环境的平台能力…'}
            <p className="mt-1 text-[11px]">桌面版本里能做的事：{spec.description}。</p>
          </div>
        )}

        {supported && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                <p className="text-foreground/80">
                  开启后，助手能按动作列表真的移动鼠标、点击、输入文字。
                  它只认坐标，不认识「窗口」—— 点下去会发生什么，取决于坐标底下是什么。
                </p>
                <p>
                  所以每次执行前都会把动作逐条列给你看，你点了确认、再过几秒才会开始。
                  执行中随时可以停止。
                </p>
              </div>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="input-simulation">允许助手模拟键鼠</Label>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  开关关着的时候，即使有人直接调用执行命令也会被拒绝。
                </p>
              </div>
              {busy ? (
                <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              ) : (
                <Switch
                  id="input-simulation"
                  data-testid="input-simulation-switch"
                  checked={enabled}
                  onCheckedChange={(checked) => void handleToggle(checked)}
                />
              )}
            </div>

            {enabled && (
              <>
                {/* 取坐标只能从截图上来 —— 图上的像素坐标就是屏幕坐标 */}
                {lastScreenshot ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>
                        这张截图上的像素坐标就是屏幕坐标
                        {picking !== null ? '：点一下图里的位置，填进第 ' + (picking + 1) + ' 个动作' : ''}
                      </span>
                    </div>
                    <div className="relative inline-block max-w-full">
                      <img
                        data-testid="automation-screenshot"
                        src={lastScreenshot.dataUrl}
                        alt="用来取坐标的屏幕截图"
                        className={`max-h-56 max-w-full rounded-md border border-border object-contain ${
                          picking !== null ? 'cursor-crosshair ring-2 ring-primary' : ''
                        }`}
                        onClick={handlePickOnImage}
                      />
                      {/* 把每个定位动作标出来，方便对着图核对顺序 */}
                      {positionActions.map((item) => (
                        <span
                          key={item.index}
                          data-testid="automation-marker"
                          className="pointer-events-none absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground"
                          style={{
                            left: `${(item.action.x / lastScreenshot.width) * 100}%`,
                            top: `${(item.action.y / lastScreenshot.height) * 100}%`,
                          }}
                        >
                          {item.index + 1}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p
                    data-testid="automation-needs-screenshot"
                    className="rounded-lg border border-border bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground"
                  >
                    还没有可用的截图。先到上面的「截屏」卡片里抓一张 —— 坐标要从图上取，
                    光靠猜很容易点错地方。
                  </p>
                )}

                {/* 动作列表 */}
                <div className="space-y-1.5">
                  <Label>动作列表</Label>
                  {draft.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">还没有动作，从下面加一个。</p>
                  ) : (
                    <ul data-testid="automation-actions" className="space-y-1.5">
                      {draft.map((action, index) => (
                        <li
                          key={index}
                          data-testid="automation-action"
                          data-kind={action.kind}
                          className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1.5"
                        >
                          <span className="w-4 shrink-0 text-[10px] text-muted-foreground">
                            {index + 1}
                          </span>

                          <select
                            data-testid="action-kind"
                            className="h-7 shrink-0 rounded-md border border-border bg-card px-1.5 text-[11px]"
                            value={action.kind}
                            onChange={(event) =>
                              changeKind(index, event.target.value as AutomationAction['kind'])
                            }
                          >
                            <option value="move">移动</option>
                            <option value="click">点击</option>
                            <option value="type">输入</option>
                            <option value="wait">等待</option>
                          </select>

                          {(action.kind === 'move' || action.kind === 'click') && (
                            <>
                              <Input
                                data-testid="action-x"
                                type="number"
                                className="h-7 w-20 text-[11px]"
                                value={action.x}
                                onChange={(event) =>
                                  update(index, { x: Number(event.target.value) || 0 })
                                }
                              />
                              <Input
                                data-testid="action-y"
                                type="number"
                                className="h-7 w-20 text-[11px]"
                                value={action.y}
                                onChange={(event) =>
                                  update(index, { y: Number(event.target.value) || 0 })
                                }
                              />
                              <Button
                                variant={picking === index ? 'primary' : 'outline'}
                                size="sm"
                                data-testid="action-pick"
                                disabled={!lastScreenshot}
                                onClick={() => setPicking(picking === index ? null : index)}
                              >
                                {picking === index ? '点上图' : '取点'}
                              </Button>
                            </>
                          )}

                          {action.kind === 'click' && (
                            <select
                              data-testid="action-button"
                              className="h-7 rounded-md border border-border bg-card px-1.5 text-[11px]"
                              value={action.button}
                              onChange={(event) =>
                                update(index, { button: event.target.value as MouseButton })
                              }
                            >
                              <option value="left">左键</option>
                              <option value="right">右键</option>
                              <option value="middle">中键</option>
                            </select>
                          )}

                          {action.kind === 'type' && (
                            <Input
                              data-testid="action-text"
                              className="h-7 min-w-[10rem] flex-1 text-[11px]"
                              placeholder="要输入的文字"
                              value={action.text}
                              onChange={(event) => update(index, { text: event.target.value })}
                            />
                          )}

                          {action.kind === 'wait' && (
                            <>
                              <Input
                                data-testid="action-ms"
                                type="number"
                                className="h-7 w-24 text-[11px]"
                                value={action.ms}
                                onChange={(event) =>
                                  update(index, { ms: Number(event.target.value) || 0 })
                                }
                              />
                              <span className="text-[11px] text-muted-foreground">毫秒</span>
                            </>
                          )}

                          <Button
                            variant="ghost"
                            size="icon-sm"
                            data-testid="action-remove"
                            className="ml-auto shrink-0"
                            aria-label={`删除第 ${index + 1} 个动作`}
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {(['move', 'click', 'type', 'wait'] as const).map((kind) => (
                      <Button
                        key={kind}
                        variant="outline"
                        size="sm"
                        data-testid={`add-${kind}`}
                        disabled={draft.length >= MAX_ACTIONS}
                        onClick={() => add(kind)}
                      >
                        <Plus className="size-3" aria-hidden />
                        {{ move: '移动', click: '点击', type: '输入', wait: '等待' }[kind]}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* 预览：执行前必须看到的那些话 */}
                {draft.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/50 p-3">
                    <div className="text-[11px] text-muted-foreground">执行预览</div>
                    <ol data-testid="automation-preview" className="mt-1 space-y-0.5">
                      {draft.map((action, index) => (
                        <li key={index} className="text-[11px] leading-relaxed text-foreground/80">
                          {index + 1}. {describe(action)}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {localProblem && (
                  <p
                    role="alert"
                    data-testid="automation-problem"
                    className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning"
                  >
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span>{localProblem}</span>
                  </p>
                )}

                {error && (
                  <p
                    role="alert"
                    data-testid="automation-error"
                    className="text-[11px] leading-relaxed text-warning"
                  >
                    {error}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {running ? (
                    <Button variant="danger" data-testid="stop-automation" onClick={() => void stopAutomation()}>
                      <Square className="size-3.5" aria-hidden />
                      停止
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="run-automation"
                      disabled={localProblem !== null}
                      onClick={() => setConfirmOpen(true)}
                    >
                      <Play className="size-3.5" aria-hidden />
                      执行…
                    </Button>
                  )}
                  {countdown > 0 && (
                    <span data-testid="automation-countdown" className="text-[11px] text-warning">
                      {countdown} 秒后开始 —— 请把鼠标放下
                    </span>
                  )}
                </div>

                {/* 执行报告：它到底做了什么 */}
                {report && <RunReport report={report} />}
              </>
            )}

            {!enabled && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                先打开上面的开关才能编排动作。
              </p>
            )}
          </div>
        )}
      </CardContent>

      <CardActions>
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          {supported
            ? '支持的动作只有四种：移动、点击、输入、等待。没有条件、没有循环、没有脚本 —— 协议本身就表达不出「重复执行」。'
            : spec.description}
        </span>
      </CardActions>

      <ConfirmDialog
        open={confirmOpen}
        title="确认执行这些动作？"
        confirmText="开始执行"
        description={
          <div className="space-y-2 text-[12px] leading-relaxed">
            <p>接下来会按这个顺序动你的鼠标键盘：</p>
            <ol className="max-h-48 space-y-0.5 overflow-y-auto">
              {draft.map((action, index) => (
                <li key={index} className="text-foreground/90">
                  {index + 1}. {describe(action)}
                </li>
              ))}
            </ol>
            <p className="text-warning">
              点「开始执行」后有 {COUNTDOWN_SECONDS} 秒倒计时，请把手从鼠标上拿开 ——
              第一条动作就会把光标移走。
            </p>
            <p className="text-muted-foreground">
              过程中随时可以点「停止」。它只认坐标，不认识窗口，所以点下去会发生什么取决于坐标底下是什么。
            </p>
          </div>
        }
        onConfirm={() => void doRun()}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
}

/** 最近一次执行的报告 */
function RunReport({ report }: { report: AutomationReport }) {
  const finished = !report.stopped && !report.timedOut;

  return (
    <div className="rounded-lg border border-border bg-muted/50 p-3">
      <div className="flex flex-wrap items-center gap-x-2 text-[11px]">
        <span data-testid="automation-report" className="text-muted-foreground">
          最近一次执行：完成 {report.steps.filter((step) => step.ok).length} 步，
          用时 {formatElapsed(report.elapsedMs)}
        </span>
        {report.stopped && <span className="text-warning">· 被中止</span>}
        {report.timedOut && <span className="text-warning">· 超时中止</span>}
        {finished && report.steps.some((step) => !step.ok) && (
          <span className="text-warning">· 有一步失败了</span>
        )}
      </div>

      <ul data-testid="automation-log" className="mt-1.5 space-y-0.5">
        {report.steps.map((step) => (
          <li
            key={`${step.index}-${step.action}`}
            data-ok={step.ok ? 'true' : 'false'}
            className="flex items-start gap-1.5 text-[11px] leading-relaxed"
          >
            <span className="shrink-0 text-muted-foreground">{step.index + 1}.</span>
            <span className={step.ok ? 'text-foreground/80' : 'text-warning'}>{step.action}</span>
            {!step.ok && <span className="text-warning">—— {step.detail}</span>}
          </li>
        ))}
      </ul>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        报告只记在内存里，重启就没有了。日志里不记你输入的文字内容，只记字数。
      </p>
    </div>
  );
}
