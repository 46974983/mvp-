# 桌面 AI 助手

按《[PRODUCT_DESIGN.md](./PRODUCT_DESIGN.md)》和《[docs/TECHNICAL_PLAN.md](./docs/TECHNICAL_PLAN.md)》
实现的 Windows 桌面 AI 助手。

**进度：阶段 A（浏览器可运行 MVP）、阶段 B（Tauri 基础接入）已完成；
阶段 C 已完成「系统托盘 + 窗口隐藏/恢复」「系统通知」「开机自启」，剩余全局快捷键。**

```text
配置模型 → 流式聊天 → 会话本地保存 → 关掉 → 再打开 → 历史还在
```

这条闭环在两种运行模式下都是通的，区别只在「谁在回答、东西存在哪」：

| | 浏览器模式（`npm run dev`） | 桌面模式（`npm run dev:desktop`） |
| --- | --- | --- |
| 模型回答 | 本地离线实现，不联网 | **Rust 侧发起真实请求**（OpenAI 兼容） |
| 会话数据 | 浏览器 localStorage | **SQLite**，应用数据目录 |
| API Key | 只留内存，刷新即失效 | **Windows 凭据管理器**加密保管 |
| 网络出口 | 无 | 只在 Rust 侧，WebView 无外网权限 |
| 关闭窗口 | 关掉标签页就是关掉 | 默认**缩到系统托盘**，可关 |
| 系统托盘 | 没有（界面如实说明） | 有：显示 / 隐藏 / 退出 |
| 完成通知 | 用浏览器通知（需授权） | **系统通知**，窗口在前台时不打扰 |
| 开机自启 | 没有（界面如实说明） | 有，状态读自系统 |
| 用途 | 开发、跑测试、看界面 | 日常使用 |

浏览器模式**至今**仍然是离线实现，这不是没做完 —— 见下面「为什么浏览器模式不接真模型」。

## 快速开始

需要 Node.js 20+（用到 22）与 Rust 1.90+（用到 1.99）。

```bash
npm install

# 浏览器模式：打开 http://localhost:5173
npm run dev

# 桌面模式：启动 Tauri 开发窗口
npm run dev:desktop

# 打桌面产物（生成 exe，不打安装包）
npx tauri build --no-bundle
```

## 测试与检查

```bash
npm run doctor        # 环境体检：先分清「环境限制」和「项目问题」，再谈测试结果
npm run lint          # TypeScript 类型检查 + Rust 格式检查（cargo fmt --check）
npm run test          # 契约 + 单元 + Rust 三类一起跑
npm run test:contract # node --test：文档契约 / 运行时边界 / 工程结构 / 桌面外壳 / 能力清单
npm run test:unit     # Vitest：仓储、store、消息流、校验、Markdown、脱敏、环境切换
npm run test:rust     # cargo test：SQLite 迁移与仓储、凭据存储、SSE 解析、脱敏、关闭判定
npm run test:e2e      # 构建后用本机 Chrome 把 MVP 闭环点一遍，自动截图
npm run test:all      # 全部（doctor + lint + test + e2e）

npm run format:rust   # 格式化 Rust（等价于 cargo fmt --manifest-path src-tauri/Cargo.toml）
```

`test:all` 的第一步是 `doctor`：环境有问题时，第一行输出就告诉你**是哪一侧的问题**，
而不是让一堆看不懂的错误信息混在一起。

当前状态（全部通过）：

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 环境体检 | `npm run doctor` | 6 项全通过 |
| 契约 | `npm run test:contract` | **66 项** |
| 单元 | `npm run test:unit` | **168 项 / 11 文件** |
| Rust | `npm run test:rust` | **75 项** |
| 端到端 | `npm run test:e2e` | **65 项检查**，全程无 JS 报错 |

## 验收前先分清：环境限制 vs 项目问题

这个项目被外部环境验收过一次，报了两个错，结论是「无法严谨宣布验收通过」。
那两个错**都不是项目的问题**，是执行环境的限制。为了不再重复这种拉扯，有了 `npm run doctor`。

### 两个典型症状

| 报错 | 真实原因 | 怎么确认 |
| --- | --- | --- |
| `Could not load @tailwindcss/oxide-win32-x64-msvc`<br>`stream did not contain valid UTF-8` | **环境把二进制当文本读**。`.node` 是 Windows PE 二进制，正常 Node 用 `process.dlopen` 加载它，永远不会去解码成 UTF-8。会报这个错，说明有东西拦了文件读取并按文本解码。 | `npm run doctor` 会校验 PE 文件头（`MZ`）并实际 import 一次。文件头正常 + 加载成功 = 环境问题。 |
| `Error: spawn EPERM`<br>（`node --test` / Vitest 起不来） | **环境禁止创建子进程**。`node --test` 每个测试文件起一个子进程，Vitest 起 worker 进程，都需要这个能力。 | `npm run doctor` 会真的 spawn 一个 `node -e` 试一次。 |

