/**
 * 数据层测试（mock-data.js）
 * ------------------------------------------------------------
 * 只测"业务规则"这类不依赖界面的纯逻辑：
 *   - 会话的增删改查
 *   - 首条消息自动变成标题
 *   - 删除当前会话后自动切换
 *   - 测试连接的校验规则
 *
 * 运行方式：
 *   node --test tests/
 *
 * 为什么能测：mock-data.js 只依赖 localStorage 这一类浏览器 API，
 * 我们在测试里用一个假的 localStorage 顶替它，就能在 Node 环境跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 用假的 localStorage 顶替浏览器的 localStorage
// 必须在 import mock-data 之前准备好
// ---------------------------------------------------------------------------
class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = new FakeStorage();

const { default: API, makeId, pickReply } = await import('../src/mock-data.js');

/** 每个用例开始前清空存储，保证互不干扰 */
function reset() {
  localStorage.clear();
}

// ---------------------------------------------------------------------------
// 会话增删改查
// ---------------------------------------------------------------------------
test('首次读取会返回默认状态，并且带一个欢迎会话', () => {
  reset();
  const state = API.getState();
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].id, 'conv-welcome');
  assert.equal(state.activeConversationId, 'conv-welcome');
});

test('新建会话会插到列表最前面，并自动选中', () => {
  reset();
  const created = API.createConversation();
  const state = API.getState();
  assert.equal(state.conversations.length, 2);
  assert.equal(state.conversations[0].id, created.id);
  assert.equal(state.activeConversationId, created.id);
  assert.equal(state.conversations[0].title, '新会话');
});

test('重命名会话会生效，并且空白标题会退化为「未命名会话」', () => {
  reset();
  const created = API.createConversation();
  API.renameConversation(created.id, '  我的计划  ');
  let state = API.getState();
  assert.equal(state.conversations[0].title, '我的计划');

  API.renameConversation(created.id, '   ');
  state = API.getState();
  assert.equal(state.conversations[0].title, '未命名会话');
});

test('重命名不存在的会话会返回失败', () => {
  reset();
  const result = API.renameConversation('not-exist', '随便');
  assert.equal(result.ok, false);
});

test('删除非当前会话时，当前会话保持不变', () => {
  reset();
  const created = API.createConversation();
  API.deleteConversation('conv-welcome');
  const state = API.getState();
  assert.equal(state.conversations.length, 1);
  assert.equal(state.activeConversationId, created.id);
});

test('删除当前会话后，会自动切到剩下的第一个', () => {
  reset();
  const a = API.createConversation();
  const b = API.createConversation();
  // 此时顺序为 [b, a, welcome]，当前是 b
  API.deleteConversation(b.id);
  const state = API.getState();
  assert.equal(state.activeConversationId, a.id);
});

test('删光所有会话后，activeConversationId 变成 null', () => {
  reset();
  for (const conversation of API.getState().conversations) {
    API.deleteConversation(conversation.id);
  }
  const state = API.getState();
  assert.equal(state.conversations.length, 0);
  assert.equal(state.activeConversationId, null);
});

// ---------------------------------------------------------------------------
// 消息与标题联动
// ---------------------------------------------------------------------------
test('追加消息会写进对应会话', () => {
  reset();
  const created = API.createConversation();
  API.appendMessage(created.id, { role: 'user', content: '你好' });
  API.appendMessage(created.id, { role: 'assistant', content: '你好呀' });
  const state = API.getState();
  assert.equal(state.conversations[0].messages.length, 2);
  assert.equal(state.conversations[0].messages[0].content, '你好');
  // 每条消息都要有 id 和时间
  assert.ok(state.conversations[0].messages[0].id);
  assert.ok(state.conversations[0].messages[0].createdAt);
});

test('第一条用户消息会成为会话标题', () => {
  reset();
  const created = API.createConversation();
  API.appendMessage(created.id, { role: 'user', content: '帮我写一个周报模板' });
  const state = API.getState();
  assert.equal(state.conversations[0].title, '帮我写一个周报模板');
});

