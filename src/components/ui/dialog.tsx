import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Dialog 原语
 * ----------------------------------------------------------------------------
 * 这一层只做一件事：把 Radix 的无头组件套上本项目的视觉样式。
 * 它不知道「删除会话」是什么，也不认识业务概念。
 *
 * 为什么用 Radix 而不是自己撸一个 div：
 *   焦点陷阱、Esc 关闭、点遮罩关闭、aria-modal、背景滚动锁定 —— 无障碍细节它全包了。
 *   手写十有八九会漏掉其中两三项，而这几项恰恰是键盘用户和读屏用户唯一的入口。
 *
 * 组合件（真正带业务语义的弹窗）放在 components/feedback/ 下，见 ConfirmDialog。
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]', className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-[min(400px,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-5 shadow-lg',
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-sm font-semibold text-popover-foreground', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('mt-2 text-[13px] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}
