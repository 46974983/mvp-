# 桌面 AI 助手

按《[PRODUCT_DESIGN.md](./PRODUCT_DESIGN.md)》和《[docs/TECHNICAL_PLAN.md](./docs/TECHNICAL_PLAN.md)》
实现的 Windows 桌面 AI 助手。**阶段 A（浏览器可运行 MVP）与阶段 B（Tauri 基础接入）均已完成。**

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

## 测试

```bash
npm run test          # 契约 + 单元 + Rust 三类一起跑
npm run test:contract # node --test：文档契约 / 运行时边界 / 工程结构 / 桌面外壳
npm run test:unit     # Vitest：仓储、store、消息流、校验、Markdown、脱敏、环境切换
npm run test:rust     # cargo test：SQLite 迁移与仓储、凭据存储、SSE 解析、脱敏
npm run test:e2e      # 构建后用本机 Chrome 把 MVP 闭环点一遍，自动截图
npm run test:all      # 全部
```

当前状态（全部通过）：

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 契约 | `npm run test:contract` | **43 项** |
| 单元 | `npm run test:unit` | **120 项 / 10 文件** |
| Rust | `npm run test:rust` | **49 项** |
| 端到端 | `npm run test:e2e` | **50 项检查**，全程无 JS 报错 |

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
│   ├── capabilities/default.json       权限清单（只有 core:default）
│   └── src/
│       ├── db.rs                       SQLite 连接、迁移、仓储
│       ├── secrets.rs                  Windows 凭据管理器
│       ├── chat.rs                     OpenAI 兼容请求 + SSE 流式 + 取消
│       ├── commands.rs                 前端能碰到的全部能力
│       ├── models.rs                   领域类型与领域规则
│       ├── error.rs / redact.rs        统一错误 + 脱敏
│       └── lib.rs                      开库、装状态、注册命令
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

## 相对方案做的几个判断

1. **模型地址与模型名持久化，API Key 不持久化。**
   产品设计 3.2 要求「保存本地配置」，技术方案只禁止 Key 落盘。
2. **阶段 A 的存储用 Web Storage，不在浏览器里跑 SQLite WASM。**
   `StorageService` 的接口按 SQL 操作命名，数据按三张表分开摆，阶段 B 照搬即可。
3. **阶段 B 的 Rust 侧不引入任何 Tauri 插件**（除日志）。
   capabilities 只有 `core:default`，没有 fs / shell / http / dialog。
   有契约测试比对权限清单与依赖清单。
4. **设置页的文案全部来自服务层自述**，没有一句写死的。
   同一个界面要如实描述两种运行环境，硬编码文案必然在其中一种里撒谎。

## 下一步（阶段 C）

按技术方案第 8 节，阶段 C 是「桌面体验」：托盘、隐藏窗口、开机启动、全局快捷键、通知。
这些能力会加在 `PlatformService` 上，并把 `capabilities/default.json` 逐项放开 ——
目前 `src/services/platform/tauri-platform.ts` 的能力集合是**空的**，这是如实回答：
问一次「能不能截屏」，答案就是不能。

阶段 D 才是文件读取、截屏、键鼠模拟；那些高权限能力需要先补齐权限说明与失败提示。