### 怎么用

```bash
npm run doctor     # 先看这一行结论
npm run test:all   # 环境没问题再跑
```

`doctor` 失败时会直接写清「这通常意味着什么」。比如子进程那条会说：
*这是执行环境的限制，不是项目问题 —— 请在普通终端里跑测试，或给沙箱放开进程创建权限。*

它检查 6 项：Node 版本、依赖目录、Tailwind 原生模块（含 PE 头校验与真实加载）、
子进程创建能力、Rust 工具链、前端构建产物（仅提示）。

### 给验收方的建议

在**普通 Windows 终端**（PowerShell 或 cmd，不在任何 AI 沙箱内）执行：

```powershell
npm install
npm run test:all
npx tauri build --no-bundle
```

重点确认三件事：`doctor` 是否 6 项全绿、前端构建是否**没有 chunk 警告**、
契约/单元/E2E 是否都能起来。

Rust 侧的凭据测试会**真的读写 Windows 凭据管理器**（用独立的条目名，跑完即删）。

端到端用 `playwright-core` + 本机 Chrome，不下载浏览器内核；可用 `CHROME_PATH` 指定。

## 目录结构

```text
├── index.html / public/theme-init.js   前端入口（主题预置放在外部文件，见「CSP」）
├── PRODUCT_DESIGN.md                   产品设计（上游文档，只读）
├── docs/TECHNICAL_PLAN.md              技术方案（上游文档，只读）
├── src/                                前端（Render）
│   ├── types/domain.ts                 领域类型
│   ├── lib/                            markdown / 时间 / 脱敏 / 日志 / id
│   ├── components/{ui,layout,chat,settings,feedback}
│   ├── features/{conversations,chat,settings}   Zustand 领域服务
│   └── services/                       与外界打交道的一切，全靠接口
│       ├── runtime.ts                  「我现在跑在哪」的唯一出处
│       ├── storage/                    StorageService + browser / tauri 两套实现
│       ├── model/                      ModelProvider + mock / tauri 两套实现
│       ├── platform/                   PlatformService + browser / tauri 两套实现
│       └── container.ts                依赖组装
├── src-tauri/                          桌面外壳（Core）
│   ├── migrations/0001_init.sql        三张表：conversations / messages / settings
│   ├── capabilities/default.json       权限清单（仍然只有 core:default）
│   └── src/
│       ├── db.rs                       SQLite 连接、迁移、仓储
│       ├── secrets.rs                  Windows 凭据管理器
│       ├── chat.rs                     OpenAI 兼容请求 + SSE 流式 + 取消
│       ├── tray.rs                     托盘图标与菜单（阶段 C）
│       ├── window.rs                   窗口显示/隐藏与关闭判定（阶段 C）
│       ├── commands.rs                 前端能碰到的全部能力
│       ├── models.rs                   领域类型与领域规则
│       ├── error.rs / redact.rs        统一错误 + 脱敏
│       └── lib.rs                      开库、装状态、建托盘、注册命令
└── tests/{contract,unit,e2e}
```

## 分层与三个切换点

```text
React 组件 → features(Zustand) → services(接口) → 适配器实现
                                      ├── storage：Web Storage / SQLite
                                      ├── model  ：离线实现 / Rust 侧真实请求
                                      └── platform：浏览器能力 / Tauri 命令
```

`src/services/*/index.ts` 里各有一行判断，读 `services/runtime.ts` 的
`isTauriRuntime()` 决定返回哪套实现。除此之外没有任何地方判断运行环境 ——
有测试强制这一点（`运行环境探测只有一个出处`）。

组件层出现任何 `@/services` 或 `@tauri-apps` 的 import 都会直接红。

## 托盘与窗口（阶段 C 第一步）

「关掉窗口但程序还在跑」是桌面助手的常见设计，也是最容易被误解的设计 ——
用户点完叉发现进程还在，第一反应是「这软件关不掉」。所以这一步的重点不是托盘本身，
而是**不让用户被困住**：

