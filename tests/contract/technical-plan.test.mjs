/**
 * 文档契约测试
 * ----------------------------------------------------------------------------
 * 这组用例不测代码，测文档。
 *
 * 为什么值得存在：
 *   产品设计和技术方案是这份工程的「上游」。如果哪天有人为了改代码方便，
 *   把方案里的约束句删掉、把阶段划分抹平，测试应该立刻红掉 ——
 *   否则「按方案实现」这件事就变成了一句没人能验证的话。
 *
 * 换句话说：这里断言的是「规则本身还在不在」，而不是「代码有没有做到」。
 * 代码有没有做到，由 tests/unit 和 tests/e2e 负责。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readDoc = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

const plan = readDoc('docs/TECHNICAL_PLAN.md');
const design = readDoc('PRODUCT_DESIGN.md');

/** 断言一段文本里包含给定的标题 / 片段 */
function assertContainsAll(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} 缺少必要内容：${fragment}`);
  }
}

// ---------------------------------------------------------------------------
// 技术方案
// ---------------------------------------------------------------------------

test('技术方案保留了核心技术栈与平台演进章节', () => {
  assertContainsAll(
    plan,
    [
      '# 桌面 AI 助手技术方案',
      '## 2. 总体技术选型',
      '## 3. 分层架构',
      '## 6. Tauri 原生能力演进',
      '## 7. 测试与质量门槛',
    ],
    '技术方案'
  );
});

test('技术方案明确了平台抽象与敏感信息约束', () => {
  assert.match(plan, /PlatformService/);
  assert.match(plan, /API Key 不以明文写入/);
  assert.match(plan, /capabilities/);
});

test('技术方案保留四个阶段的划分，且阶段 A 是浏览器可运行 MVP', () => {
  assertContainsAll(
    plan,
    [
      '### 阶段 A：浏览器可运行 MVP',
      '### 阶段 B：Tauri 基础接入',
      '### 阶段 C：桌面体验',
      '### 阶段 D：本地自动化',
    ],
    '技术方案'
  );
  // 阶段 A 的判据：模型层先 mock，不连真实模型
  assert.match(plan, /模型层先使用 mock provider/);
});

test('技术方案保留了 ModelProvider 接口的三个方法', () => {
  for (const method of ['testConnection', 'streamChat', 'abort']) {
    assert.ok(plan.includes(method), `技术方案的 ModelProvider 接口缺少 ${method}`);
  }
});

// ---------------------------------------------------------------------------
// 产品设计
// ---------------------------------------------------------------------------

test('产品设计保留了 MVP 闭环与核心功能章节', () => {
  assertContainsAll(
    design,
    [
      '# 桌面 AI 助手 MVP 产品设计',
      '### 3.1 聊天',
      '### 3.2 模型配置',
      '### 3.3 会话管理',
      '### 3.4 基础人格',
      '## 5. 数据与安全原则',
    ],
    '产品设计'
  );
});

test('产品设计保留了数据与安全原则的四条底线', () => {
  assertContainsAll(
    design,
    [
      '数据默认保存在本地',
      'API Key 不上传到应用自有服务器',
      '删除会话前进行确认',
      '发送请求时明确区分用户消息和系统提示词',
    ],
    '产品设计'
  );
});
