/**
 * 能力完整性契约
 * ----------------------------------------------------------------------------
 * 阶段 C 开始引入 Tauri 插件与原生能力。每加一种能力，都必须同时补齐六件事：
 *
 *   1. Rust / Tauri 配置          ← 本文件检
 *   2. capabilities 权限           ← 本文件检（并且检查「没有多放开」）
 *   3. PlatformService 接口        ← 本文件检
 *   4. 浏览器模式 fallback         ← 本文件检
 *   5. 单元 / 契约测试             ← 本文件检
 *   6. Windows 桌面构建验证        ← 跑 `tauri build --no-bundle`，脚本检不了
 *
 * 前五项能自动检的都在这里检。这样「加了半截能力」会在提交前就红，
 * 而不是等用户点到那个按钮才发现。
 *
 * 这个文件也是一份**清单**：新加能力时，先在这里补一行，再照着自己列的东西去实现。
 * 第 1 条断言会保证你不会忘了补这一行 —— 枚举和清单对不上就报错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

// ---------------------------------------------------------------------------
// 能力清单（这份清单是「检查项」，不是「实现」）
// desktopImplemented=false 表示还没做，那时 desktopCommands / rustModules 必须为空
// ---------------------------------------------------------------------------

const CAPABILITY_CHECKLIST = [
  {
    id: 'tray',
    desktopImplemented: true,
    desktopCommands: [
      'platform_capabilities',
      'hide_to_tray',
      'close_to_tray_enabled',
      'set_close_to_tray',
    ],
    rustModules: ['src-tauri/src/tray.rs', 'src-tauri/src/window.rs'],
  },
  { id: 'notification', desktopImplemented: false, desktopCommands: [], rustModules: [] },
  { id: 'autostart', desktopImplemented: false, desktopCommands: [], rustModules: [] },
  { id: 'file-read', desktopImplemented: false, desktopCommands: [], rustModules: [] },
  { id: 'screenshot', desktopImplemented: false, desktopCommands: [], rustModules: [] },
];

// ---------------------------------------------------------------------------
// 从源文件里读出「事实」
// ---------------------------------------------------------------------------

const platformTypes = read('src/services/platform/types.ts');
const browserPlatform = read('src/services/platform/browser-platform.ts');
const tauriPlatform = read('src/services/platform/tauri-platform.ts');
const platformIndex = read('src/services/platform/index.ts');
const featuresIndex = read('src/features/index.ts');
const dataPanel = read('src/components/settings/DataPanel.tsx');
const rustCommands = read('src-tauri/src/commands.rs');
const rustLib = read('src-tauri/src/lib.rs');
const cargo = read('src-tauri/Cargo.toml');

/** 从 types.ts 里解析出能力枚举 */
function parseCapabilityIds() {
  const block = /export const PLATFORM_CAPABILITIES = \[([\s\S]*?)\] as const;/.exec(platformTypes);
  assert.ok(block, '未能从 types.ts 解析出 PLATFORM_CAPABILITIES');
  return [...block[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

/** 从 types.ts 里解析出能力说明清单的键 */
function parseSpecKeys() {
  const block = /export const PLATFORM_CAPABILITY_SPECS[\s\S]*?\n\};/.exec(platformTypes);
  assert.ok(block, '未能从 types.ts 解析出 PLATFORM_CAPABILITY_SPECS');
  return [...block[0].matchAll(/^ {2}'?([a-z-]+)'?:\s*\{/gm)].map((match) => match[1]);
}

/** 取出某个能力的说明条目原文 */
function specEntry(id) {
  const pattern = new RegExp(`^ {2}'?${id}'?:\\s*\\{([\\s\\S]*?)^ {2}\\},`, 'm');
  const match = pattern.exec(platformTypes);
  assert.ok(match, `能力清单里找不到 ${id} 的说明条目`);
  return match[1];
}

const declaredCapabilities = parseCapabilityIds();
const checklistIds = CAPABILITY_CHECKLIST.map((item) => item.id);
const specKeys = parseSpecKeys();

// ---------------------------------------------------------------------------
// 1. 清单本身不能漂移
// ---------------------------------------------------------------------------

test('能力清单覆盖了枚举里的每一项，一个不多一个不少', () => {
  assert.deepEqual(
    [...checklistIds].sort(),
    [...declaredCapabilities].sort(),
    '新增能力时，请在 tests/contract/capability-checklist.test.mjs 的清单里补一行'
  );
});

test('能力枚举与能力说明清单完全对应', () => {
  assert.deepEqual([...specKeys].sort(), [...declaredCapabilities].sort());
});

test('清单里的「是否已实现」与能力说明里的声明一致', () => {
  for (const item of CAPABILITY_CHECKLIST) {
    const entry = specEntry(item.id);
    const declared = /desktopImplemented:\s*(true|false)/.exec(entry);
    assert.ok(declared, `${item.id} 的说明缺少 desktopImplemented`);

    assert.equal(
      declared[1] === 'true',
      item.desktopImplemented,
      `${item.id}：说明里写的是 ${declared[1]}，检查清单里写的是 ${item.desktopImplemented} —— ` +
        '实现和声明必须同步，否则界面会给出错误的可用性'
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Rust / Tauri 配置
// ---------------------------------------------------------------------------

test('已实现的桌面能力必须有对应的 Rust 模块，且编译进项目', () => {
  for (const item of CAPABILITY_CHECKLIST.filter((entry) => entry.desktopImplemented)) {
    assert.ok(
      item.rustModules.length > 0,
      `${item.id} 声明为已实现，但没有列出 Rust 模块`
    );

    for (const module of item.rustModules) {
      assert.ok(exists(module), `${item.id} 缺少 Rust 模块 ${module}`);

      // 光有文件不算数，必须真的被 mod 出来
      const moduleName = path.basename(module, '.rs');
      assert.ok(
        new RegExp(`^mod ${moduleName};`, 'm').test(rustLib),
        `${module} 存在但没有在 lib.rs 里 mod ${moduleName}`
      );
    }
  }
});

test('托盘能力对应的 Tauri 配置已开启', () => {
  const trayItem = CAPABILITY_CHECKLIST.find((item) => item.id === 'tray');
  if (!trayItem?.desktopImplemented) return;

  assert.match(
    cargo,
    /tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"tray-icon"/,
    '托盘需要 tauri 的 tray-icon feature'
  );
});

// ---------------------------------------------------------------------------
// 3. capabilities 权限：只增不减是不够的，这里检查「没有多放开」
// ---------------------------------------------------------------------------

test('新增原生能力没有顺带放开任何 Tauri 权限', () => {
  const capabilityFiles = fs.readdirSync(path.join(ROOT, 'src-tauri', 'capabilities'));

  for (const fileName of capabilityFiles) {
    const capability = JSON.parse(read(`src-tauri/capabilities/${fileName}`));
    assert.deepEqual(
      capability.permissions,
      ['core:default'],
      `${fileName} 的权限被放开了。托盘走的是 Rust 侧核心 API，` +
        '不应该给前端多加权限；确实需要时请在这里显式记一笔并说明理由'
    );
  }
});

test('托盘不在前端开放核心窗口命令，只经由自己的窄命令', () => {
  // 前端若直接用 @tauri-apps/api/window 的 hide()，就需要 core:window:allow-hide；
  // 我们刻意绕开它，走 commands.rs 里的 hide_to_tray
  assert.ok(
    !/from\s+['"]@tauri-apps\/api\/window['"]/.test(tauriPlatform),
    '桌面平台实现不应直接使用 Tauri 的窗口 API：那会需要放开 core:window 权限'
  );
  assert.match(
    tauriPlatform,
    /invoke<void>\('hide_to_tray'\)/,
    '隐藏窗口应走 hide_to_tray 命令'
  );
});

// ---------------------------------------------------------------------------
// 4. Rust 命令：存在、标注、注册
// ---------------------------------------------------------------------------

test('已实现能力的每个命令都存在、都有标注、都已注册', () => {
  for (const item of CAPABILITY_CHECKLIST) {
    for (const command of item.desktopCommands) {
      assert.ok(
        new RegExp(`#\\[tauri::command\\][\\s\\S]{0,200}fn ${command}`).test(rustCommands),
        `commands.rs 里找不到带 #[tauri::command] 的 ${command}`
      );
      assert.ok(
        rustLib.includes(`commands::${command}`),
        `${command} 没有在 lib.rs 的 invoke_handler 里注册`
      );
    }
  }
});

test('声明为「还没实现」的能力不该偷偷实现一半', () => {
  for (const item of CAPABILITY_CHECKLIST.filter((entry) => !entry.desktopImplemented)) {
    assert.deepEqual(
      item.desktopCommands,
      [],
      `${item.id} 还没实现，但清单里给了命令 —— 实现了就请把 desktopImplemented 改成 true`
    );
  }
});

test('托盘可用性是 Rust 运行时判断的，不是写死的', () => {
  assert.match(
    rustCommands,
    /state\.window\.tray_available\(\)/,
    'platform_capabilities 必须读运行期状态：托盘创建失败时不能再报「可用」'
  );
  assert.match(
    read('src-tauri/src/window.rs'),
    /tray_available:\s*AtomicBool::new\(false\)/,
    '托盘可用性必须默认 false —— 反过来会出现「藏了窗口却找不到入口」的窗口期'
  );
});

// ---------------------------------------------------------------------------
// 5. PlatformService 接口与浏览器 fallback
// ---------------------------------------------------------------------------

test('每项能力都进了 PlatformService 的能力枚举', () => {
  for (const item of CAPABILITY_CHECKLIST) {
    assert.ok(
      declaredCapabilities.includes(item.id),
      `${item.id} 不在 PLATFORM_CAPABILITIES 里`
    );
  }
});

test('每项能力都有浏览器 fallback：要么支持，要么明确抛错', () => {
  for (const item of CAPABILITY_CHECKLIST) {
    assert.ok(
      browserPlatform.includes(`'${item.id}'`),
      `${item.id} 在 browser-platform.ts 里完全没有出现 —— ` +
        '浏览器模式必须给出明确答复（抛 UnsupportedCapabilityError 或如实返回事实）'
    );
  }
});

test('浏览器 fallback 一律抛 UnsupportedCapabilityError，不静默返回', () => {
  assert.match(
    browserPlatform,
    /function unsupported\(capability: PlatformCapability\): never/,
    '浏览器实现应有一个统一的「不支持」出口'
  );
  assert.match(browserPlatform, /throw new UnsupportedCapabilityError\(capability\)/);
});

test('能力清单透传到组件层，组件不直接摸服务目录', () => {
  assert.match(platformIndex, /PLATFORM_CAPABILITY_SPECS/);
  assert.match(featuresIndex, /export \{ PLATFORM_CAPABILITIES, PLATFORM_CAPABILITY_SPECS \}/);
  assert.match(dataPanel, /from '@\/features'/);
  assert.ok(
    !/from\s+['"]@\/services/.test(dataPanel),
    'DataPanel 不应直接引用 @/services'
  );
});

test('界面从清单渲染能力列表，不自己维护一份硬编码的标签', () => {
  assert.match(dataPanel, /PLATFORM_CAPABILITIES\.map\(/, '能力列表应由清单驱动');

  // 组件里不该再出现「能力 id -> 中文名」的映射表
  assert.ok(
    !/CAPABILITY_LABELS/.test(dataPanel),
    'DataPanel 不应再维护自己的标签表：说明已经收在 PLATFORM_CAPABILITY_SPECS 里'
  );
});

// ---------------------------------------------------------------------------
// 6. 测试覆盖
// ---------------------------------------------------------------------------

test('每项能力都在测试里出现过', () => {
  const testFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(test\.mjs|test\.ts|check\.mjs)$/.test(entry.name)) {
        testFiles.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(ROOT, 'tests'));
  const corpus = testFiles.join('\n');

  for (const item of CAPABILITY_CHECKLIST) {
    assert.ok(
      corpus.includes(`'${item.id}'`),
      `没有任何测试提到 ${item.id}：新能力必须至少有一条用例说明它在当前环境下的行为`
    );
  }
});
