/**
 * 运行时边界测试
 * ----------------------------------------------------------------------------
 * 阶段 A 的这组用例断言「不联网、不落 Key、不碰原生能力」。
 * 阶段 B 把它们**显式改写**了，而不是删掉 —— 因为边界移动了，不是消失了：
 *
 *   不联网        → 前端（WebView）仍然完全不出网；网络只允许出现在 Rust 侧
 *   不落 Key      → 前端仍不落 Key；桌面模式下 Key 交给系统凭据管理器
 *   不碰原生能力  → 仍未开放文件/截屏/键鼠；capabilities 保持最小
 *
 * 这个文件存在的意义就是：边界可以移动，但必须留痕。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(ROOT, 'src');
const RUST_SRC = path.join(ROOT, 'src-tauri', 'src');

function walk(dir) {
  const collected = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collected.push(...walk(full));
    else collected.push(full);
  }
  return collected;
}

const toRelative = (full) => path.relative(ROOT, full).split(path.sep).join('/');

const frontendFiles = walk(SRC).map((full) => ({
  relative: toRelative(full),
  content: fs.readFileSync(full, 'utf8'),
}));

const rustFiles = walk(RUST_SRC).map((full) => ({
  relative: toRelative(full),
  content: fs.readFileSync(full, 'utf8'),
}));

const readFront = (suffix) => {
  const found = frontendFiles.find((file) => file.relative.endsWith(suffix));
  assert.ok(found, `找不到源文件：${suffix}`);
  return found.content;
};

const readRust = (suffix) => {
  const found = rustFiles.find((file) => file.relative.endsWith(suffix));
  assert.ok(found, `找不到 Rust 源文件：${suffix}`);
  return found.content;
};

const readFile = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

// ---------------------------------------------------------------------------
// 1. 网络出口：前端零出网，Rust 侧只有两个端点
// ---------------------------------------------------------------------------

test('前端（WebView）中不存在任何发起网络请求的调用', () => {
  const forbidden = [
    { pattern: /\bfetch\s*\(/, label: 'fetch()' },
    { pattern: /new\s+XMLHttpRequest/, label: 'XMLHttpRequest' },
    { pattern: /new\s+WebSocket\s*\(/, label: 'WebSocket' },
    { pattern: /\bEventSource\s*\(/, label: 'EventSource' },
    { pattern: /navigator\.sendBeacon/, label: 'sendBeacon' },
  ];

  for (const file of frontendFiles) {
    for (const { pattern, label } of forbidden) {
      assert.ok(
        !pattern.test(file.content),
        `${file.relative} 出现了 ${label}：前端不应该有外网出口，请求一律走 Rust`
      );
    }
  }
});

test('前端访问 Rust 的唯一通道是 Tauri 的 invoke', () => {
  const adapters = [
    'src/services/storage/tauri-storage.ts',
    'src/services/model/tauri-provider.ts',
  ];
  for (const relative of adapters) {
    const content = readFront(relative);
    assert.match(content, /from '@tauri-apps\/api\/core'/, `${relative} 应通过 @tauri-apps/api 通信`);
  }
});

test('Rust 侧的模型请求只打两个端点', () => {
  const chat = readRust('src/chat.rs');

  assert.match(chat, /reqwest/, 'Rust 侧应使用 reqwest 发起请求');
  assert.match(chat, /endpoint\(api_url, "models"\)/, '测试连接应打 models 端点');
  assert.match(
    chat,
    /endpoint\(api_url, "chat\/completions"\)/,
    '对话应打 chat/completions 端点'
  );

  // 端点只能由 endpoint() 拼出来，不允许散落别处
  const endpointCalls = chat.match(/\.(get|post)\(&url\)/g) ?? [];
  assert.equal(endpointCalls.length, 2, 'Rust 侧应恰好有两处发请求的地方');
});

test('API 地址必须显式声明协议，不接受相对地址', () => {
  const chat = readRust('src/chat.rs');
  assert.match(chat, /reqwest::Url::parse\(trimmed\)/);
  assert.match(chat, /url\.scheme\(\) == "http"/);
  assert.match(chat, /address\.is_loopback\(\)/);
  assert.match(chat, /Policy::none\(\)/, '带凭据的模型请求不应跟随服务端重定向');
});

test('一般偏好保存不应被旧的模型地址阻塞，模型地址走专用校验命令', () => {
  const commands = readRust('src/commands.rs');
  const saveSettings = /pub async fn save_settings\([\s\S]*?\n\}/.exec(commands);
  const saveModelConfig = /pub async fn save_model_config\([\s\S]*?\n\}/.exec(commands);

  assert.ok(saveSettings, '未找到 save_settings');
  assert.ok(saveModelConfig, '未找到 save_model_config');
  assert.doesNotMatch(saveSettings[0], /validate_api_url|save_model_projection/);
  assert.match(saveModelConfig[0], /validate_api_url/);
});

// ---------------------------------------------------------------------------
// 2. 凭据：不落明文
// ---------------------------------------------------------------------------

test('数据库迁移脚本里没有存放凭据的列或键', () => {
  // 先剥掉 SQL 注释：这里要断言的是**表结构**，不是注释文字。
  // （迁移脚本里恰好有一句注释在解释「刻意没有 api_key 列」，
  //   不剥注释的话，最守规矩的那份文件反而会被判红。）
  const migration = readFile('src-tauri/migrations/0001_init.sql')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .toLowerCase();

  for (const forbidden of ['api_key', 'apikey', 'token', 'secret']) {
    assert.ok(!migration.includes(forbidden), `迁移脚本不应出现 ${forbidden}`);
  }

  // 三张表都得在
  for (const table of ['conversations', 'messages', 'settings']) {
    assert.ok(migration.includes(`create table if not exists ${table}`), `缺少 ${table} 表`);
  }
});

test('Rust 侧可持久化的模型配置类型里没有 api_key', () => {
  const models = readRust('src/models.rs');

  const block = /pub struct PersistedModelConfig \{([\s\S]*?)\n\}/.exec(models);
  assert.ok(block, '未能找到 PersistedModelConfig 定义');
  assert.ok(!block[1].includes('api_key'), 'PersistedModelConfig 是可入库类型，不允许含 api_key');

  const settingsBlock = /pub struct AppSettings \{([\s\S]*?)\n\}/.exec(models);
  assert.ok(settingsBlock, '未能找到 AppSettings 定义');
  assert.ok(!settingsBlock[1].includes('api_key'), 'AppSettings 不允许含 api_key');
});

test('前端的可持久化结构里没有 apiKey', () => {
  const domain = readFront('src/types/domain.ts');

  const settingsBlock = /interface AppSettings\s*\{([\s\S]*?)\n\}/.exec(domain);
  assert.ok(settingsBlock, '未能在 domain.ts 中找到 AppSettings');
  assert.ok(!/apiKey/.test(settingsBlock[1]), 'AppSettings 不允许包含 apiKey');

  const storage = readFront('src/services/storage/browser-storage.ts');
  const snapshotBlock = /interface StorageSnapshot\s*\{([\s\S]*?)\n\}/.exec(storage);
  assert.ok(snapshotBlock, '未能在 browser-storage.ts 中找到 StorageSnapshot');
  assert.ok(!/apiKey/.test(snapshotBlock[1]), 'StorageSnapshot 是写盘结构，不允许包含 apiKey');
});

test('凭据只经由一个模块进出，且集中在一个服务名下', () => {
  const secrets = readRust('src/secrets.rs');

  assert.match(secrets, /keyring/, '凭据应由 keyring 交给系统凭据存储');
  assert.match(secrets, /const SERVICE: &str = "desktop-ai-assistant"/);

  // 除了 secrets.rs，别处不许直接碰 keyring
  for (const file of rustFiles) {
    if (file.relative.endsWith('src/secrets.rs')) continue;
    assert.ok(
      !file.content.includes('keyring'),
      `${file.relative} 直接引用了 keyring：凭据的读写必须收在 secrets 模块里`
    );
  }
});

test('Rust 侧错误信息与日志都经过脱敏', () => {
  const error = readRust('src/error.rs');
  assert.match(error, /safe_excerpt/, '错误信息附带的响应体必须先脱敏再截断');

  const redact = readRust('src/redact.rs');
  assert.match(redact, /pub fn redact_sensitive/);
  assert.match(redact, /min\(\)/);
});

test('前端日志统一出口，除 log.ts 外不许直接 console', () => {
  const logger = readFront('src/lib/log.ts');
  assert.match(logger, /redactSensitive/);

  const offenders = frontendFiles
    .filter((file) => /console\.(log|warn|error|debug)/.test(file.content))
    .filter((file) => !file.relative.endsWith('src/lib/log.ts'))
    .map((file) => file.relative);

  assert.deepEqual(offenders, [], '除 src/lib/log.ts 外不允许直接使用 console');
});

test('浏览器模式下本地存储仍然只有两个键', () => {
  const allowed = ['desktop-ai-assistant:mvp', 'desktop-ai-assistant:theme'];
  const scanned = [
    ...frontendFiles,
    { relative: 'index.html', content: readFile('index.html') },
    { relative: 'public/theme-init.js', content: readFile('public/theme-init.js') },
  ];

  const found = new Set();
  for (const file of scanned) {
    for (const match of file.content.matchAll(/desktop-ai-assistant:[a-zA-Z0-9:_-]+/g)) {
      found.add(match[0]);
    }
  }

  assert.deepEqual(
    [...found].sort(),
    [...allowed].sort(),
    '检测到计划之外的本地存储键'
  );
});

// ---------------------------------------------------------------------------
// 3. 原生能力：capabilities 保持最小
// ---------------------------------------------------------------------------

test('capabilities 只放行 core:default，不放任何插件权限', () => {
  const capabilityFiles = fs.readdirSync(path.join(ROOT, 'src-tauri', 'capabilities'));
  assert.ok(capabilityFiles.length > 0, '至少应有一个 capability 文件');

  for (const fileName of capabilityFiles) {
    const capability = JSON.parse(readFile(`src-tauri/capabilities/${fileName}`));
    assert.deepEqual(
      capability.permissions,
      ['core:default'],
      `${fileName} 的权限应只有 core:default`
    );
    assert.deepEqual(capability.windows, ['main'], `${fileName} 应只作用于 main 窗口`);
  }
});

test('没有引入任何高危 Tauri 插件', () => {
  const cargo = readFile('src-tauri/Cargo.toml');

  // 判定标准是**这个插件的能力会不会直接喂给 WebView**，而不是「插件本身是不是好东西」。
  //
  //   fs / shell / http / process —— 前端一旦能碰，就等于绕过了整个 Rust 侧的约束
  //
  // 阶段 C 的 notification / autostart / global-shortcut 和阶段 D 的 dialog
  // 都不在此列：它们**只在 Rust 侧使用**（前端拿到的是自己的窄命令），
  // 而且 capabilities 里没有为它们放开任何权限 —— 这一条另有测试盯着。
  //
  // dialog 是阶段 D 加进来的，只用于「选择文件夹」这一个动作。
  // 早先这里把它列为高危，理由是「能让前端拉起系统 UI 去打开任意路径」；
  // 那个理由成立的**前提是前端能调它的 JS API** —— 现在这个前提不成立，
  // 所以按实际危害重新判定，而不是留着一条已经不表达任何约束的禁令。
  const dangerous = ['tauri-plugin-fs', 'tauri-plugin-shell', 'tauri-plugin-http', 'tauri-plugin-process'];

  for (const plugin of dangerous) {
    assert.ok(!cargo.includes(plugin), `不应引入 ${plugin}：它会给 WebView 开出直接通道`);
  }
});

test('Rust 侧没有进程执行', () => {
  for (const file of rustFiles) {
    assert.ok(
      !file.content.includes('std::process::Command') && !file.content.includes('process::Command'),
      `${file.relative} 出现了进程执行：那不是本项目该有的能力`
    );
  }
});

test('文件访问的边界：前端只能给相对路径，绝对路径只走授权那一条', () => {
  const commands = readRust('src/commands.rs');

  // 命令层不做实际的文件读写 —— 读写都在 file_access.rs 里，那里有路径检查。
  // 命令层一旦自己开文件，就等于绕开了那套检查。
  assert.ok(
    !commands.includes('read_to_string') && !commands.includes('remove_file'),
    '命令层不应直接读写文件，文件访问一律经 file_access 模块'
  );

  // 读文件和列目录的参数必须叫 relative_*，收的就是相对路径。
  // 这条断言的作用是：以后谁想把 read_authorized_file 改成收绝对路径，
  // 必须先在这里改掉这个命名，而改的时候会看到上面这段说明。
  assert.match(
    commands,
    /pub async fn read_authorized_file\([\s\S]*?relative_path: String/,
    '读取命令必须收「相对授权目录的路径」，不能收绝对路径'
  );
  assert.match(
    commands,
    /pub async fn list_authorized_directory\([\s\S]*?relative_dir: String/,
    '列目录命令同样只收相对路径'
  );

  // 唯一允许出现绝对路径的地方是授权命令，而且必须过 validate_authorized_root
  const authorize = /pub async fn authorize_directory\([\s\S]*?\n\}/.exec(commands);
  assert.ok(authorize, '未能找到 authorize_directory');
  assert.match(
    authorize[0],
    /validate_authorized_root\(/,
    '授权命令必须用 validate_authorized_root 校验目录，不能直接存用户给的字符串'
  );

  // 逃逸防护本身要有测试盯着 —— 这是安全边界，没测试的边界等于没有
  const fileAccess = readRust('src-tauri/src/file_access.rs');
  assert.match(fileAccess, /fn resolve_within_root/, '路径解析必须集中在 resolve_within_root 一处');
  assert.match(fileAccess, /Component::ParentDir/, '必须显式拒绝 `..` 上跳');
  assert.match(fileAccess, /fn ensure_no_symlink/, '必须拒绝路径经过符号链接');
});

test('capabilities 收紧的同时，模型层的两个实现仍然都在', () => {
  const modelIndex = readFront('src/services/model/index.ts');
  // 浏览器分支保持离线实现是刻意的，不是忘了改
  assert.match(modelIndex, /return new MockModelProvider\(\)/);
  assert.match(modelIndex, /return createTauriModelProvider\(\)/);

  const mock = readFront('src/services/model/mock-provider.ts');
  assert.match(mock, /performsNetworkRequest = false/);

  const tauri = readFront('src/services/model/tauri-provider.ts');
  assert.match(tauri, /performsNetworkRequest: true/);
});

// ---------------------------------------------------------------------------
// 4. 分层边界
// ---------------------------------------------------------------------------

test('组件层只能通过 features 访问服务，也不直接引用 Tauri API', () => {
  const componentFiles = frontendFiles.filter((file) =>
    file.relative.startsWith('src/components/')
  );
  assert.ok(componentFiles.length >= 10, '组件文件数量异常');

  for (const file of componentFiles) {
    assert.ok(
      !/from\s+['"]@\/services/.test(file.content),
      `${file.relative} 直接引用了 @/services：组件应通过 @/features 访问`
    );
    assert.ok(
      !/from\s+['"]@tauri-apps/.test(file.content),
      `${file.relative} 直接引用了 Tauri API：平台能力必须经服务层`
    );
  }
});

test('组件层不直接触碰 Web Storage', () => {
  for (const file of frontendFiles.filter((f) => f.relative.startsWith('src/components/'))) {
    assert.ok(
      !/localStorage|sessionStorage/.test(file.content),
      `${file.relative} 直接操作了 Web Storage，应走 storage 服务`
    );
  }
});

test('运行环境探测只有一个出处', () => {
  const offenders = frontendFiles
    .filter((file) => file.content.includes('__TAURI_INTERNALS__'))
    .map((file) => file.relative);

  assert.deepEqual(
    offenders,
    ['src/services/runtime.ts'],
    '「当前跑在哪」只能由 src/services/runtime.ts 回答'
  );
});

// ---------------------------------------------------------------------------
// 5. 命令清单是显式的
// ---------------------------------------------------------------------------

test('注册的每个命令都在 commands.rs 里定义过', () => {
  const lib = readRust('src/lib.rs');
  const commands = readRust('src/commands.rs');

  const registered = [...lib.matchAll(/commands::([a-z_0-9]+)/g)].map((match) => match[1]);
  assert.ok(registered.length >= 15, `注册的命令太少，只有 ${registered.length} 个`);

  for (const name of registered) {
    assert.ok(
      commands.includes(`pub async fn ${name}`) || commands.includes(`pub fn ${name}`),
      `commands.rs 里找不到已注册的命令 ${name}`
    );
    assert.ok(
      new RegExp(`#\\[tauri::command\\][\\s\\S]{0,80}fn ${name}`).test(commands),
      `${name} 缺少 #[tauri::command] 标注`
    );
  }
});

test('流式对话不接收 API Key 参数 —— 凭据由 Rust 自己取', () => {
  const commands = readRust('src/commands.rs');
  const block = /pub async fn stream_chat\(([\s\S]*?)\)\s*->/.exec(commands);
  assert.ok(block, '未能找到 stream_chat 的签名');
  assert.ok(
    !block[1].includes('api_key'),
    'stream_chat 不应接收 api_key：它应当从系统凭据存储里读'
  );
});

test('新增的迁移脚本同样不许出现凭据字段', () => {
  // 0001 的检查写死了文件名，所以新加的迁移不会被它覆盖到 ——
  // 这条按目录扫，以后再加迁移也自动生效
  const directory = path.join(ROOT, 'src-tauri/migrations');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.sql'));

  assert.ok(files.length >= 2, `迁移脚本数量看起来不对：${files.join(', ')}`);

  for (const name of files) {
    const content = fs
      .readFileSync(path.join(directory, name), 'utf8')
      .replace(/--[^\n]*/g, ''); // 去掉注释：注释里为了说明「刻意没有这个列」会提到它

    for (const forbidden of ['api_key', 'apikey', 'token', 'secret', 'password']) {
      assert.ok(!content.includes(forbidden), `${name} 不应出现 ${forbidden}`);
    }
  }
});

