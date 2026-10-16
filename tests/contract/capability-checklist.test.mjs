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
    // 托盘走的是 Tauri 核心的 tray-icon feature，不是插件
    rustPlugins: [],
  },
  {
    id: 'notification',
    desktopImplemented: true,
    desktopCommands: ['platform_capabilities', 'notify'],
    rustModules: ['src-tauri/src/notify.rs'],
    // 阶段 C 引入的第一个插件。忘了注册 .plugin(...) 的话，能力会静默失效。
    rustPlugins: ['tauri_plugin_notification::init('],
  },
  {
    id: 'autostart',
    desktopImplemented: true,
    desktopCommands: ['platform_capabilities', 'autostart_status', 'set_autostart'],
    rustModules: ['src-tauri/src/autostart.rs'],
    rustPlugins: ['tauri_plugin_autostart::init('],
  },
  {
    id: 'global-shortcut',
    desktopImplemented: true,
    desktopCommands: ['platform_capabilities', 'global_shortcut_status', 'set_global_shortcut'],
    rustModules: ['src-tauri/src/shortcut.rs'],
    rustPlugins: ['tauri_plugin_global_shortcut::Builder::new()'],
  },
  {
    id: 'file-read',
    desktopImplemented: true,
    desktopCommands: [
      'platform_capabilities',
      'file_access_status',
      'pick_directory',
      'authorize_directory',
      'revoke_directory',
      'list_authorized_directory',
      'read_authorized_file',
      'recent_file_reads',
    ],
    rustModules: ['src-tauri/src/file_access.rs'],
    // 只为「选择文件夹」这一个动作用，前端拿到的是 pick_directory
    rustPlugins: ['tauri_plugin_dialog::init('],
  },
  {
    id: 'screenshot',
    desktopImplemented: true,
    desktopCommands: ['platform_capabilities', 'set_screenshot_enabled', 'take_screenshot'],
    // permissions.rs 是高风险能力的统一门禁，截屏是第一个用它的人
    rustModules: ['src-tauri/src/permissions.rs', 'src-tauri/src/screenshot.rs'],
    rustPlugins: [],
  },
  {
    id: 'input-simulation',
    desktopImplemented: true,
    // 注意这里**没有**「按某个键」「滚一下」这种命令：协议只有四种动作，
    // 想加新动作必须同时改协议、校验、上限、预览文案和测试
    desktopCommands: [
      'platform_capabilities',
      'set_input_simulation_enabled',
      'run_automation',
      'stop_automation',
      'automation_last_run',
    ],
    rustModules: ['src-tauri/src/automation.rs'],
    rustPlugins: [],
  },
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

test('需要插件的桌面能力，插件已注册且依赖已声明', () => {
  for (const item of CAPABILITY_CHECKLIST) {
    for (const plugin of item.rustPlugins ?? []) {
      // 只匹配到左括号为止：有的插件要传初始化参数，写死 ent() 会漏掉它们
      assert.ok(
        rustLib.includes(`.plugin(${plugin}`),
        `${item.id}：${plugin} 没有在 lib.rs 里注册`
      );

      const crateName = plugin.split('::')[0].replace(/_/g, '-');
      assert.match(
        cargo,
        new RegExp(`^${crateName}\\s*=`, 'm'),
        `${item.id}：Cargo.toml 里缺少 ${crateName} 依赖`
      );
    }
  }
});