- 关闭窗口默认缩到托盘，但设置页有一个明确的开关可以关掉；
- 托盘菜单同时有「显示主窗口」和「退出」—— 少任何一个，用户都会被困住；
- 托盘可用性是 **Rust 运行时判断**的，不是前端写死的：托盘创建失败时
  `decide_close_action` 会退回「关闭即退出」，而不是把窗口藏起来又找不到入口。

关闭行为的判定被抽成纯函数（`src-tauri/src/window.rs`），三个输入两个结果，
每个分支都有用例 —— 因为这个逻辑写错时的表现是「点了关闭但窗口没关」，
没有任何报错，只会让用户觉得软件坏了。

**托盘没有引入任何 Tauri 权限。** 它走的是 Tauri 核心的 tray API
（`Cargo.toml` 里开 `tray-icon` feature），完全在 Rust 侧建立和响应；
前端只多拿到 4 条自己的窄命令，`capabilities/default.json` 里仍然只有 `core:default`。
这一点有契约测试盯着（`新增原生能力没有顺带放开任何 Tauri 权限`）。

## 系统通知（阶段 C 第二步）

**这一项引入了第一个 Tauri 插件**（`tauri-plugin-notification`），
但前端仍然只多拿到两条自己的窄命令，`capabilities/default.json` 里**依然只有 `core:default`**。

### 为什么插件只在 Rust 侧用

插件自带一套前端 JS API，用起来更省事。之所以不用，是因为这一项最关键的判断在 Rust 侧：

```
回复完成 → 前端只说「有结果了」→ Rust 判断：窗口在前台吗？
                                     ├── 是 → 跳过（用户正看着呢）
                                     └── 否 → 发通知
```

前端**拿不到窗口的可见性与焦点状态**。要自己判断，就得再加一条查询命令，
而且策略被拆到两处，迟早分叉。现在策略只有一处（`src-tauri/src/notify.rs`）。

顺带的好处是权限：前端没碰插件，就不需要在 capabilities 里放开插件权限。
有契约测试盯着这条（`插件不在前端开放，仍然只走自己的窄命令`）。

### 什么时候会响

| 情况 | 发不发 | 为什么 |
| --- | --- | --- |
| 窗口缩到托盘，回复完成 | **发** | 通知存在的全部理由 |
| 窗口可见但被别的程序挡住 | **发** | 用户看不到回复 |
| 窗口可见且聚焦 | 不发 | 用户正看着流式输出，再弹一条是纯打扰 |
| 用户点了「停止」 | 不发 | 他就在屏幕前，而且是他自己按的 |
| 回复出错 | **发** | 否则切走之后消息会悄无声息地失败 |
| 点了设置页的「发一条测试通知」 | **发**（强制） | 用户明确要求看到它，此时窗口必然在前台 |

打扰判定被抽成纯函数 `should_notify(visible, focused)`，四种组合的**真值表**都有用例 ——
因为它判反了不会报错，只会让用户莫名收到通知，或者切走了却什么都没收到。

### 桌面端没有授权流程，这是刻意的

在 Windows 上，`permission_state()` 与 `request_permission()` **恒返回 `Granted`**
（插件自己的文档就这么写）。照着 Web 的思路写一套「查询 → 请求 → 再查询」的流程，
在这里就是死代码，还会让读代码的人以为真有一个授权步骤。

真正控制通知开关的地方是 Windows 的「设置 → 系统 → 通知」，逐应用生效，
应用自己查不到也改不了。所以界面上如实这样说，而不是给一个点了没用的按钮。

浏览器模式则相反：授权是真实的，而且**只在用户明确点按钮时才发起申请** ——
浏览器要求授权提示由用户手势触发，在「回复完成」这种后台时机去申请，既会被静默拒绝，又会平白打扰一次。

## 开机自启（阶段 C 第三步）

用 `tauri-plugin-autostart`。这是第三个插件，同样**只在 Rust 侧使用**，
前端只多拿到两条窄命令，`capabilities` 里依然只有 `core:default`。

### 状态存在系统里，不存我们的数据库

自启状态**刻意不写进 settings 表**。系统才是权威：注册表里那条记录随时可能被用户在
「任务管理器 → 启动应用」里关掉。我们存一份副本只会和系统对不上，
然后界面显示一个错的开关。所以每次都去问 `autolaunch().is_enabled()`。

顺带一个好处：`is_enabled()` 连「用户在任务管理器里禁用了」都能反映出来，
这个判断自己实现要读两处注册表。

### 两个 Windows 上的坑，都做成了界面文案