test('附件随消息一起入库，而不是只留一个引用', () => {
  // 多轮对话每次都要把整段历史重发给模型。历史里的图片只剩引用的话，
  // 第二轮开始模型就看不到它了 —— 所以附件内容必须跟着消息存下来。
  const migration = readFile('src-tauri/migrations/0002_attachments.sql');
  assert.match(
    migration,
    /ALTER TABLE messages ADD COLUMN attachments/,
    '0002 应当给 messages 加上 attachments 列'
  );

  const models = readRust('src-tauri/src/models.rs');
  assert.match(models, /pub struct Message \{[\s\S]*?attachments: Vec<ChatAttachment>/, 'Message 要带附件');
  assert.match(
    models,
    /pub enum ChatAttachment \{/,
    '附件应当是枚举：文件和图片的字段不同，靠类型表达比靠约定可靠'
  );

  // 写入与读取都要带上这一列，只改一半会静默丢数据
  const db = readRust('src-tauri/src/db.rs');
  assert.match(db, /INSERT INTO messages \([^)]*attachments/, '写入要带上 attachments 列');
  assert.match(db, /SELECT id, conversation_id, role, content, status, created_at, attachments/, '读取要带上 attachments 列');
});

test('图片附件的门禁在 Rust 侧', () => {
  // 把图发给只认文本的模型，换回来的是用户看不懂的 API 报错。
  // 前端也会拦一道，但不能只靠前端 —— 命令是可以被直接调用的。
  const commands = readRust('src-tauri/src/commands.rs');
  const stream = /pub async fn stream_chat\([\s\S]*?\n\}/.exec(commands);
  assert.ok(stream, '找不到 stream_chat');

  assert.match(stream[0], /contains_screenshot\(/, 'stream_chat 应当检查请求里有没有图片');
  assert.match(
    stream[0],
    /supports_vision/,
    '检查要基于我们库里的模型配置，而不是前端传进来的参数'
  );
});
