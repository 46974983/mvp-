/**
 * 唯一 id 生成
 * ----------------------------------------------------------------------------
 * 阶段 A 在本机生成。阶段 B 换成 SQLite 的 AUTOINCREMENT / uuid 时，
 * 只需要保证外部拿到的仍然是一个字符串，调用方不用改。
 */
let counter = 0;

export function createId(prefix: string): string {
  counter += 1;
  const time = Date.now().toString(36);
  const seq = counter.toString(36);
  return `${prefix}_${time}${seq}`;
}

/** 仅供测试使用：把计数器复位，避免用例之间互相影响 */
export function __resetIdCounter(): void {
  counter = 0;
}
