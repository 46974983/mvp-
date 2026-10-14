/**
 * 界面流程验证脚本（临时工具，不属于交付物）
 * 用系统已装的 Chrome 打开 index.html，把设计文档里的核心流程点一遍，
 * 每一步都截图，最后输出一份检查清单。
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// playwright-core 装在 WorkBuddy 的隔离环境里，用绝对路径加载
const require = createRequire(import.meta.url);
const { chromium } = require(
  'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js'
);

const projectDir = 'D:/项目';
const shotDir = path.join(projectDir, 'tests', 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') pageErrors.push('console.error: ' + msg.text());
});

const url = process.env.DEMO_URL || 'http://localhost:5173/';
await page.goto(url);
await page.waitForTimeout(600);

// ---------------------------------------------------------------- 1 初始状态
check('页面加载无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));
check('默认停在聊天页', (await page.locator('#app').getAttribute('data-page')) === 'chat');
check('侧边栏有默认欢迎会话', (await page.locator('.conv-item').count()) === 1);
check('聊天区显示了欢迎消息', (await page.locator('.message.assistant').count()) === 1);
await page.screenshot({ path: path.join(shotDir, '01-chat-initial.png') });

// ---------------------------------------------------------------- 2 发送消息 + 流式
// 先新建一个会话，这样能验证「首条消息自动成为标题」
await page.click('.sidebar [data-action="new-conversation"]');
await page.waitForTimeout(200);
check('新建会话后进入空状态', (await page.locator('.chat-empty').count()) === 1);

await page.fill('#composer-input', '帮我看看这个界面流程对不对');
await page.click('#btn-send');
await page.waitForTimeout(300);
check('发送后用户消息立即出现', (await page.locator('.message.user').count()) === 1);
const stopVisible = await page.locator('#btn-stop').isVisible();
check('流式生成中显示「停止」按钮', stopVisible);
check('流式生成中输入框锁定', await page.locator('#composer-input').isDisabled());
await page.screenshot({ path: path.join(shotDir, '02-streaming.png') });

// 等流式结束
await page.waitForTimeout(5000);
const sendBack = await page.locator('#btn-send').isVisible();
check('流式结束后「发送」按钮恢复', sendBack);
check('流式结束后输入框解锁', !(await page.locator('#composer-input').isDisabled()));
const aiCount = await page.locator('.message.assistant').count();
check('助手回复已生成', aiCount === 1, `assistant 消息数=${aiCount}`);
const hasCodeBlock = await page.locator('.code-block, .inline-code').count();
check('Markdown 代码块渲染生效', hasCodeBlock > 0, `匹配节点=${hasCodeBlock}`);
const titleAfterFirst = await page.locator('.conv-item.active .conv-title').textContent();
check('首条消息自动成为会话标题', titleAfterFirst.includes('帮我看看'), `标题=${titleAfterFirst}`);
await page.screenshot({ path: path.join(shotDir, '03-after-stream.png') });

// ---------------------------------------------------------------- 3 停止生成
await page.fill('#composer-input', '再试一次，这次我要中途停止');
await page.click('#btn-send');
await page.waitForTimeout(400);
await page.click('#btn-stop');
await page.waitForTimeout(300);
const stoppedText = await page.locator('.message.assistant').last().textContent();
check('停止生成后保留已生成内容', stoppedText.trim().length > 0, `长度=${stoppedText.trim().length}`);
check('停止后按钮切回「发送」', await page.locator('#btn-send').isVisible());
await page.screenshot({ path: path.join(shotDir, '04-stopped.png') });

// ---------------------------------------------------------------- 4 新建会话
await page.click('.sidebar [data-action="new-conversation"]');
await page.waitForTimeout(200);
check('新建会话后侧边栏增加一条', (await page.locator('.conv-item').count()) === 3);
check('新会话显示空状态引导', (await page.locator('.chat-empty').count()) === 1);
await page.screenshot({ path: path.join(shotDir, '05-new-conversation.png') });

// ---------------------------------------------------------------- 5 重命名
await page.locator('.conv-item').first().hover();
await page.locator('.conv-item').first().locator('[data-action="rename"]').click();
await page.waitForTimeout(200);
await page.fill('.conv-rename-input', '重命名测试');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const renamed = await page.locator('.conv-item').first().locator('.conv-title').textContent();
check('重命名生效', renamed === '重命名测试', `实际=${renamed}`);
await page.screenshot({ path: path.join(shotDir, '06-renamed.png') });

// ---------------------------------------------------------------- 6 删除会话（含确认）
await page.locator('.conv-item').first().hover();
await page.locator('.conv-item').first().locator('[data-action="delete"]').click();
await page.waitForTimeout(250);
check('删除前弹出确认框', await page.locator('#confirm-dialog').isVisible());
await page.screenshot({ path: path.join(shotDir, '07-confirm-delete.png') });
await page.click('#confirm-cancel');
await page.waitForTimeout(200);
check('取消删除后会话仍在', (await page.locator('.conv-item').count()) === 3);

await page.locator('.conv-item').first().hover();
await page.locator('.conv-item').first().locator('[data-action="delete"]').click();
await page.waitForTimeout(200);
await page.click('#confirm-delete');
await page.waitForTimeout(300);
check('确认删除后会话数减少', (await page.locator('.conv-item').count()) === 2);

// ---------------------------------------------------------------- 7 切到设置页
await page.click('[data-nav="settings"]');
await page.waitForTimeout(300);
check('切到设置页', (await page.locator('#app').getAttribute('data-page')) === 'settings');
check('设置页可见模型配置', await page.locator('#cfg-api-url').isVisible());
await page.screenshot({ path: path.join(shotDir, '08-settings.png'), fullPage: true });

// ---------------------------------------------------------------- 8 测试连接：失败分支
await page.fill('#cfg-api-url', '');
await page.click('#btn-test-connection');
await page.waitForTimeout(1600);
let testText = await page.locator('#test-result').textContent();
check('测试连接：缺地址给出提示', testText.includes('API 地址'), testText.trim());
await page.screenshot({ path: path.join(shotDir, '09-test-fail.png') });

// 地址格式错误
await page.fill('#cfg-api-url', 'api.example.com/v1');
await page.click('#btn-test-connection');
await page.waitForTimeout(1600);
testText = await page.locator('#test-result').textContent();
check('测试连接：地址格式错给出提示', testText.includes('http'), testText.trim());

// ---------------------------------------------------------------- 9 测试连接：成功分支
await page.fill('#cfg-api-url', 'https://api.deepseek.com/v1');
await page.fill('#cfg-api-key', 'sk-demo-not-real');
await page.fill('#cfg-model-name', 'deepseek-chat');
await page.click('#btn-test-connection');
await page.waitForTimeout(1800);
testText = await page.locator('#test-result').textContent();
check('测试连接：填写完整后成功', testText.includes('连接成功'), testText.trim());
await page.screenshot({ path: path.join(shotDir, '10-test-ok.png') });

// ---------------------------------------------------------------- 10 API Key 显隐
await page.click('#btn-toggle-key');
await page.waitForTimeout(150);
check('API Key 显隐切换生效', (await page.locator('#cfg-api-key').getAttribute('type')) === 'text');
await page.click('#btn-toggle-key');

// ---------------------------------------------------------------- 11 保存配置 + 人格
await page.click('#btn-save-config');
await page.waitForTimeout(300);
check('保存配置后提示出现', await page.locator('#toast.show').isVisible());

await page.fill('#cfg-assistant-name', '小助手');
await page.fill('#cfg-user-name', '老大');
await page.fill('#cfg-system-prompt', '你是简洁的助手。');
await page.click('#btn-save-persona');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shotDir, '11-settings-saved.png'), fullPage: true });

// ---------------------------------------------------------------- 12 人格生效（回聊天页看头像）
await page.click('[data-nav="chat"]');
await page.waitForTimeout(300);
const assistantAvatar = await page.locator('.message.assistant .avatar').first().textContent();
check('人格配置影响头像显示', assistantAvatar.trim() === '小', `头像=${assistantAvatar.trim()}`);

// ---------------------------------------------------------------- 13 数据持久化（刷新后仍在）
await page.reload();
await page.waitForTimeout(600);
check('刷新后配置仍然保存', (await page.locator('#cfg-api-url').inputValue()) === 'https://api.deepseek.com/v1');
const convCountAfterReload = await page.locator('.conv-item').count();
check('刷新后会话仍然存在', convCountAfterReload >= 1, `会话数=${convCountAfterReload}`);
await page.screenshot({ path: path.join(shotDir, '12-after-reload.png') });

// ---------------------------------------------------------------- 14 深色主题
await page.click('#btn-theme');
await page.waitForTimeout(300);
const theme = await page.locator('html').getAttribute('data-theme');
check('主题切换到深色', theme === 'dark', `theme=${theme}`);
await page.screenshot({ path: path.join(shotDir, '13-dark-chat.png') });
await page.click('[data-nav="settings"]');
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(shotDir, '14-dark-settings.png'), fullPage: true });

// ---------------------------------------------------------------- 15 重置数据
await page.click('#btn-reset-data');
await page.waitForTimeout(250);
check('重置前弹出确认框', await page.locator('#reset-dialog').isVisible());
await page.click('#reset-delete');
await page.waitForTimeout(400);
check('重置后回到默认一条会话', (await page.locator('.conv-item').count()) === 1);

// ---------------------------------------------------------------- 收尾
check('全程无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

const passed = results.filter((r) => r.passed).length;
console.log(`\n===== ${passed}/${results.length} 通过 =====`);
if (passed !== results.length) {
  console.log('\n未通过项：');
  for (const r of results.filter((x) => !x.passed)) console.log(' -', r.name, r.detail);
  process.exitCode = 1;
}
