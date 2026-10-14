/**
 * 阶段 A 边界测试
 * ----------------------------------------------------------------------------
 * 阶段 A 不是「功能少一点的版本」，而是一个有明确安全承诺的阶段：
 *   不联网、不落 Key、不碰原生能力。
 * 这些承诺靠人自觉是守不住的 —— 半年后有人顺手加个 fetch 也没人发现。
 * 所以把它们写成可执行的断言：违反了就红。
 *
 * 到阶段 B 时，这些用例里会有一条需要改写（网络调用会被允许，但必须走 Rust 侧）。
 * 那时改这个文件，正是这个文件存在的意义 —— 边界是被显式移动的，不是被悄悄绕过的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const collected = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collected.push(...walk(full));
    else collected.push(full);
  }
  return collected;
}

const sourceFiles = walk(SRC).map((full) => ({
  relative: path.relative(ROOT, full).split(path.sep).join('/'),
  content: fs.readFileSync(full, 'utf8'),
}));

const readSource = (suffix) => {
  const found = sourceFiles.find((file) => file.relative.endsWith(suffix));
  assert.ok(found, `找不到源文件：${suffix}`);
  return found.content;
};

// ---------------------------------------------------------------------------
// 1. 不联网
// ---------------------------------------------------------------------------

test('阶段 A 的 src 中不存在任何发起网络请求的调用', () => {
  const forbidden = [
    { pattern: /\bfetch\s*\(/, label: 'fetch()' },
    { pattern: /new\s+XMLHttpRequest/, label: 'XMLHttpRequest' },
    { pattern: /new\s+WebSocket\s*\(/, label: 'WebSocket' },
    { pattern: /\bEventSource\s*\(/, label: 'EventSource' },
    { pattern: /navigator\.sendBeacon/, label: 'sendBeacon' },
  ];

  for (const file of sourceFiles) {
    for (const { pattern, label } of forbidden) {
      assert.ok(
        !pattern.test(file.content),
        `${file.relative} 出现了 ${label}：阶段 A 不允许任何网络出口`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. 不落 Key
// ---------------------------------------------------------------------------

test('本地存储只允许出现两个键，且都不含凭据', () => {
  const allowed = ['desktop-ai-assistant:mvp', 'desktop-ai-assistant:theme'];
  const scanned = [
    ...sourceFiles,
    { relative: 'index.html', content: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') },
  ];

  const found = new Set();
  for (const file of scanned) {
    for (const match of file.content.matchAll(/desktop-ai-assistant:[a-zA-Z0-9:_-]+/g)) {
      found.add(match[0]);
    }
  }

  assert.deepEqual(
    [...found].sort(),
    [...allowed].sort(),
    '检测到计划之外的本地存储键，请确认没有把敏感信息写进存储'
  );
});

test('可持久化的设置结构里不包含 apiKey', () => {
  const domain = readSource('src/types/domain.ts');
  const settingsBlock = /interface AppSettings\s*\{([\s\S]*?)\n\}/.exec(domain);
  assert.ok(settingsBlock, '未能在 domain.ts 中找到 AppSettings 定义');
  assert.ok(
    !/apiKey/.test(settingsBlock[1]),
    'AppSettings 是可持久化结构，不允许包含 apiKey'
  );

  const storage = readSource('src/services/storage/browser-storage.ts');
  const snapshotBlock = /interface StorageSnapshot\s*\{([\s\S]*?)\n\}/.exec(storage);
  assert.ok(snapshotBlock, '未能在 browser-storage.ts 中找到 StorageSnapshot 定义');
  assert.ok(
    !/apiKey/.test(snapshotBlock[1]),
    'StorageSnapshot 是写盘结构，不允许包含 apiKey'
  );
});

test('存储层不依赖模型配置类型', () => {
  const storageFiles = sourceFiles.filter((file) =>
    file.relative.startsWith('src/services/storage/')
  );
  assert.ok(storageFiles.length >= 3, '存储层文件数量异常');

  for (const file of storageFiles) {
    assert.ok(
      !/import[^;]*ModelConfig/.test(file.content),
      `${file.relative} 引入了 ModelConfig：存储层不应该知道模型配置的存在`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. 不碰原生能力
// ---------------------------------------------------------------------------

test('未引入桌面外壳依赖，也未创建 src-tauri', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allDependencies = Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  });

  const shellLike = allDependencies.filter((name) => /tauri|electron/i.test(name));
  assert.deepEqual(shellLike, [], `阶段 A 不应引入桌面外壳依赖：${shellLike.join(', ')}`);
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'src-tauri')),
    'src-tauri 属于阶段 B，阶段 A 不应存在'
  );
});

test('阶段 A 的默认 provider 是离线实现', () => {
  const modelIndex = readSource('src/services/model/index.ts');
  assert.match(modelIndex, /return new MockModelProvider\(\)/);

  const mockProvider = readSource('src/services/model/mock-provider.ts');
  assert.match(
    mockProvider,
    /performsNetworkRequest = false/,
    '离线实现必须如实声明自己不联网'
  );
});

// ---------------------------------------------------------------------------
// 4. 分层边界：组件不直连服务层
// ---------------------------------------------------------------------------

test('组件层只能通过 features 访问服务，不直接 import services', () => {
  const componentFiles = sourceFiles.filter((file) =>
    file.relative.startsWith('src/components/')
  );
  assert.ok(componentFiles.length >= 10, '组件文件数量异常');

  for (const file of componentFiles) {
    assert.ok(
      !/from\s+['"]@\/services/.test(file.content),
      `${file.relative} 直接引用了 @/services：组件应通过 @/features 这层领域服务访问`
    );
    assert.ok(
      !/from\s+['"]@\/services\/platform/.test(file.content),
      `${file.relative} 直接引用了平台实现`
    );
  }
});

test('组件层不直接触碰 Web Storage', () => {
  for (const file of sourceFiles.filter((f) => f.relative.startsWith('src/components/'))) {
    assert.ok(
      !/localStorage|sessionStorage/.test(file.content),
      `${file.relative} 直接操作了 Web Storage，应走 storage 服务`
    );
  }
});

// ---------------------------------------------------------------------------
// 5. 日志脱敏
// ---------------------------------------------------------------------------

test('存在统一的脱敏出口，且日志不直接使用 console', () => {
  const logger = readSource('src/lib/log.ts');
  assert.match(logger, /redactSensitive/);

  const offenders = sourceFiles.filter(
    (file) =>
      /console\.(log|warn|error|debug)/.test(file.content) &&
      !file.relative.endsWith('src/lib/log.ts')
  );
  assert.deepEqual(
    offenders.map((file) => file.relative),
    [],
    '除 src/lib/log.ts 外不允许直接使用 console，否则脱敏会被绕过'
  );
});
