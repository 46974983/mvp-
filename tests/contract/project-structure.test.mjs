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
