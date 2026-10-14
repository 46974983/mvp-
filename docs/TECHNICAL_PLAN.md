# 桌面 AI 助手技术方案

## 1. 目标与范围

本方案用于实现《PRODUCT_DESIGN.md》中的 Windows 桌面 AI 助手 MVP，并为后续本地文件、截屏、键鼠模拟、常驻后台和自动化能力预留扩展边界。

MVP 优先验证：

```text
模型配置 -> 流式聊天 -> 会话本地保存 -> 重启后恢复
```

第一阶段不引入云端账号、业务后端或复杂 Agent 框架。API Key 和聊天数据默认保存在用户本机。

## 2. 总体技术选型

```text
桌面外壳：Tauri 2
前端：React + TypeScript + Vite
样式：Tailwind CSS + shadcn/ui
交互原语：Radix UI（项目初始化时统一选择一种 primitive，不与 Base UI 混用）
图标：lucide-react
状态管理：Zustand
表单校验：React Hook Form + Zod
提示反馈：Sonner
本地数据库：SQLite
模型请求：fetch + SSE/ReadableStream，封装 OpenAI-compatible API
原生层：Rust + Tauri Commands/Plugins
测试：Vitest（单元/数据层）+ Playwright（端到端）
```

当前已有的浏览器 Demo 可以继续作为 UI 和流程验证环境。接入 Tauri 时保留 React 页面和业务状态，只替换平台适配实现。

## 3. 分层架构

```text
React Renderer
  ├── 页面与组件
  ├── Zustand 状态
  ├── 领域服务（会话、聊天、设置）
  └── PlatformService 抽象
          ↓
Tauri Preload/Invoke 边界
          ↓
Rust Core
  ├── SQLite 数据访问
  ├── API Key 加密存储
  ├── 模型请求与流式事件
  ├── 文件/截屏/快捷键/托盘插件
  └── Windows 原生能力
```

React 组件不得直接依赖 Rust、文件系统或具体 Tauri 插件。所有平台能力通过 `PlatformService` 或领域服务访问。

建议的接口边界：

```ts
interface PlatformService {
  readFile(path: string): Promise<string>
  takeScreenshot(): Promise<string>
  showNotification(text: string): Promise<void>
  setAutostart(enabled: boolean): Promise<void>
}
```

开发阶段提供 `BrowserPlatformService`（必要时使用 mock）；桌面构建提供 `TauriPlatformService`。这样可以在没有 Tauri 环境时继续运行前端测试和 UI 流程。

## 4. 前端 UI 体系

组件目录建议：

```text
src/
  components/
    ui/          # shadcn/ui 基础组件，允许按产品需要修改
    layout/      # 应用壳、侧边栏、标题栏、页面布局
    chat/        # 消息列表、消息气泡、输入框、流式状态
    settings/    # 模型配置、人格配置、数据设置
    feedback/    # Dialog、Drawer、Toast、Confirm 等反馈组件
  features/
    conversations/
    chat/
    settings/
  services/
    platform/
    model/
    storage/
```

shadcn/ui 适合作为可拥有、可修改的组件源码层；Radix UI 负责 Dialog、Popover、Dropdown、Tooltip、Tabs 等交互细节。不要同时引入 Ant Design、MUI 等完整设计体系，避免主题、间距和交互规范冲突。

表单统一使用 React Hook Form + Zod。模型配置、人格配置和后续权限设置都通过 schema 校验，错误信息在表单字段附近展示，不把底层异常直接暴露给用户。

## 5. 数据与安全

SQLite 核心表建议：

- `conversations`：会话标题、创建时间、更新时间、归档状态。
- `messages`：会话 ID、角色、内容、状态、创建时间。
- `settings`：非敏感应用设置和人格配置。

API Key 不以明文写入 SQLite、localStorage 或日志。桌面版本使用 Tauri/Rust 的系统安全存储或 Windows Credential Manager；浏览器 Demo 仅允许使用 mock 数据，不连接真实模型。

模型请求统一经过 `ModelProvider`：

```ts
interface ModelProvider {
  testConnection(config: ModelConfig): Promise<Result>
  streamChat(input: ChatRequest, onDelta: (text: string) => void): Promise<void>
  abort(): void
}
```

系统提示词和用户消息在请求组装阶段明确区分。错误展示使用面向用户的摘要，日志中禁止输出 API Key、完整请求头和敏感响应。

## 6. Tauri 原生能力演进

Tauri 2 作为最终桌面外壳，按能力逐项开启，并通过 capabilities 限制窗口可访问的命令和插件。

建议顺序：

1. SQLite、加密配置和模型请求。
2. 托盘、隐藏窗口、开机启动、全局快捷键。
3. 本地文件读取和路径权限。
4. 截屏。
5. 键鼠模拟和自动化任务。

文件读取、截屏和键鼠模拟都必须由 Rust 命令或官方插件暴露，前端只能调用窄接口。键鼠模拟和截屏增加明确的设置开关、失败提示和权限说明，默认关闭高风险自动化能力。

## 7. 测试与质量门槛

- `node --test tests/`：现有数据层和文档契约测试。
- Vitest：会话状态、消息流、配置校验、ModelProvider 适配器。
- Playwright：发送消息、停止生成、设置保存、删除确认、刷新恢复、主题切换。
- Tauri 集成测试：Rust 命令权限、数据库迁移、加密存储和流式取消。

每次改动必须：

1. 增加或更新相关测试。
2. 运行全部测试和必要的 UI 流程验证。
3. 创建一个对应的 Git commit。

## 8. 分阶段实施

### 阶段 A：浏览器可运行 MVP

保留现有 Demo 的页面和交互，补齐真实项目的 TypeScript 类型、服务接口和组件目录。模型层先使用 mock provider，确保聊天、会话、设置和主题流程稳定。

### 阶段 B：Tauri 基础接入

加入 `src-tauri`、Rust 命令、SQLite 迁移和 capabilities。优先替换存储与配置实现，确认重启恢复和 API Key 安全存储。

### 阶段 C：桌面体验

加入托盘、后台运行、全局快捷键、通知和自动启动等低风险能力。

### 阶段 D：本地自动化

在权限、确认和日志机制完善后，再加入文件读取、截屏、键鼠模拟和可控自动化任务。

## 9. 关键决策

- 最终采用 Tauri 2 + React，而不是先用 Electron 再迁移。
- UI 组件采用 shadcn/ui + Radix UI，保持源码可控和视觉可定制。
- 业务层依赖平台抽象，不直接依赖 Tauri。
- MVP 无自有后端，数据默认本地化。
- 高权限能力逐项开放，默认最小权限。
