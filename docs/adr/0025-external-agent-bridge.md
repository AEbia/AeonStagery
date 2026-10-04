---
status: proposed
---

# External Agent Bridge

## Context

项目 Agent(ADR0023)的业务循环与 Electron 完全解耦：`ProjectAgentService` 与 `ProjectAgentCoordinator` 只依赖注入端口（transport、journal、lease、项目/资源/scene 端口）。Electron 只是宿主——持有 provider 凭据、把 journal 落到本地数据目录、提供全局执行槽与窗口。这使外部 Agent（例如开发环境中的编码 Agent）无法直接启动项目 Agent 或读取其运行结果；同时 ADR0024 的 Benchmark Gate 需要一个真实 provider 的 headless 运行路径，但仓库中尚不存在任何 standalone 装配。

## Decision

新增一个与 Electron 平行的 standalone 运行路径，**共享唯一一套业务装配**，不复制 Agent 循环、工具注册表或端口实现：

### 共享引擎 `src/services/project-agent-standalone/`

- `StandaloneAiConversationTransport`：Node fetch 版 `AiConversationTransport`，委托 `electron/aiConversationProvider.ts` 的纯函数 `completeAiConversationRequest`（该文件无 Electron 运行时依赖；src 侧 import 已有先例）。凭据只来自调用方显式传入（CLI 参数或环境变量），不落盘。
- `StandaloneProjectAgentHost`：实现 `ProjectAgentMainHost`——文件系统 journal（`FileSystemProjectAgentJournalPort`，目录可配置）、内存 lease（`InMemoryProjectAgentLeasePort`）、beginTask 语义与主进程一致（同 taskId 或同项目活跃执行 → `task_exists`）、status/context/startResult 记录与回调；不实现终端工具。
- `StandaloneProjectAgentEngine`：唯一装配点。加载 `project.json` 与目标 scene 文件到 `DocumentStore`，按 Bootstrapper 同款端口构造 read/write ports（bounded reads、资源搜索/检查、readImage、scene snapshot、strict authoring gate），authoring commit 经校验后把 candidate 原子写回 scene 文件；复用 `createEditorProjectAgentService` 生成正式业务服务；`run(taskText)` 启动回合并等待 settle，`send(text)` 在既有对话上继续回合。结果从持久化 journal 记录投影（最终 assistant 文本、activities、receipts、document version），不采信内存状态。
- `StandaloneProjectAgentBenchmarkSamplePort`：在共享引擎上实现 ADR0024 的 `ProjectAgentBenchmarkSamplePort`——fixture scene 复制到临时项目目录、journal/lease 隔离、usage 由 transport 包装记录、最终 document 从落盘 scene 确定性读回、结束后清理。ADR0024 Benchmark Gate 落地时直接复用，不实现第二套装配。

### CLI `scripts/agent-bridge.ts`（`npm run agent:bridge`）

- `run --project-dir <dir> --scene-rel-path <rel> --message <text>`：触发一次执行回合并输出结构化 JSON（最终回复、活动摘要、receipt 计数、taskId、lifecycle）。
- `list --project-id <projectId>` / `show --project-id <projectId> --task-id <taskId>`：读取持久化对话记录；show 递归脱敏 `reasoning*` 字段并限制输出体积。
- `serve`：stdio 逐行 JSON-RPC（NDJSON），支持 `run`/`send`/`pause`/`cancel`/`status`/`result`/`list`/`show`/`close`，事件流推送 status/result——外部 Agent 可以在一个长驻会话中多轮往返。
- 凭据仅来自 `--endpoint`/`--model`/`--api-key` 或环境变量 `AEON_AGENT_BRIDGE_ENDPOINT/_MODEL/_API_KEY`。
- journal 默认独立目录 `~/.config/AeonStagery/agent-bridge-journal`（与正式应用 `project-agent-journal` 隔离，互不干扰），`--journal` 可覆盖。

### 边界

- 不改动 Electron 主进程/渲染进程的既有行为；standalone 路径是纯增量。
- 写入只走 ADR0023 的语义 authoring transaction：strict gate（source schema + 语义校验 + compiler + 资源引用检查）与 exact-version 提交；headless commit 等价于应用保存 scene 文件。
- 不注册终端工具；不读取音频内容、视频帧或舞台状态。
- 不解析模型文本为工具命令——只执行 provider 原生 tool call。
- 同一 scene 不应同时由正式应用与 bridge 执行写入回合；并发由 exact-version 冲突保护，但操作上应避免。

## Consequences

- 外部 Agent 可以自动启动项目 Agent、多轮沟通并读取持久化结果；应用内打开的对话与 bridge 产生的记录互不干扰。
- ADR0024 Benchmark Gate 的 headless 运行能力由共享引擎提供，避免第二套装配与循环实现。
- 新增面保持最小：standalone 目录 + CLI 脚本 + 测试 + 本文档；不引入新的运行时依赖（复用 tsx/vitest）。
