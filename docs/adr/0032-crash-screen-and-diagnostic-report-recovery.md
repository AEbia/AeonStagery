---
status: accepted
implementation_status: proposed
last_updated: 2026-08-17
---

# 崩溃界面与诊断报告恢复体系 (Crash Screen and Diagnostic Report Recovery)

## 决策

AeonStagery 建立分级防御的崩溃捕获、沉稳引导的崩溃恢复界面（Crash Screen）、内存黑匣子日志足迹（Log Breadcrumbs）与严格脱敏的结构化诊断报告（Crash Report）恢复体系。

### 1. 全栈分级崩溃防御（Crash Boundaries）

系统覆盖四级故障隔离与捕获：

- **Tier 1 (UI 软崩溃)**：各窗口顶级及核心区域 React `ErrorBoundary` 捕获组件渲染与生命周期异常。
- **Tier 2 (Renderer 全局异步异常)**：`window.onerror` / `unhandledrejection` 捕获未拦截的异步/引擎逻辑崩溃并展示 UI 恢复界面。
- **Tier 3 (Renderer 进程硬崩溃)**：Electron Main 进程监听 `render-process-gone`（OOM / GPU Crash / 崩溃退出），加载独立无依赖的静态兜底页 `crash-fallback.html`。
- **Tier 4 (Main 进程异常)**：Node.js `process.on('uncaughtException')` / `unhandledRejection` 落盘持久化诊断报告并安全通知创作者。

### 2. 崩溃界面设计与用户引导规范（Crash Screen UX）

- **禁止直展堆栈**：生产环境下界面严禁直接展示杂乱冗长的调用堆栈（Stack Trace），避免增加创作者焦虑或诱发无意义的截图。
- **开发模式可见**：在开发调试模式（`DEV`）下，保留底部默认折叠的 `<details>` 提供原始堆栈快速查看。
- **强反馈引导**：界面显式高亮提示：
  > “**问题反馈提示**：若需向开发者反馈此问题，请使用下方的【复制错误报告】或【打开报告文件】获取诊断信息。**请勿直接发送本窗口截图**（截图不含排查所需的系统环境与错误上下文）。”
- **核心操作动作**：
  - **重启应用（Primary）**：调用 `app:restart` 重新加载或重启客户端。
  - **复制错误报告（Secondary）**：将严格脱敏后的 Markdown/JSON 诊断包写入剪贴板。
  - **打开报告文件夹（Tertiary）**：在系统文件资源管理器中定位到崩溃报告存储目录。
- **多窗口独立隔离**：主编辑器 `App`、`AgentWindow` 与 `WorkspaceToolsWindow` 具有各自独立的崩溃恢复视窗，子窗口故障不殃及主编辑器。

### 3. 日志足迹与黑匣子（Log Breadcrumbs Ring Buffer）

- 在 `src/engine/Logger.ts` 中维护纯内存固定长度（100 条）的时序环形队列（Ring Buffer），捕获崩溃前系统的关键动作、状态流转与告警。
- 零额外磁盘 I/O 损耗，仅在捕获崩溃事件（`CrashEvent`）时原子化提取为 `breadcrumbs` 注入诊断报告。

### 4. 诊断报告载荷与安全脱敏策略（Crash Report & Redaction Policy）

- **数据载荷（Payload）**：
  - 报告标识：`reportId`、`timestamp`、`surface`（`editor` | `agent` | `workspace-tools` | `main`）。
  - 错误详情：`name`、`message`、`stack`、`componentStack`（仅在报告结构中保留，不在普通 UI 中展示）。
  - 环境元数据：应用版本、Electron / Chromium / Node 版本、操作系统平台与架构、内存用量、GPU / WebGL 状态。
  - 日志足迹：最近 100 条 `LogBreadcrumb`。
- **脱敏策略（Redaction）**：
  - 强制抹除用户 Home 绝对路径（转换为相对路径或 `~` 占位符）。
  - 强制剥离所有 AI Provider API Key / Token（如 OpenAI、DeepSeek、Claude、GPT-SoVITS 凭证）。
  - 剥离未发布的私密剧本文本正文，仅保留语句计数与时间线大纲结构。

### 5. 持久化存储与流转原则（Persistence & Offline Privacy）

- 报告自动持久化存储于 `app.getPath('userData')/crash-reports/crash-{timestamp}-{id}.json`（及可读 `.md`）。
- 实行本地滚动轮转策略（保留最近 20 份），防止占用过多磁盘。
- **离线隐私承诺**：不进行未经用户明确授权的静默后台远程网络上传，完全由创作者自主决定是否复制或发送给维护者。

## 边界

- `CrashScreen` 是异常发生后的灾难恢复与导流界面，不是业务状态撤销（Undo/Redo）的替代品。
- `Logger` 的环形缓冲区仅保留在内存中，不替代 `AutoSaveDaemon` 的持久化草稿能力。

## 后果

- 彻底消除渲染器白屏与进程闪退后的“无迹可寻”现象，创作者能够清晰获知故障并安全重启。
- 引导创作者提供高价值的脱敏结构化报告，杜绝“仅发一张白屏/简略提示截图”导致的低效沟通。
- 敏感凭证与私人创作资产在故障流转全生命周期中受到严格脱敏保护。
