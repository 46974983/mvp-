import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const planPath = new URL('../docs/TECHNICAL_PLAN.md', import.meta.url);
const plan = fs.readFileSync(planPath, 'utf8');

test('技术方案包含核心技术栈与平台演进章节', () => {
  for (const heading of [
    '# 桌面 AI 助手技术方案',
    '## 2. 总体技术选型',
    '## 3. 分层架构',
    '## 6. Tauri 原生能力演进',
    '## 7. 测试与质量门槛',
  ]) {
    assert.match(plan, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('技术方案明确平台抽象与敏感信息约束', () => {
  assert.match(plan, /PlatformService/);
  assert.match(plan, /API Key 不以明文写入/);
  assert.match(plan, /capabilities/);
});
