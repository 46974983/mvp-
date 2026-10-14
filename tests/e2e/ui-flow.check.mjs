/**
 * 端到端流程验证（Playwright + 本机 Chrome）
 * ----------------------------------------------------------------------------
 * 这个脚本做的事：把应用真的构建出来、真的跑起来、用真浏览器把产品设计第 2 节
 * 描述的 MVP 闭环点一遍，每一步截图，最后给一份检查清单。
 *
 * 为什么不用 Vitest 的浏览器模式：
 *   这里要验证的是「打开应用 → 配置 → 聊天 → 关掉 → 再打开 → 历史还在」这条
 *   端到端链路，包括 localStorage 真的写进去了、刷新后真的读回来了。
 *   这些事只有在真实浏览器 + 真实构建产物上才有意义。
 *
 * 用法：
 *   npm run test:e2e        （会先构建再跑）
 * 或单跑：
 *   node tests/e2e/ui-flow.check.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROJECT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const SHOT_DIR = path.join(PROJECT_DIR, 'tests', 'screenshots');

// ---------------------------------------------------------------------------
// 准备：找 playwright-core、找 Chrome、起一个静态服务器
// ---------------------------------------------------------------------------

function loadChromium() {
  const candidates = [
    path.join(PROJECT_DIR, 'node_modules', 'playwright-core', 'index.js'),
    'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate).chromium;
    } catch {
      /* 换下一个候选路径 */
    }
  }
  throw new Error(
    '找不到 playwright-core。请先在项目目录执行 npm install，或确认本机已安装 Chrome。'
  );
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined; // 交给 playwright 自己找
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(DIST_DIR, relative);

    if (!filePath.startsWith(DIST_DIR) || !fs.existsSync(filePath)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('404 Not Found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(fs.readFileSync(filePath));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error('\n没有找到 dist/index.html —— 请先执行 npm run build\n');
  process.exit(1);
}

fs.mkdirSync(SHOT_DIR, { recursive: true });

const chromium = loadChromium();
const { server, port } = await startStaticServer();
const baseUrl = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`);
});

const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
const testId = (id) => `[data-testid="${id}"]`;
const assistantMessages = () => page.locator(`${testId('message')}[data-role="assistant"]`);

try {
  // =========================================================== 1 初始状态
  await page.goto(baseUrl);
  await page.waitForSelector(testId('sidebar'));

  check('页面加载没有 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));
  check('默认停在聊天页', (await page.getAttribute('[data-page]', 'data-page')) === 'chat');
  check('首次打开没有历史会话', (await page.locator(testId('conversation-item')).count()) === 0);
  check('侧边栏给出空状态提示', await page.getByText('还没有会话').first().isVisible());
  check('主区给出「还没有选中会话」引导', await page.getByText('还没有选中会话').isVisible());
  await shot('01-初始状态');

  // =========================================================== 2 新建会话 + 发送 + 流式
  await page.click(testId('new-conversation'));
  await page.waitForSelector(testId('conversation-item'));

  check(
    '新建会话后侧边栏出现一条会话',
    (await page.locator(testId('conversation-item')).count()) === 1
  );
  check(
    '新会话被标为当前会话',
    (await page.getAttribute(testId('conversation-item'), 'data-active')) === 'true'
  );
  check('消息区给出首条消息引导', await page.getByText(/这是「新会话」的第一条消息/).isVisible());

  const firstQuestion = '帮我看看这个界面流程对不对';
  await page.fill(testId('composer-input'), firstQuestion);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${testId('message')}[data-role="user"]`);

  check(
    '回车即可发送，用户消息立即出现',
    (await page.locator(`${testId('message')}[data-role="user"]`).count()) === 1
  );
  check('生成过程中出现「停止」按钮', await page.locator(testId('stop-button')).isVisible());
  check('生成过程中输入框被锁定', await page.locator(testId('composer-input')).isDisabled());

  // 占位消息是在几次 await 之后才落库的，所以这里等一下再断言，别抢跑
  const cursorAppeared = await page
    .waitForSelector(testId('streaming-cursor'), { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check('生成过程中显示流式光标', cursorAppeared);
  await shot('02-流式生成中');

  await page.waitForSelector(testId('send-button'), { state: 'visible', timeout: 30_000 });
  check('流式结束后「发送」按钮恢复', await page.locator(testId('send-button')).isVisible());
  check('流式结束后输入框解锁', !(await page.locator(testId('composer-input')).isDisabled()));
  check('助手回复已生成', (await assistantMessages().count()) === 1);
  check(
    '回复状态标记为 complete',
    (await assistantMessages().first().getAttribute('data-status')) === 'complete'
  );
  check('回复提供了复制按钮', await assistantMessages().first().locator(testId('copy-message')).isVisible());
  check(
    'Markdown 被渲染成真实标签而不是原始符号',
    (await assistantMessages().first().locator('.markdown strong, .markdown ul, .markdown li').count()) > 0
  );
  const sidebarItemText = (await page.locator(testId('conversation-item')).first().innerText())
    .replace(/\n/g, ' | ');
  check(
    '首条消息成为会话标题',
    sidebarItemText.includes(firstQuestion),
    sidebarItemText
  );
  await shot('03-流式完成');

  // =========================================================== 3 停止生成
  await page.fill(testId('composer-input'), '再说一段长一点的，我要试试中途停止');
  await page.click(testId('send-button'));
  await page.waitForSelector(testId('stop-button'), { state: 'visible' });
  await page.waitForTimeout(900); // 卡在吐字的中途
  await page.click(testId('stop-button'));
  await page.waitForSelector(testId('send-button'), { state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(400);

  const aborted = assistantMessages().last();
  check('停止后消息状态标记为 aborted', (await aborted.getAttribute('data-status')) === 'aborted');
  const abortedText = (await aborted.locator('.markdown').innerText()).trim();
  check('停止后保留已生成的内容', abortedText.length > 0, `保留 ${abortedText.length} 字`);
  check('停止后显示「已停止生成」', await page.getByText('已停止生成').first().isVisible());
  await shot('04-已停止生成');

  // =========================================================== 4 重命名
  const firstItem = page.locator(testId('conversation-item')).first();
  await firstItem.hover();
  await firstItem.locator(testId('rename-conversation')).click();
  await page.waitForSelector(testId('rename-input'));
  await page.fill(testId('rename-input'), '重命名后的会话');
  await page.click(testId('rename-confirm'));
  await page.waitForTimeout(300);

  check(
    '重命名后侧边栏标题更新',
    (await page.locator(`${testId('conversation-item')} >> text=重命名后的会话`).count()) === 1
  );
  await shot('05-重命名完成');

  // =========================================================== 5 设置页：模型配置
  await page.click(testId('nav-settings'));
  await page.waitForSelector(testId('settings-panel'));
  check('可以切到设置页', await page.locator(testId('settings-panel')).isVisible());

  // 先故意填错：期望在字段旁边看到具体原因，而不是笼统的「连接失败」
  await page.fill(testId('model-api-url'), 'not-a-url');
  await page.click(testId('test-connection'));
  await page.waitForSelector(`${testId('test-result')}[data-ok="false"]`);
  const fieldError = await page.locator('[role="alert"]').first().innerText();
  check(
    '非法 API 地址在字段旁给出具体原因',
    fieldError.includes('http'),
    fieldError
  );
  check('校验不通过时不会谎报「连接失败」', 
    (await page.locator(testId('test-result')).innerText()).includes('请先修正表单'));
  await shot('06-配置校验失败');

  const apiKey = 'sk-e2e-1234567890';
  await page.fill(testId('model-api-url'), 'https://api.example.com/v1');
  await page.fill(testId('model-api-key'), apiKey);
  await page.fill(testId('model-name'), 'gpt-4o-mini');
  await page.click(testId('test-connection'));
  await page.waitForSelector(`${testId('test-result')}[data-ok="true"]`);

  const okText = await page.locator(testId('test-result')).innerText();
  check('合法配置通过校验', okText.length > 0);
  check('明确告知没有发起真实网络请求', okText.includes('没有发起任何网络请求'), okText);
  check('提示文案里不回显 API Key', !okText.includes(apiKey));

  await page.click(testId('save-model'));
  await page.waitForTimeout(300);
  check('模型配置可保存', await page.getByText('配置已应用').first().isVisible());
  await shot('07-测试连接通过');

  // =========================================================== 6 设置页：人格配置
  await page.fill(testId('persona-assistant-name'), '测试助手');
  await page.fill(testId('persona-user-name'), '老大');
  await page.fill(testId('persona-system-prompt'), '先给结论，再补细节。');
  await page.click(testId('save-persona'));
  await page.waitForTimeout(300);
  check('人格配置可保存', await page.getByText('人格配置已保存').first().isVisible());
  await shot('08-设置页');

  // =========================================================== 7 回聊天页看人格生效
  await page.click(testId('nav-chat'));
  await page.waitForSelector(testId('chat-panel'));
  const avatar = await assistantMessages().first().locator(testId('message-avatar')).innerText();
  check('助手头像跟随人格名称变化', avatar.trim() === '测', `实际：${avatar}`);

  // =========================================================== 8 主题切换
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click(testId('theme-toggle'));
  await page.waitForTimeout(250);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
  check('主题可以切换', themeAfter !== themeBefore, `${themeBefore} -> ${themeAfter}`);
  check(
    '主题选择被写入本地存储',
    (await page.evaluate(() =>
      window.localStorage.getItem('desktop-ai-assistant:theme')
    )) === themeAfter
  );
  await shot('09-深浅主题');

  // =========================================================== 9 刷新后恢复（持久化）
  await page.reload();
  await page.waitForSelector(testId('sidebar'));
  await page.waitForTimeout(500);

  check('刷新后会话仍在', (await page.locator(testId('conversation-item')).count()) === 1);
  check(
    '刷新后自动恢复最近一次会话',
    (await page.getAttribute(testId('conversation-item'), 'data-active')) === 'true'
  );
  const restoredMessages = await page.locator(testId('message')).count();
  check('刷新后历史消息仍在', restoredMessages >= 4, `消息数=${restoredMessages}`);
  check(
    '刷新后主题选择被记住',
    (await page.evaluate(() => document.documentElement.dataset.theme)) === themeAfter
  );

  await page.click(testId('nav-settings'));
  await page.waitForSelector(testId('settings-panel'));
  check(
    '刷新后人格配置仍在',
    (await page.inputValue(testId('persona-assistant-name'))) === '测试助手'
  );
  check(
    'API Key 没有被持久化，刷新即失效',
    (await page.inputValue(testId('model-api-key'))) === ''
  );
  check(
    '模型地址这类非敏感配置仍在',
    (await page.inputValue(testId('model-api-url'))) === 'https://api.example.com/v1'
  );
  await page.click(testId('nav-chat'));
  await page.waitForSelector(testId('chat-panel'));
  await shot('10-刷新后恢复');

  // =========================================================== 10 本地存储不含凭据
  const storageDump = await page.evaluate(() => JSON.stringify(window.localStorage));
  check('本地存储里没有 apiKey 字段', !/apikey/i.test(storageDump));
  check('本地存储里没有明文 API Key', !storageDump.includes(apiKey));

  // =========================================================== 11 删除会话（带确认）
  await page.locator(testId('conversation-item')).first().hover();
  await page.locator(testId('delete-conversation')).first().click();
  await page.waitForSelector(testId('confirm-dialog'));
  check('删除前弹出确认框', await page.locator(testId('confirm-dialog')).isVisible());
  check(
    '确认框说明了不可恢复',
    (await page.locator(testId('confirm-dialog')).innerText()).includes('无法恢复')
  );
  await shot('11-删除确认');

  await page.click(testId('confirm-cancel'));
  await page.waitForTimeout(300);
  check('取消删除后会话仍在', (await page.locator(testId('conversation-item')).count()) === 1);

  await page.locator(testId('conversation-item')).first().hover();
  await page.locator(testId('delete-conversation')).first().click();
  await page.waitForSelector(testId('confirm-dialog'));
  await page.click(testId('confirm-accept'));
  await page.waitForTimeout(500);
  check('确认后会话被删除', (await page.locator(testId('conversation-item')).count()) === 0);
  await shot('12-删除完成');

  // =========================================================== 12 重置本地数据
  await page.click(testId('nav-settings'));
  await page.waitForSelector(testId('settings-panel'));
  await page.click(testId('reset-data'));
  await page.waitForSelector(testId('confirm-dialog'));
  await page.click(testId('confirm-accept'));
  await page.waitForTimeout(500);

  check(
    '重置后设置表单跟着回到默认值',
    (await page.inputValue(testId('persona-assistant-name'))) !== '测试助手'
  );

  await page.click(testId('nav-chat'));
  await page.waitForSelector(testId('chat-panel'));
  check(
    '重置后会话列表回到空状态',
    (await page.locator(testId('conversation-item')).count()) === 0
  );
  await shot('13-重置后');

  check('全程没有出现未捕获的 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const failed = results.filter((result) => !result.passed);
console.log('\n──────────────────────────────────────────');
console.log(
  `共 ${results.length} 项检查，通过 ${results.length - failed.length}，失败 ${failed.length}`
);

if (failed.length > 0) {
  console.log('\n失败项：');
  for (const item of failed) console.log(`  · ${item.name}${item.detail ? ' :: ' + item.detail : ''}`);
}

console.log(`截图目录：${SHOT_DIR}`);
process.exitCode = failed.length === 0 ? 0 : 1;