test('标题过长会被截断，并带省略号', () => {
  reset();
  const created = API.createConversation();
  API.appendMessage(created.id, {
    role: 'user',
    content: '这是一句特别特别特别长的用户输入用来验证截断逻辑是否生效',
  });
  const title = API.getState().conversations[0].title;
  assert.ok(title.length <= 19, `标题应该被截断，实际长度 ${title.length}`);
  assert.ok(title.endsWith('…'));
});

test('后续消息不会覆盖已经生成的标题', () => {
  reset();
  const created = API.createConversation();
  API.appendMessage(created.id, { role: 'user', content: '第一个问题' });
  API.appendMessage(created.id, { role: 'user', content: '第二个问题' });
  const state = API.getState();
  assert.equal(state.conversations[0].title, '第一个问题');
});

test('流式更新能改到指定消息的内容', () => {
  reset();
  const created = API.createConversation();
  API.appendMessage(created.id, { role: 'assistant', content: '' });
  const messageId = API.getState().conversations[0].messages[0].id;

  API.updateMessageContent(created.id, messageId, '你');
  API.updateMessageContent(created.id, messageId, '你好');
  const state = API.getState();
  assert.equal(state.conversations[0].messages[0].content, '你好');
});

test('给不存在的会话追加消息会返回失败', () => {
  reset();
  const result = API.appendMessage('not-exist', { role: 'user', content: 'hi' });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 配置与人格
// ---------------------------------------------------------------------------
test('保存模型配置会合并写入，不丢掉其他字段', () => {
  reset();
  API.saveConfig({ apiUrl: 'https://api.deepseek.com/v1' });
  const state = API.getState();
  assert.equal(state.config.apiUrl, 'https://api.deepseek.com/v1');
  assert.equal(state.config.modelName, 'gpt-4o-mini'); // 原值保留
});

test('保存人格配置会生效', () => {
  reset();
  API.savePersona({ assistantName: '小美', userName: '老板' });
  const state = API.getState();
  assert.equal(state.persona.assistantName, '小美');
  assert.equal(state.persona.userName, '老板');
  assert.ok(state.persona.systemPrompt.length > 0); // 原有系统提示词保留
});

test('重置会清空全部数据，回到默认状态', () => {
  reset();
  API.createConversation();
  API.saveConfig({ apiKey: 'sk-test' });
  API.resetAll();
  const state = API.getState();
  assert.equal(state.conversations.length, 1);
  assert.equal(state.config.apiKey, '');
});

// ---------------------------------------------------------------------------
// 测试连接的校验规则
// ---------------------------------------------------------------------------
test('测试连接：地址为空会失败', async () => {
  reset();
  const result = await API.testConnection({ apiUrl: '', apiKey: 'sk-x', modelName: 'm' });
  assert.equal(result.ok, false);
  assert.match(result.message, /API 地址/);
});

test('测试连接：地址格式不对会失败', async () => {
  reset();
  const result = await API.testConnection({
    apiUrl: 'api.openai.com/v1',
    apiKey: 'sk-x',
    modelName: 'm',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /http/);
});

test('测试连接：缺 Key 或模型名会失败', async () => {
  reset();
  let result = await API.testConnection({
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    modelName: 'm',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /API Key/);

  result = await API.testConnection({
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    modelName: '',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /模型名称/);
});

test('测试连接：三项都填好会成功，且提示是模拟结果', async () => {
  reset();
  const result = await API.testConnection({
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-x',
    modelName: 'gpt-4o-mini',
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /模拟/);
});

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------
test('makeId 生成的 id 不重复', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(makeId('conv'));
  assert.equal(ids.size, 200);
});

test('pickReply 对同一输入稳定，且非空', () => {
  const first = pickReply('稳定测试');
  const second = pickReply('稳定测试');
  assert.equal(first, second);
  assert.ok(first.length > 0);
});

test('getState 返回的是拷贝，改它不会污染内部数据', () => {
  reset();
  const snapshot = API.getState();
  snapshot.conversations[0].title = '被改坏了';
  const fresh = API.getState();
  assert.notEqual(fresh.conversations[0].title, '被改坏了');
});
