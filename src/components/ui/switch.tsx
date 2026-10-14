import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * 开关
 * ----------------------------------------------------------------------------
 * 用 Radix 而不是自己拼一个 div：`role="switch"`、空格键切换、
 * aria-checked 这些无障碍细节它都处理好了。手写很容易漏，
 * 而漏掉之后键盘用户就没法操作这个开关了。
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
        'border border-transparent transition-colors',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow transition-transform',
          'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5'
        )}
      />
    </SwitchPrimitive.Root>
  );
}
