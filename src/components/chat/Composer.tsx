import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, MonitorSmartphone, SendHorizontal, Square, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AttachmentList } from '@/components/chat/AttachmentList';
import { FilePickerDialog } from '@/components/chat/FilePickerDialog';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { useChatStore, useConversationsStore, useSettingsStore } from '@/features';
import type { ChatAttachment } from '@/features';

const MAX_TEXTAREA_HEIGHT_PX = 180;

/** 把字节数说成人话 */
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer() {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const streaming = useChatStore((state) => state.streaming);
  const sending = useChatStore((state) => state.sending);
  const send = useChatStore((state) => state.send);
  const stop = useChatStore((state) => state.stop);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);
  const attach = useChatStore((state) => state.attach);
  const detach = useChatStore((state) => state.detach);
  const switchingConversation = useConversationsStore((state) => state.switchingConversation);

  const modelName = useSettingsStore((state) => state.modelConfig.modelName);
  const supportsVision = useSettingsStore((state) => state.modelConfig.supportsVision);
  const performsNetworkRequest = useSettingsStore((state) => state.performsNetworkRequest);
  const capabilities = useSettingsStore((state) => state.platformCapabilities);
  const fileAccessDirectory = useSettingsStore((state) => state.fileAccessDirectory);
  const readFile = useSettingsStore((state) => state.readFile);
  const lastScreenshot = useSettingsStore((state) => state.lastScreenshot);

  const busy = sending || streaming;
  const inputDisabled = busy || switchingConversation;

  const canAttachFile = capabilities.includes('file-read') && fileAccessDirectory.length > 0;
  const canAttachScreenshot = capabilities.includes('screenshot') && lastScreenshot !== null;
  const hasScreenshot = pendingAttachments.some((item) => item.kind === 'screenshot');
  /**
   * 有截图、但模型没标记成支持图片 —— 这时候发出去会被 Rust 侧拦下。
   * 与其让用户点了发送再吃一个报错，不如在这里就把话说清楚、并且拦住。
   */
  const visionBlocked = hasScreenshot && !supportsVision;

  const totalBytes = useMemo(
    () => pendingAttachments.reduce((sum, item) => sum + item.bytes, 0),
    [pendingAttachments]
  );

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, []);

  useEffect(resize, [text, resize]);

  async function handlePickFile(relativePath: string) {
    setPickerOpen(false);
    setAttachmentError(null);
    try {
      const content = await readFile(relativePath);
      attach({
        kind: 'file',
        name: relativePath.split('/').pop() ?? relativePath,
        relativePath,
        content: content.content,
        bytes: content.bytes,
        truncated: content.truncated,
      });
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleAttachScreenshot() {
    if (!lastScreenshot) return;
    setAttachmentError(null);
    attach({
      kind: 'screenshot',
      name: `屏幕截图 ${new Date(lastScreenshot.capturedAt).toLocaleTimeString()}`,
      dataUrl: lastScreenshot.dataUrl,
      width: lastScreenshot.width,
      height: lastScreenshot.height,
      bytes: lastScreenshot.bytes,
    });
  }

  function handleSendClick() {
    if (inputDisabled || visionBlocked) return;
    if (text.trim().length === 0 && pendingAttachments.length === 0) return;

    // 带附件时先确认：附件是会真的发出去的东西，
    // 用户得有一次看清「到底要发哪些内容」的机会
    if (pendingAttachments.length > 0) {
      setConfirmOpen(true);
      return;
    }

    void doSend();
  }

  async function doSend() {
    const value = text.trim();
    setConfirmOpen(false);
    setText('');
    await send(value);
    textareaRef.current?.focus();
  }

  return (
    <div className="shrink-0 border-t border-border bg-card px-6 py-3">
      <div className="mx-auto w-full max-w-3xl">
        {pendingAttachments.length > 0 && (
          <div className="mb-2">
            <AttachmentList attachments={pendingAttachments} onRemove={detach} />
          </div>
        )}

        <div className="flex items-end gap-2 rounded-xl border border-border bg-input p-2 transition-colors focus-within:border-primary">
          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="attach-file"
              title={
                canAttachFile ? '从已授权的文件夹里选一个文件加进来' : '需要先在设置里授权一个文件夹'
              }
              aria-label="附加文件"
              disabled={inputDisabled || !canAttachFile}
              onClick={() => setPickerOpen(true)}
            >
              <FilePlus2 className="size-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="attach-screenshot"
              title={
                canAttachScreenshot
                  ? '把设置里刚抓到的那张截图加进来'
                  : '需要先在设置里开启截屏并抓一张'
              }
              aria-label="附加截图"
              disabled={inputDisabled || !canAttachScreenshot}
              onClick={handleAttachScreenshot}
            >
              <MonitorSmartphone className="size-3.5" aria-hidden />
            </Button>
          </div>

          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            rows={1}
            value={text}
            disabled={inputDisabled}
            placeholder="输入消息，回车发送，Shift + 回车换行"
            aria-label="消息输入框"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // isComposing：中文输入法选字时的回车不能当发送
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleSendClick();
              }
            }}
            className="max-h-[180px] min-h-[30px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60"
          />

          {busy ? (
            <Button
              variant="outline"
              data-testid="stop-button"
              title="停止本轮发送；如果已开始生成，已生成的部分会保留"
              onClick={stop}
            >
              <Square className="size-3.5" aria-hidden />
              停止
            </Button>
          ) : (
            <Button
              variant="primary"
              data-testid="send-button"
              disabled={
                inputDisabled ||
                visionBlocked ||
                (text.trim().length === 0 && pendingAttachments.length === 0)
              }
              onClick={handleSendClick}
            >
              <SendHorizontal className="size-3.5" aria-hidden />
              发送
            </Button>
          )}
        </div>

        {visionBlocked && (
          <p
            role="alert"
            data-testid="vision-warning"
            className="mt-1.5 flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-warning"
          >
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              挂上了截图，但当前模型没标记成「支持图片输入」，发出去会被拦下。如果「{modelName}
              」其实能看图，请到设置的模型卡片里打开那个开关；否则把截图移除再发送。
            </span>
          </p>
        )}

        {attachmentError && (
          <p
            role="alert"
            data-testid="attachment-error"
            className="mt-1.5 px-1 text-[11px] leading-relaxed text-warning"
          >
            {attachmentError}
          </p>
        )}

        {/* 这行提示必须如实：桌面版会真的发请求，浏览器版不会。
            判断依据来自服务层的 performsNetworkRequest，不是写死的文案。 */}
        <p data-testid="composer-hint" className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          {performsNetworkRequest
            ? `回答由桌面端（Rust）发起真实请求，模型「${modelName}」。API Key 读取自系统凭据管理器。`
            : `浏览器模式：回答来自本地模拟，不联网、不调用真实模型。「${modelName}」只是记录下来的配置项。桌面版会接通真实请求。`}
        </p>
      </div>

      <FilePickerDialog
        open={pickerOpen}
        onPick={(relativePath) => void handlePickFile(relativePath)}
        onClose={() => setPickerOpen(false)}
      />

      <ConfirmDialog
        open={confirmOpen}
        title="确认发送这些内容？"
        confirmText="发送"
        description={
          <div className="space-y-2 text-[12px] leading-relaxed">
            <p>下面这些内容会一起发给模型：</p>
            <ul className="space-y-1">
              {text.trim().length > 0 && (
                <li className="truncate">
                  · 你的消息：
                  <span className="text-foreground">{text.trim().slice(0, 40)}</span>
                  {text.trim().length > 40 ? '…' : ''}
                </li>
              )}
              {pendingAttachments.map((item: ChatAttachment, index) => (
                <li key={`${item.name}-${index}`} className="truncate">
                  · {item.kind === 'screenshot' ? '截图' : '文件'}：
                  <span className="text-foreground">{item.name}</span>（{formatBytes(item.bytes)}）
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              合计 {pendingAttachments.length} 个附件、{formatBytes(totalBytes)}
              。附件内容会随这条消息保存在本地会话里。
            </p>
          </div>
        }
        onConfirm={() => void doSend()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
