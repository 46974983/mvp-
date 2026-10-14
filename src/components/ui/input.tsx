import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-border bg-input px-2.5 text-[13px]',
        'placeholder:text-muted-foreground/70',
        'transition-colors focus-visible:border-primary focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-md border border-border bg-input px-2.5 py-2 text-[13px] leading-relaxed',
        'placeholder:text-muted-foreground/70',
        'transition-colors focus-visible:border-primary focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}