1. **注册的是 exe 的绝对路径。** 把 exe 挪走，自启就失效了，
   但 `is_enabled()` 仍然返回 `true` —— 它只检查那条记录在不在，不比对路径。
   所以设置页把**将要写入的路径**显示出来，并提示「重新开关一次可以刷新路径」。
   开发模式下尤其要注意：跑 `tauri dev` 时注册的是 `target/debug` 下的那个 exe。
2. **以管理员身份运行可能写进 HKLM。** 底层库的策略是「先试 HKLM，权限不够再退到 HKCU」，
   所以提权运行一次就会变成对全机器生效，而不是只对当前用户。

### 重置本地数据不会关掉它

自启是系统设置，不在「本地数据」范围内。重置对话框里写明了这一点，
并有单元测试断言「重置后系统里仍然是开着的」—— 避免有人顺手把系统状态也清了。

## 新增一种平台能力时，要同时补齐什么

阶段 C 起会陆续引入 Tauri 插件和新能力。每加一项，**六件事必须一起做**，
只加前端按钮是不算的：

| | 要做的 | 谁来保证 |
| --- | --- | --- |
| 1 | Rust / Tauri 配置（feature 或插件、模块、命令、**插件注册**） | `tests/contract/capability-checklist.test.mjs` |
| 2 | capabilities 权限（而且不能顺带多放开） | 同上 |
| 3 | `PlatformService` 接口 + 能力枚举 | 同上 |
| 4 | 浏览器模式 fallback（明确抛错，不静默） | 同上 |
| 5 | 单元 / 契约测试 | 同上 |
| 6 | Windows 桌面构建验证（`tauri build --no-bundle`） | 人工 / CI |

用法：先在 `tests/contract/capability-checklist.test.mjs` 的清单里补一行，
再照着自己列的 `desktopCommands` / `rustModules` / `rustPlugins` 去实现。
漏了哪一步都会在 `npm run test:contract` 里红掉 —— 包括「实现完了但忘了改声明」，
以及**「插件忘了 `.plugin(...)` 注册」**（那种情况编译通过、功能静默消失）。

## API Key 的旅程

这是整个工程最较真的地方，值得单独说清：

```text
用户在设置页输入 Key
   │
   ├── 浏览器模式 → 只放在内存。不写 localStorage、不进日志、刷新即清空。
   │
   └── 桌面模式  → invoke('save_model_config')
                      ├── apiUrl / modelName → SQLite 的 settings 表
                      └── apiKey            → Windows 凭据管理器（keyring）

发起对话时
   │
   桌面模式：invoke('stream_chat', { request })   ← 注意：参数里没有 Key
                 Rust 自己去凭据存储里取，装进 Authorization 头，发出去。
                 前端从头到尾没有搬运过凭据，也拿不到它。
```

三道结构性保证，都不靠「记得别写」：

1. **数据库里没有落点。** 迁移脚本中没有 `api_key` 列，`settings` 表里也没有
   `api_key` 键（有测试扫迁移脚本的字面量）。
2. **类型里没有入口。** Rust 的 `PersistedModelConfig`、前端的 `AppSettings`
   都不含 `api_key` 字段。想写进去得先改类型，改类型就过不了评审。
3. **命令签名里没有参数。** `stream_chat` 不接收 `api_key`，只接收
   `ChatRequest`（模型 + 系统提示词 + 消息）。

再加一道保险：`src-tauri/src/redact.rs` 会把 `sk-...` 与 `Bearer ...` 抹成掩码，
任何要展示的错误信息都先过它。前端同理，日志统一走 `src/lib/log.ts`。

## 为什么浏览器模式不接真模型

技术方案第 5 节写的是「浏览器 Demo 仅允许使用 mock 数据，不连接真实模型」，
理由是 API Key 不能明文落在浏览器存储里。阶段 B 没有推翻这条，而是给了它一个
更好的出口：**想让模型真的回答，就用桌面版**。

所以在 `src/services/model/index.ts` 里，浏览器分支保持返回离线实现是刻意的。
有契约测试盯着这个分支不被顺手改掉。

## CSP：为什么主题脚本要单独放一个文件

桌面版的 WebView 设置了 CSP：

```text
script-src 'self'          ← 不允许内联脚本
connect-src ipc: http://ipc.localhost   ← 没有外网出口
```

`index.html` 里原本有一段内联的主题初始化脚本（避免首屏闪白）。为了它放开
`'unsafe-inline'` 等于把整个应用的脚本策略降级，不划算。所以把它挪到了
`public/theme-init.js`：同源外链脚本，`script-src 'self'` 就够了，
并且仍然在 `<head>` 里同步执行。

