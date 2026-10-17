/**
 * 桌面外壳契约
 * ----------------------------------------------------------------------------
 * 阶段 B 新增的东西在 src-tauri/ 下。这个文件把「外壳长什么样」钉住：
 * 界面从哪个地址加载、WebView 允不允许出网、构建产物叫什么、
 * 以及前端每个适配器背后是不是真有一条对应的命令。
 *
 * 最后一类断言最有用：它防的是「前端写好了调用，Rust 侧却忘了注册」——
 * 那种错在浏览器测试里永远发现不了，只有真的打开桌面应用才会暴露。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const config = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');

test('src-tauri 的关键文件齐备', () => {
  const required = [
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/build.rs',
    'src-tauri/tauri.conf.json',
    'src-tauri/capabilities/default.json',
    'src-tauri/migrations/0001_init.sql',
    'src-tauri/icons/icon.ico',
    'src-tauri/src/main.rs',
    'src-tauri/src/lib.rs',
    'src-tauri/src/commands.rs',
    'src-tauri/src/db.rs',
    'src-tauri/src/models.rs',
    'src-tauri/src/secrets.rs',
    'src-tauri/src/chat.rs',
    'src-tauri/src/error.rs',
    'src-tauri/src/redact.rs',
    // 阶段 C：托盘与窗口
    'src-tauri/src/tray.rs',
    'src-tauri/src/window.rs',
  ];

  const missing = required.filter((file) => !exists(file));
  assert.deepEqual(missing, [], `缺少文件：${missing.join(', ')}`);
});

test('构建产物与开发地址指向本仓库的前端', () => {
  assert.equal(config.build.frontendDist, '../dist');
  assert.equal(config.build.devUrl, 'http://localhost:5173');
  assert.match(config.build.beforeDevCommand, /npm run dev/);
  assert.match(config.build.beforeBuildCommand, /npm run build/);
});

test('窗口标签是 main —— capabilities 按这个标签生效', () => {
  assert.equal(config.app.windows.length, 1);
  assert.equal(config.app.windows[0].label, 'main');
});

test('标识符不是模板默认值', () => {
  assert.notEqual(config.identifier, 'com.tauri.dev');
  assert.match(config.identifier, /^[a-z0-9.-]+$/i);
});

test('WebView 的 CSP 不允许内联脚本，也不允许出网', () => {
  const csp = config.app.security.csp;
  assert.ok(csp, 'csp 不能是 null');

  const directives = csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

  const find = (name) => directives.find((part) => part.startsWith(`${name} `));

  assert.equal(
    find('script-src'),
    "script-src 'self'",
    "script-src 必须严格是 'self'：内联脚本会削弱整个应用"
  );

  const connectSrc = find('connect-src') ?? '';
  assert.ok(connectSrc.includes('ipc:'), '必须保留 Tauri 的 IPC 通道');
  assert.ok(!connectSrc.includes('https:'), 'WebView 不应有对外网络出口');
  assert.ok(!connectSrc.includes('*'), 'connect-src 不允许通配');
});

test('开发模式另有 CSP，好让 Vite 的热更新能连上', () => {
  const devCsp = config.app.security.devCsp;
  assert.ok(devCsp, '需要 devCsp，否则 tauri dev 时热更新会被 CSP 拦掉');
  assert.ok(devCsp.includes('ws://localhost:5173'), 'devCsp 要放行 Vite 的 HMR 连接');
});

test('build.rs 调用 tauri-build', () => {
  assert.match(read('src-tauri/build.rs'), /tauri_build::build\(\)/);
});

test('Cargo.toml 的库配置符合 Tauri 要求', () => {
  assert.match(cargo, /crate-type\s*=\s*\[[^\]]*"cdylib"/, 'Tauri 需要 cdylib');
  assert.match(cargo, /edition\s*=\s*"2024"/);
  assert.match(cargo, /rusqlite[^\n]*bundled/, 'SQLite 应随二进制一起编，用户机器不需要另装');
});

test('前端的每个 Tauri 适配器都有对应的命令', () => {
  const commands = read('src-tauri/src/commands.rs');
  const adapters = [
    read('src/services/storage/tauri-storage.ts'),
    read('src/services/model/tauri-provider.ts'),
    read('src/services/platform/tauri-platform.ts'),
  ].join('\n');

  const invoked = new Set(
    [...adapters.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z_0-9]+)'/g)].map((match) => match[1])
  );

  assert.ok(invoked.size >= 15, `前端调用的命令太少，只有 ${invoked.size} 个`);

  for (const name of invoked) {
    assert.ok(
      commands.includes(`fn ${name}`),
      `前端调用了 ${name}，但 commands.rs 里没有这个命令`
    );
  }
});

test('窗口关闭事件由 Rust 接管，且能区分「真退出」', () => {
  const lib = read('src-tauri/src/lib.rs');

  assert.match(
    lib,
    /get_webview_window\(MAIN_WINDOW_LABEL\)[\s\S]*?window\.on_window_event\(move \|event\| handle_window_event\(&listener_window, event\)\)/,
    '必须在配置创建的主窗口实例上直接注册关闭监听'
  );
  assert.match(lib, /CloseRequested/, '应处理窗口关闭请求');
  assert.match(lib, /prevent_close\(\)/, '需要拦下关闭才能改成隐藏');
  assert.match(lib, /is_quitting\(\)/, '必须区分「用户点了退出」和「用户点了关闭」');
});

test('托盘菜单同时提供「显示」与「退出」', () => {
  const tray = read('src-tauri/src/tray.rs');

  // 少了任何一个，用户都会被困在一个看不见的进程里
  assert.match(tray, /"显示主窗口"/, '托盘菜单必须有「显示主窗口」');
  assert.match(tray, /"退出"/, '托盘菜单必须有「退出」');
});

test('package.json 暴露了桌面开发与构建入口', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['dev:desktop'], '缺少 tauri dev 入口');
  assert.ok(pkg.scripts['build:desktop'], '缺少 tauri build 入口');
  assert.match(pkg.scripts['test:rust'], /cargo test/);
});
