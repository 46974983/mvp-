/**
 * 工程结构契约
 * ----------------------------------------------------------------------------
 * 技术方案第 4 节把目录结构写死了。目录不是审美问题 —— 它是「东西该放哪」的答案。
 * 没有这组断言，半年后 components 里会开始出现 request.js，features 里会开始出现 UI 组件，
 * 然后「分层架构」就只剩文档里那三个字了。
 *
 * 所以这里强制：文件在方案说的位置上，接口有方案说的那些方法。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('技术方案第 4 节要求的目录全部存在', () => {
  const required = [
    'src/components/ui',
    'src/components/layout',
    'src/components/chat',
    'src/components/settings',
    'src/components/feedback',
    'src/features/conversations',
    'src/features/chat',
    'src/features/settings',
    'src/services/platform',
    'src/services/model',
    'src/services/storage',
  ];

  const missing = required.filter((dir) => !exists(dir));
  assert.deepEqual(missing, [], `缺少目录：${missing.join(', ')}`);
});

test('关键工程文件齐备', () => {
  const required = [
    'index.html',
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'PRODUCT_DESIGN.md',
    'docs/TECHNICAL_PLAN.md',
    'src/main.tsx',
    'src/App.tsx',
    'src/index.css',
    'src/types/domain.ts',
    'src/lib/markdown.ts',
    'src/lib/redact.ts',
    'src/services/container.ts',
    'tests/contract/technical-plan.test.mjs',
    'tests/e2e/ui-flow.check.mjs',
  ];

  const missing = required.filter((file) => !exists(file));
  assert.deepEqual(missing, [], `缺少文件：${missing.join(', ')}`);
});

test('PlatformService 声明了技术方案第 3 节的四个方法', () => {
  const source = read('src/services/platform/types.ts');
  for (const method of ['readFile', 'takeScreenshot', 'showNotification', 'setAutostart']) {
    assert.match(source, new RegExp(`${method}\\s*\\(`), `PlatformService 缺少 ${method}`);
  }
  assert.match(source, /capabilities/, 'PlatformService 必须暴露 capabilities');
});

test('ModelProvider 声明了技术方案第 5 节的三个方法', () => {
  const source = read('src/services/model/types.ts');
  for (const method of ['testConnection', 'streamChat', 'abort']) {
    assert.match(source, new RegExp(`${method}[\\s(<]`), `ModelProvider 缺少 ${method}`);
  }
});

test('ChatRequest 把系统提示词与用户消息分成两个字段', () => {
  const source = read('src/types/domain.ts');
  const block = /interface ChatRequest\s*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, '未找到 ChatRequest 定义');
  assert.match(block[1], /systemPrompt/, 'ChatRequest 必须有独立的 systemPrompt 字段');
  assert.match(block[1], /messages/, 'ChatRequest 必须有 messages 字段');
});

test('仓储接口的方法与 SQLite 三张表对得上', () => {
  const source = read('src/services/storage/types.ts');
  for (const method of [
    'listConversations',
    'createConversation',
    'renameConversation',
    'deleteConversation',
    'listMessages',
    'appendMessage',
    'updateMessage',
    'getSettings',
    'saveSettings',
  ]) {
    assert.match(source, new RegExp(`${method}\\s*\\(`), `存储层缺少 ${method}`);
  }
});

test('package.json 暴露了方案第 7 节要求的三类测试入口', () => {
  const pkg = JSON.parse(read('package.json'));
  const scripts = pkg.scripts ?? {};
  assert.ok(scripts['test:contract'], '缺少 node --test 契约测试入口');
  assert.ok(scripts['test:unit'], '缺少 Vitest 单元测试入口');
  assert.ok(scripts['test:e2e'], '缺少端到端测试入口');
  assert.match(scripts['test:unit'], /vitest/);
  assert.match(scripts['test:contract'], /node --test/);
});

test('lint 覆盖了 TypeScript 与 Rust 格式', () => {
  const pkg = JSON.parse(read('package.json'));
  const scripts = pkg.scripts ?? {};

  assert.match(scripts.lint ?? '', /typecheck/, 'lint 应包含 TypeScript 检查');
  assert.match(scripts.lint ?? '', /lint:rust/, 'lint 应包含 Rust 格式检查');
  assert.match(
    scripts['lint:rust'] ?? '',
    /cargo fmt[\s\S]*--check/,
    'Rust 格式检查必须用 --check（只校验，不顺手改文件）'
  );
  assert.match(
    scripts['test:all'] ?? '',
    /lint/,
    'test:all 应把 lint 串进去，否则格式问题不会被发现'
  );
});

test('前端做了代码分割，且设置页是按需加载的', () => {
  const viteConfig = read('vite.config.ts');

  // Vite 8 用 rolldown，这里是它的拆包字段
  assert.match(
    viteConfig,
    /rolldownOptions[\s\S]*codeSplitting[\s\S]*groups/,
    '需要配置拆包分组：不拆的话所有依赖会挤进一个 chunk，超过 500 KB 只会报个看不出所以然的警告'
  );
  assert.match(viteConfig, /vendor-react/, 'react 应单独成组');

  // 设置页带着表单库，不该拖累首屏
  const app = read('src/App.tsx');
  assert.match(app, /lazy\(/, '设置页应按需加载');
  assert.match(app, /Suspense/, '按需加载需要 Suspense 兜底，否则加载期间是白屏');
  assert.ok(
    !/^import \{ SettingsPanel \}/m.test(app),
    'SettingsPanel 不该被静态引入，否则按需加载就白做了'
  );
});

test('环境体检脚本覆盖了两类「环境限制 vs 项目问题」的分辨场景', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts.doctor, '缺少 doctor 入口');
  assert.match(
    pkg.scripts['test:all'],
    /^npm run doctor/,
    'doctor 应排在 test:all 最前面：环境有问题时，第一个报错就要说清是哪一侧的问题'
  );

  const doctor = read('scripts/doctor.mjs');

  // 1) 原生模块：出错信息要能把「文件坏了」和「环境读不了二进制」分开
  assert.match(doctor, /'MZ'/, '原生模块检查应校验 PE 文件头，区分文件损坏与环境读取失败');
  assert.match(
    doctor,
    /valid UTF-8/,
    '应显式提到 UTF-8 那个报错，并说明它是环境把二进制当文本读的典型症状'
  );

  // 2) 子进程：node --test 与 Vitest 都依赖它
  assert.match(doctor, /spawnSync/, '应实际探测能否创建子进程');
  assert.match(doctor, /EPERM|禁止创建子进程/, '应说明 EPERM 属于执行环境限制');

  // 3) 失败要影响退出码，否则拦不住流水线
  assert.match(doctor, /process\.exitCode/, '失败必须反映到退出码');
});
