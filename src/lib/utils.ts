import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 className：clsx 处理条件拼接，tailwind-merge 消掉互相冲突的 Tailwind 类 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