test('插件不在前端开放，仍然只走自己的窄命令', () => {
  // 阶段 C 引入了插件，但前端能碰到的还是 commands.rs 里那几条。
  // 前端若直接 import 插件的 JS API，就必须在 capabilities 里放开对应权限。
  const packageJson = JSON.parse(read('package.json'));
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  const pluginJsPackages = dependencies.filter((name) => name.startsWith('@tauri-apps/plugin-'));

  assert.deepEqual(
    pluginJsPackages,
    [],
    '前端不应依赖任何 Tauri 插件的 JS 包：能力一律经 Rust 窄命令暴露，' +
      '否则 capabilities 里就得放开插件权限'
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

test('桌面能力探测包含所有已实现能力', () => {
  const probe = /pub async fn platform_capabilities\([\s\S]*?\n\}/.exec(rustCommands);
  assert.ok(probe, '未能找到 platform_capabilities');

  for (const item of CAPABILITY_CHECKLIST.filter((entry) => entry.desktopImplemented)) {
    assert.ok(
      probe[0].includes(`"${item.id}".to_string()`),
      `桌面能力已实现但探测结果未包含 ${item.id}，前端会把对应设置误显示为不支持`
    );
  }
});

test('重置本地数据要顺手撤销系统层面的副作用', () => {
  const resetBlock = /pub async fn reset_all_data[\s\S]*?\n\}/.exec(rustCommands);
  assert.ok(resetBlock, '未能找到 reset_all_data');

  // 快捷键和关闭行为都存了「界面看不出来、但实际生效」的系统状态。
  // 只清数据库不撤这些，用户会看到「设置里明明是空的，可那个键还在起作用」。
  assert.match(
    resetBlock[0],
    /shortcut::apply\(/,
    '重置时必须把已注册的全局快捷键撤销掉'
  );
  assert.match(
    resetBlock[0],
    /set_close_to_tray\(/,
    '重置时必须把关闭行为的内存缓存恢复成默认值'
  );
  assert.match(
    resetBlock[0],
    /read_audit\.clear\(\)/,
    '重置后必须清除进程内的文件读取记录'
  );
});

test('文件和截屏能力的文案如实说明目前只在设置页预览', () => {
  const fileSettings = read('src/components/settings/FileAccessSettings.tsx');
  const screenshotSettings = read('src/components/settings/ScreenshotSettings.tsx');
  const platform = read('src/services/platform/types.ts');

  assert.match(fileSettings, /设置页浏览、预览/);
  assert.match(fileSettings, /不会自动附加到聊天请求/);
  assert.match(screenshotSettings, /设置页手动抓取主屏并预览/);
  assert.match(screenshotSettings, /不会附加到聊天或发给模型/);
  assert.match(platform, /目前不会自动附加到聊天请求/);
  assert.match(platform, /目前不会发给模型/);
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

// ---------------------------------------------------------------------------
// 高风险能力的通用门禁（阶段 D）
//
// 截屏是第一个走这套模式的能力，键鼠模拟会照着抄。所以这几条断言写的是
// **模式**，不是截屏本身 —— 它们要能在下一项能力加进来时继续生效。
// ---------------------------------------------------------------------------

test('高风险能力默认关闭', () => {
  const permissions = read('src-tauri/src/permissions.rs');

  assert.match(
    permissions,
    /DEFAULT_HIGH_RISK_ENABLED: bool = false/,
    '高风险能力的默认值必须是关闭 —— 技术方案第 6 节要求「默认关闭高风险自动化能力」'
  );

  // 前端也要默认关，不能一边默认关一边默认开
  const storage = read('src/services/storage/browser-storage.ts');
  assert.match(
    storage,
    /DEFAULT_SCREENSHOT_ENABLED = false/,
    '前端的截屏默认值必须是 false，且与 Rust 侧保持一致'
  );
});

test('门开在 Rust 侧，不只靠前端禁用按钮', () => {
  // 这条是整件事里最容易做错的地方：前端把按钮禁掉只是体验，
  // 命令是可以被直接 invoke 的。判断必须在 Rust。
  const take = /pub async fn take_screenshot\([\s\S]*?\n\}/.exec(rustCommands);
  assert.ok(take, '找不到 take_screenshot 命令');
  assert.match(
    take[0],
    /ensure_enabled\(/,
    '截屏命令必须先过门禁，不能只靠前端把按钮禁掉'
  );

  // 开关读自设置表，而不是前端传进来的参数 —— 前端传什么都不能当权限
  assert.match(
    take[0],
    /permission\s*\n?\s*\.screenshot|permission\.screenshot/,
    '门禁要读我们自己库里的开关，不能拿前端传的参数当许可'
  );
});

test('截图不落盘', () => {
  const shot = read('src-tauri/src/screenshot.rs');

  // 用户的要求是「不落盘，只返回临时引用」。落盘会带来两个问题：
  // 一是截图里可能有用户自己都没意识到的东西，二是临时文件的清理要额外管。
  for (const writeCall of ['File::create', 'fs::write', 'OpenOptions', 'create_dir_all', 'tempfile']) {
    assert.ok(
      !shot.includes(writeCall),
      `截屏模块不应出现写文件操作（${writeCall}）—— 截图只在内存里传递`
    );
  }

  // 返回的是 data URL，前端可以直接放进 <img src>
  assert.match(shot, /data:image\/png;base64,/, '应当返回 data URL 而不是文件路径');
});

// ---------------------------------------------------------------------------
// 自动化协议（阶段 D 最后一项）
//
// 这一项和前面几项的性质不同：前面几项是「读」，最坏是「看到了不该看的」；
// 这一项是「写」，能代替用户去操作别的程序。所以断言写的是**协议本身的上限**，
// 而不是某个功能的实现细节。
// ---------------------------------------------------------------------------

test('动作协议只有四种动作，且没有能表达「重复」的东西', () => {
  const rust = read('src-tauri/src/automation.rs');
  const block = /pub enum AutomationAction \{([\s\S]*?)\n\}/.exec(rust);
  assert.ok(block, '未能找到 AutomationAction');

  // 枚举的变体就是协议的全部。多一个变体就是多一类能被编排出去的操作
  const variants = [...block[1].matchAll(/^\s{4}([A-Z]\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(
    variants.sort(),
    ['Click', 'Move', 'Type', 'Wait'],
    `协议变更了：${variants.join(', ')}。加动作要同时改校验、上限、预览文案和测试，`
      + '并且必须重新想一遍「它能不能被用来表达循环」'
  );

  // 循环不能在协议里被表达出来 —— 这比「运行时检测到死循环再拦住」可靠得多
  for (const forbidden of ['Loop', 'Repeat', 'While', 'For', 'Jump', 'Goto']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(block[1]),
      `协议里不该出现 ${forbidden}：表达不出重复，就不可能写出无限循环`
    );
  }
});

test('协议的各项上限在文档、Rust 和前端三处一致', () => {
  const doc = read('docs/AUTOMATION_PROTOCOL.md');
  assert.ok(doc.includes('20'), '协议文档要写明动作数上限');

  const rust = read('src-tauri/src/automation.rs');
  assert.match(rust, /MAX_ACTIONS: usize = 20/);
  assert.match(rust, /MAX_WAIT_MS: u64 = 10_000/);
  assert.match(rust, /MAX_TOTAL_MS: u64 = 60_000/);
  assert.match(rust, /MAX_TEXT_CHARS: usize = 2000/);

  // 前端也做一遍同样的检查，为的是让用户在点「执行」之前就看到问题。
  // 两边写歪了的话，前端会拦下一个本来能执行的任务，或者放过去一个必定失败的
  const component = read('src/components/settings/AutomationSettings.tsx');
  assert.match(component, /const MAX_ACTIONS = 20;/);
  assert.match(component, /const MAX_TEXT_CHARS = 2000;/);
});

test('门禁在 Rust 侧，而且校验发生在动手之前', () => {
  const run = /pub async fn run_automation\([\s\S]*?\n\}/.exec(rustCommands);
  assert.ok(run, '找不到 run_automation');

  assert.match(run[0], /ensure_enabled\(/, '执行命令必须先过门禁');
  assert.match(
    run[0],
    /permission\s*\n?\s*\.input_simulation|permission\.input_simulation/,
    '门禁要读我们库里的开关，不能拿前端传的参数当许可'
  );

  // 顺序：校验失败时鼠标一次都不该被移动过
  const validateAt = run[0].indexOf('validate(');
  const runAt = run[0].indexOf('automation::run(');
  assert.ok(validateAt >= 0, '执行前必须校验');
  assert.ok(runAt > validateAt, '校验必须发生在真正动手之前');
});

test('输入动作之前必须有一个点击动作', () => {
  // 这是整个协议里最要紧的一条规则：文字走键盘事件，会打到当前有焦点的窗口上。
  // 允许凭空输入的话，焦点在哪个窗口取决于用户在确认和执行之间有没有切窗口 ——
  // 而这件事在预览里看不见。
  const rust = read('src-tauri/src/automation.rs');
  assert.match(rust, /let mut clicked = false;/, '要记录「前面出现过点击」');
  assert.match(
    rust,
    /if !clicked \{[\s\S]{0,400}?焦点/,
    '违反时要说清为什么 —— 光说「格式错误」用户不知道该怎么办'
  );

  // 前端也要提前拦一道，否则用户填完了才被 Rust 拒绝
  const component = read('src/components/settings/AutomationSettings.tsx');
  assert.match(component, /if \(!clicked\) return/, '前端也要做同样的检查');
});

test('自动化日志里不记用户输入的文字内容', () => {
  // 日志会落到磁盘上长期留着，而用户输入的文字可能包含任何东西 ——
  // 界面上看一眼和执行之后在文件里留一份，是两件事
  const rust = read('src-tauri/src/automation.rs');
  assert.match(rust, /fn log_summary/, '应当有一个专门给日志用的描述');
  assert.match(
    rust,
    /内容不记入日志/,
    '日志那一行必须明确写出「不记内容」，否则以后有人会顺手把 describe() 接到日志上'
  );
});

test('前端拿不到任何系统 API，只有窄命令', () => {
  // 想加「按某个键」「滚一下」这类能力，必须改协议、加上限、加预览 —— 这是故意的摩擦
  const platform = read('src/services/platform/types.ts');
  const service = /export interface PlatformService \{([\s\S]*?)\n\}/.exec(platform);
  assert.ok(service, '未能找到 PlatformService');

  // 自动化相关的入口就这么几个
  for (const method of ['runAutomation', 'stopAutomation', 'automationLastRun']) {
    assert.ok(service[1].includes(method), `PlatformService 应当有 ${method}`);
  }

  // 不允许出现「直接按某个键」「直接滚动」这种绕过动作协议的入口
  for (const forbidden of ['pressKey', 'sendKeys', 'scroll', 'keyPress', 'dragMouse']) {
    assert.ok(
      !service[1].includes(forbidden),
      `PlatformService 里不该出现 ${forbidden}：它绕过了动作协议`
    );
  }
});