开发模式另有一份 `devCsp`，只多放行 Vite 的 HMR 连接。

## 构建产物与代码分割

`npm run build` 现在产出 5 个 JS chunk，没有哪个超过 500 KB：

```text
vendor-react          219 KB   react / react-dom / scheduler
index                 151 KB   应用代码与共享依赖
vendor-ui              87 KB   Radix / sonner / lucide
SettingsPanel          52 KB   设置页表单（react-hook-form + zod + Switch）
rolldown-runtime      0.6 KB
```

两点说明，免得被数字误导：

1. **总体积没有变小**，只是被分开了。「首屏少解析」是真的省 ——
   设置页那 52 KB 要等用户点开设置才加载。
2. **对桌面版来说，拆包省的不是流量。** Tauri 的资源是从本地磁盘通过自定义协议读的，
   没有网络往返。这里真正有价值的是**启动时的解析与编译开销**，
   以及「谁的体积」在构建报告里能一眼看清。

拆包规则在 `vite.config.ts`，只固定「react」和「UI 库」两个组，**不设兜底组**：
兜底组看着整齐，实际会把「只有设置页才用的库」也钉进首屏，正好抵消按需加载的收益。
谁被谁用到，交给打包器按实际引用关系判断。

有契约测试盯住这两件事不被改回去（`前端做了代码分割，且设置页是按需加载的`）。

## 相对方案做的几个判断

1. **模型地址与模型名持久化，API Key 不持久化。**
   产品设计 3.2 要求「保存本地配置」，技术方案只禁止 Key 落盘。
2. **阶段 A 的存储用 Web Storage，不在浏览器里跑 SQLite WASM。**
   `StorageService` 的接口按 SQL 操作命名，数据按三张表分开摆，阶段 B 照搬即可。
3. **Rust 侧引入了三个 Tauri 插件**（日志、通知、开机自启），但
   `capabilities` 里**至今仍然只有 `core:default`**。

   这一点值得单独说明，因为它和「引入插件就要放开权限」的直觉相反：
   插件全部只在 Rust 侧使用，前端拿到的是自己的窄命令。
   我们一开始也以为阶段 C 会往 capabilities 里加东西，实际做下来发现
   只要坚持「前端只调自己的命令」，就一项权限都不需要。
   （真正会需要放开权限的是**前端直接调插件 JS API** 那种写法 —— 本项目没有采用。）

   托盘用的是核心的 `tray-icon` feature，同样不是插件。
   有契约测试同时比对权限清单、依赖清单、插件注册，
   并单独断言「前端不依赖任何 Tauri 插件的 JS 包」。
4. **设置页的文案全部来自服务层自述**，没有一句写死的。
   同一个界面要如实描述两种运行环境，硬编码文案必然在其中一种里撒谎。

## 下一步（阶段 C 剩余部分）

按技术方案第 6 节的顺序，阶段 C 只剩最后一项：

- **全局快捷键** —— 需要 `tauri-plugin-global-shortcut`。
  难点不在注册，而在**注册失败的处理**：组合键可能已被别的程序占用，
  失败时必须说清是哪个键被占了，否则用户会以为是键盘坏了。
  另外要拒绝「没有修饰键」的组合（例如单独一个 `A`）——
  那会把用户在全系统范围内的按键都吃掉。

阶段 D 才是文件读取、截屏、键鼠模拟。那些高权限能力按方案要求必须有
明确的设置开关、失败提示和权限说明，**默认关闭**。

## 已知缺口

- **桌面模式没有自动化 UI 测试。** 跑 Tauri 窗口需要真实 GUI 会话，脚本无法无头执行。
  窗口内行为的等价覆盖靠 Rust 单元测试（74 项）+ 环境切换与能力探测单元测试
  + 桌面外壳契约测试。但「托盘图标真的出现了吗、双击真的能恢复窗口吗」
  「系统通知真的弹出来了吗」这类事只能人工验证一次。
- **托盘与系统通知都没有在 CI 上验证过。** `tauri build --no-bundle` 只证明它能编译链接，
  不证明它在真实桌面会话里行为正确。
- **Windows 通知依赖应用的 AppUserModelID。** 插件用的是 `tauri.conf.json` 里的
  `identifier`。未安装、直接双击运行的 exe 可能出现「通知不显示」或
  显示成未知来源 —— 这是 Windows 通知机制的限制，不是代码问题。
  正式分发时装成 NSIS 包（`npm run build:desktop`）通常就正常了。
