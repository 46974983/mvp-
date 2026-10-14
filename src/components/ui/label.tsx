import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * 表单标签
 * 用 Radix 而不是原生 <label>：点击 label 聚焦控件、以及和 aria 属性的联动
 * 交给 Radix 处理，不用自己拼 htmlFor。
 */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-[13px] font-medium text-foreground select-none', className)}
      {...props}
    />
  );
}
