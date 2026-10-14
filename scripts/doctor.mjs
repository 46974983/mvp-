/**
 * 环境体检
 * ----------------------------------------------------------------------------
 * 为什么需要这个脚本：
 *
 * 有一次外部环境做验收，报了两个错 ——「tailwind 原生模块 stream did not contain
 * valid UTF-8」和「node --test spawn EPERM」—— 然后卡在「无法严谨宣布验收通过」。
 * 那两个错**都不是项目的问题**，是执行环境禁止读二进制 / 禁止创建子进程。
 *
 * 但当时没有任何快速办法把这两件事区分开，只能靠人去猜。所以有了这个脚本：
 * 把「跑测试前环境该具备什么」逐条查一遍，失败时直接告诉你**是哪一侧的问题**。
 *
 * 用法：
 *   npm run doctor
 *
 * 退出码：全部通过 0，否则 1（可以直接接在流水线前面）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const results = [];

/**
 * @param {string} name 检查项
 * @param {() => string | void} run 返回说明文字表示通过，抛错表示失败
 * @param {string} hint 失败时给出「这通常意味着什么」
 * @param {'critical' | 'info'} level critical 会决定退出码；info 只提示
 */
function check(name, run, hint, level = 'critical') {
  try {
    const detail = run();
    results.push({ name, ok: true, detail: detail ?? '', level });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, hint, level });
  }
}

function requireDir(relative) {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) {
    throw new Error(`找不到 ${relative}`);
  }
  return relative;
}

function parseMajor(version) {
  return Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '0', 10);
}

// ---------------------------------------------------------------------------
// 1. Node 版本
// ---------------------------------------------------------------------------

check(
  'Node 版本',
  () => {
    const major = parseMajor(process.version);
    if (major < 20) throw new Error(`当前是 ${process.version}，需要 20 以上`);
    return process.version;
  },
  '升级 Node。package.json 里 engines 要求 >=20。'
);

// ---------------------------------------------------------------------------
// 2. 依赖是否装好
// ---------------------------------------------------------------------------

const REQUIRED_PACKAGES = [
  'vite',
  'vitest',
  'tailwindcss',
  '@tailwindcss/oxide',
  '@tailwindcss/oxide-win32-x64-msvc',
  'playwright-core',
  '@tauri-apps/cli',
];

check(
  '依赖目录',
  () => {
    const missing = REQUIRED_PACKAGES.filter(
      (name) => !fs.existsSync(path.join(ROOT, 'node_modules', name))
    );
    if (missing.length > 0) throw new Error(`缺少 ${missing.join('、')}`);
    return `${REQUIRED_PACKAGES.length} 个关键依赖齐备`;
  },
  '在项目目录执行 npm install。若在沙箱里跑，注意沙箱可能禁止 npm 批量删除目录。'
);

// ---------------------------------------------------------------------------
// 3. 原生模块能否加载
// ---------------------------------------------------------------------------

check(
  'Tailwind 原生模块加载',
  () => {
    const binary = path.join(
      ROOT,
      'node_modules',
      '@tailwindcss',
      'oxide-win32-x64-msvc',
      'tailwindcss-oxide.win32-x64-msvc.node'
    );
    if (!fs.existsSync(binary)) {
      throw new Error('找不到平台二进制 tailwindcss-oxide.win32-x64-msvc.node');
    }
    // 二进制完整性：Windows PE 文件必须以 MZ 开头。
    // 认这个头是为了把「文件本身坏了」和「环境读不了二进制」分开。
    const header = Buffer.alloc(2);
    const fd = fs.openSync(binary, 'r');
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    if (header.toString('latin1') !== 'MZ') {
      throw new Error(
        `二进制文件头不是 MZ（读到 ${JSON.stringify(header.toString('latin1'))}），文件可能损坏`
      );
    }
    return `二进制完整（${(fs.statSync(binary).size / 1024 / 1024).toFixed(1)} MB，PE 头正常）`;
  },
  '文件损坏时重新 npm install。若报「stream did not contain valid UTF-8」，' +
    '那是**执行环境把二进制当文本读**（沙箱拦截文件读取的典型症状），不是项目问题。'
);

// ---------------------------------------------------------------------------
// 4. 能否创建子进程
// ---------------------------------------------------------------------------

check(
  '子进程创建能力',
  () => {
    // node --test 每个测试文件起一个子进程，Vitest 起 worker 进程 ——
    // 两者都依赖这个能力，而沙箱经常恰好禁掉它（表现为 spawn EPERM）
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (probe.error) {
      throw new Error(`${probe.error.code ?? ''} ${probe.error.message}`.trim());
    }
    if (probe.status !== 0) {
      throw new Error(`子进程退出码 ${probe.status}${probe.stderr ? `：${probe.stderr.trim()}` : ''}`);
    }
    return '可以创建子进程';
  },
  '这是**执行环境的限制**，不是项目问题：禁止创建子进程的沙箱里，' +
    'node --test 与 Vitest 都起不来。请在普通终端里跑测试，' +
    '或给沙箱放开进程创建权限。'
);

// ---------------------------------------------------------------------------
// 5. Rust 工具链（桌面构建用）
// ---------------------------------------------------------------------------

check(
  'Rust 工具链',
  () => {
    const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (probe.error) throw new Error(probe.error.message);
    if (probe.status !== 0) throw new Error('cargo --version 执行失败');
    return probe.stdout.trim();
  },
  '只有跑 npx tauri build / npm run test:rust 才需要它；纯前端开发可以先不管。'
);

// ---------------------------------------------------------------------------
// 6. 构建产物
// ---------------------------------------------------------------------------

check(
  '前端构建产物',
  () => {
    if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
      throw new Error('dist/index.html 不存在，还没有构建过');
    }
    const assets = fs.readdirSync(path.join(ROOT, 'dist', 'assets'));
    const chunks = assets.filter((name) => name.endsWith('.js'));
    return `${chunks.length} 个 JS chunk`;
  },
  '执行 npm run build。这条只作提示：端到端测试会自己构建，新克隆的仓库本来就没有 dist。',
  // 新克隆的仓库必然没有 dist，不该因此判失败
  'info'
);

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('\n环境体检\n' + '─'.repeat(60));
for (const item of results) {
  const mark = item.ok ? ' 通过 ' : item.level === 'info' ? ' 提示 ' : ' 失败 ';
  console.log(`${mark} ${item.name}：${item.detail}`);
  if (!item.ok && item.hint) {
    console.log(`        ↳ ${item.hint}`);
  }
}

const failed = results.filter((item) => !item.ok && item.level === 'critical');
const warned = results.filter((item) => !item.ok && item.level === 'info');
console.log('─'.repeat(60));

if (failed.length === 0) {
  console.log(
    warned.length === 0
      ? '结论：环境正常，可以执行 npm run test:all。\n'
      : `结论：环境正常（有 ${warned.length} 条提示）。可以执行 npm run test:all。\n`
  );
} else {
  console.log(`结论：${failed.length} 项未通过。请先按上面的提示处理，`);
  console.log('      再判断失败到底来自项目还是执行环境。\n');
}

process.exitCode = failed.length === 0 ? 0 : 1;
