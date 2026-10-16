import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Message } from '@/types';
import { cn } from '@/lib/utils';
import { formatClockTime } from '@/lib/time';
import { renderMarkdown } from '@/lib/markdown';
import { Button } from '@/components/ui/button';
import { AttachmentList } from '@/components/chat/AttachmentList';

const STATUS_HINT: Partial<Record<Message['status'], string>> = {
  aborted: '已停止生成',
  error: '生成失败',
  streaming: '正在生成',
};

interface MessageBubbleProps {
  message: Message;
  /** 实际展示的文本。流式过程中它来自 chat store，而不是已落库的 message.content */
  content: string;
  /** 头像里的那个字：助手名首字 / 用户名首字 */
  avatarLabel: string;
  streaming?: boolean;
}

export function MessageBubble({
  message,
  content,
  avatarLabel,
  streaming = false,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 非安全上下文（比如 http 下的某些浏览器）拿不到剪贴板权限，给用户留一条手动路
      toast.error('复制失败，请手动选中内容复制');
    }
  }

  const statusHint = STATUS_HINT[message.status];

  return (
    <article
      data-testid="message"
      data-role={message.role}
      data-status={message.status}
      className={cn('flex gap-3', isUser ? 'flex-row-reverse' : 'flex-row')}
    >
      <div
        aria-hidden
        data-testid="message-avatar"
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium select-none',
          isUser ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'
        )}
      >
        {avatarLabel}
      </div>

      <div className={cn('flex min-w-0 max-w-[calc(100%-3rem)] flex-col', isUser && 'items-end')}>
        {/* 附件放在气泡外面：截图的缩略图放进去会把气泡撑得很难看，
            而且「这条消息带了什么」和「消息说了什么」本来就是两件事 */}
        {message.attachments.length > 0 && (
          <div className="mb-1.5" data-testid="message-attachments">
            <AttachmentList attachments={message.attachments} />
          </div>
        )}

        <div
          className={cn(
            'rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed',
            isUser
              ? 'bg-bubble-user text-bubble-user-foreground'
              : 'bg-bubble-assistant text-foreground'
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{content}</p>
          ) : (
            <div className="markdown">
              <div
                // 内容在 renderMarkdown 里已整体做过 HTML 转义，见 src/lib/markdown.ts 顶部说明
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
              {streaming && (
                <span
                  aria-hidden
                  data-testid="streaming-cursor"
                  className="ml-0.5 inline-block h-[13px] w-[7px] translate-y-[2px] animate-pulse bg-primary align-middle"
                />
              )}
            </div>
          )}
        </div>

        <div className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
          <span>{formatClockTime(message.createdAt)}</span>
          {statusHint && <span>{statusHint}</span>}
          {!isUser && content.length > 0 && !streaming && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="复制回复"
              data-testid="copy-message"
              onClick={() => void handleCopy()}
            >
              {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
