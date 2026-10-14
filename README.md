# 桌面 AI 助手 · 阶段 A

按《[PRODUCT_DESIGN.md](./PRODUCT_DESIGN.md)》和《[docs/TECHNICAL_PLAN.md](./docs/TECHNICAL_PLAN.md)》
实现的 Windows 桌面 AI 助手。当前完成的是技术方案里的**阶段 A：浏览器可运行 MVP**。

阶段 A 的目标不是「能聊天」，而是**把地基打好**：

```text
配置模型 → 流式聊天 → 会话本地保存 → 重启后恢复
```

这条闭环在阶段 A 是完整可用的；模型回答来自本地离线实现，不联网 —— 这是技术方案
第 5 节的硬约束（API Key 不能明文落在浏览器里，真实请求要等阶段 B 由 Rust 侧发出）。

## 快速开始

需要 Node.js 20 以上（开发用的是 22）。

```bash
npm install
npm run dev          # 打开 http://localhost:5173
```

## 三条测试命令

```bash
npm run test:contract   # node --test：文档契约 + 阶段 A 边界 + 工程结构
npm run test:unit       # Vitest：仓储 / store / 消息流 / 校验 / Markdown / 脱敏
npm run test:e2e        # 构建后用本机 Chrome 把 MVP 闭环点一遍，自动截图
npm run test:all        # 上面三条依次跑
npm run build           # tsc --noEmit && vite build
```

当前状态（全部通过）：

| 套件 | 结果 |
| --- | --- |
| 契约测试 | 22 项 |
| 单元测试 | 104 项 / 9 个文件 |
| 端到端 | 50 项检查，全程无 JS 报错，截图落在 `tests/screenshots/` |

端到端用 `playwright-core` + 本机已装的 Chrome，**不下载浏览器内核**；找不到 Chrome 时
会退回 Playwright 自己解析。想指定浏览器：设环境变量 `CHROME_PATH`。

## 目录结构

```text
├── index.html                 Vite 入口（含首屏主题预置脚本，避免闪白）
├── PRODUCT_DESIGN.md          产品设计（上游文档，不改）
├── docs/TECHNICAL_PLAN.md     技术方案（上游文档，不改）
├── src/
│   ├── main.tsx / App.tsx     应用入口与应用壳
│   ├── index.css              主题变量 + Tailwind 注册 + Markdown 排版
│   ├── types/domain.ts        领域类型（对齐 SQLite 三张表）
│   ├── lib/                   纯函数：markdown / 时间 / 脱敏 / 日志 / id / cn
│   ├── hooks/useTheme.ts      主题状态
│   ├── components/            UI，按技术方案第 4 节分目录
│   │   ├── ui/                shadcn 风格基础组件（button/input/label/card/dialog）
│   │   ├── layout/            Titlebar / Sidebar
│   │   ├── chat/              ChatPanel / MessageList / MessageBubble / Composer
│   │   ├── settings/          ModelConfigForm / PersonaForm / DataPanel
│   │   └── feedback/          ConfirmDialog / AppToaster
│   ├── features/              领域服务（Zustand store）
│   │   ├── conversations/     会话与消息
│   │   ├── chat/              一轮对话的编排（含流式与中断）
│   │   └── settings/          配置校验与保存
│   └── services/              与外界打交道的一切，全靠接口
│       ├── storage/           StorageService + 浏览器实现
│       ├── model/             ModelProvider + 离线实现
│       ├── platform/          PlatformService + 浏览器实现
│       └── container.ts       依赖组装（全应用唯一决定「用哪个实现」的地方）
└── tests/
    ├── contract/              node --test：文档契约 / 边界 / 结构
    ├── unit/                  Vitest
    ├── e2e/ui-flow.check.mjs  端到端流程验证
    └── screenshots/           端到端自动截图（已 gitignore）
```

## 分层与替换点

```text
React 组件  →  features（领域服务）  →  services（接口）  →  适配器实现
                    │                        │
                    │                        ├── storage：Web Storage → 阶段 B 换 SQLite
                    │                        ├── model：离线实现 → 阶段 B 换 Rust 侧请求
                    │                        └── platform：浏览器能力 → 阶段 B 换 Tauri 命令
                    └── 组件层不出现任何 @/services 的 import（有测试盯着）
```

换实现时只动 `src/services/*/index.ts` 里的那一行返回语句，界面与 store 一行都不用改。
`tests/contract/stage-a-boundaries.test.mjs` 会强制这条规则，违反了直接红。

## 阶段 A 的边界（有意为之，且有测试守着）

- **不联网。** `src/` 下不允许出现 `fetch(` / `XMLHttpRequest` / `WebSocket` / `EventSource`。
- **API Key 不落盘。** 只有 `apiUrl` 和 `modelName` 会被持久化；`apiKey` 仅存在于内存，
  刷新即清空。可持久化结构 `AppSettings` 的类型里就没有 `apiKey` 字段。
- **本地存储只有两个键。** `desktop-ai-assistant:mvp`（会话与设置）和
  `desktop-ai-assistant:theme`（主题）。测试会比对白名单。
- **不碰原生能力。** 未引入 Tauri / Electron 依赖，也没有 `src-tauri`。
  `PlatformService` 目前只有「系统通知」是真能力，其余调用会抛
  `UnsupportedCapabilityError`，而不是返回假数据。
- **日志统一出口。** 除 `src/lib/log.ts` 外不允许直接 `console.*`，以免绕过脱敏。

## 相对方案做的两个判断

1. **模型地址与模型名持久化，API Key 不持久化。**
   产品设计 3.2 要求「保存本地配置」，而技术方案第 5 节只禁止 Key 落盘。
   所以持久化的是模型配置的一个投影（`PersistedModelConfig`，只有 `apiUrl` 和 `modelName`）。
   代价是刷新后要重填 Key，界面上写明了这件事。
2. **阶段 A 的存储用 Web Storage 而不是在浏览器里跑 SQLite。**
   在浏览器里编译一份 SQLite WASM 只会换来体积和一套独立的迁移脚本。
   `StorageService` 的接口按 SQLite 的操作命名（`listConversations` / `appendMessage` /
   `updateMessage` …），数据也按三张表分开摆，阶段 B 可以一一对照着搬。

## 下一步（阶段 B）

按技术方案第 8 节：接入 `src-tauri`、Rust 命令、SQLite 迁移和 capabilities，
优先替换**存储**与**模型请求**两块实现，把 API Key 交给系统安全存储。

本机目前没有 Rust 工具链（`rustc` / `cargo` / `rustup` 均未安装），
阶段 B 需要先装 rustup + MSVC 生成工具；`tests/contract/stage-a-boundaries.test.mjs`
里关于「不联网 / 无 src-tauri」的断言到那时需要显式改写 —— 边界应该被公开移动，
而不是被悄悄绕过。
