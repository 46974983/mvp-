import { FileText, ImageIcon, X } from 'lucide-react';
import type { ChatAttachment } from '@/features';

/** 把字节数说成人话 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface AttachmentListProps {
  attachments: ChatAttachment[];
  /** 传了才显示移除按钮。消息里的附件是历史，不该能删 */
  onRemove?: (index: number) => void;
}

/**
 * 附件列表
 * ----------------------------------------------------------------------------
 * 输入区和消息气泡共用。两处的差别只有一个：能不能移除 ——
 * 待发送的可以拿掉，已经发出去的属于历史，不给删。
 *
 * 截图直接渲染缩略图而不是只写「屏幕截图」：用户要能一眼确认
 * 「待会儿要发出去的是不是这一张」，只给个文件名是做不到的。
 */
export function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <ul data-testid="attachment-list" className="flex flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <li
          key={`${attachment.kind}-${attachment.name}-${index}`}
          data-testid="attachment-item"
          data-kind={attachment.kind}
          className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-2"
        >
          {attachment.kind === 'screenshot' ? (
            <img
              src={attachment.dataUrl}
              alt="待发送的截图"
              className="size-8 shrink-0 rounded border border-border object-cover"
            />
          ) : (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}

          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[11px] leading-tight text-foreground">
              {attachment.name}
            </span>
            <span className="flex items-center gap-1 text-[10px] leading-tight text-muted-foreground">
              {attachment.kind === 'screenshot' && (
                <>
                  <ImageIcon className="size-2.5" aria-hidden />
                  <span>
                    {attachment.width}×{attachment.height}
                  </span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{formatBytes(attachment.bytes)}</span>
              {attachment.kind === 'file' && attachment.truncated && (
                <span className="text-warning">· 已截断</span>
              )}
            </span>
          </span>

          {onRemove && (
            <button
              type="button"
              data-testid="attachment-remove"
              aria-label={`移除 ${attachment.name}`}
              title="移除"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onRemove(index)}
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
