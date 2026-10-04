---
status: partially-superseded
superseded_by:
  - KSM-0003
last_reviewed: 2026-07-20
---

# Timeline Authoring, Collaboration Transactions, and Resource Seams

ADR-0001、ADR-0005 与 ADR-0013 的核心方向仍然有效，但它们包含明显的阶段性限制。当前架构决策是把 timeline action edit、协作状态事务规划、协作资源准备与 Live2D bundle 规则串成一条深链路，而不是继续让 UI、DocumentAdapter 与协作层各自反推相同事实。

> Current reading: collaboration transaction planning、publish execution、asset readiness gate、Live2D bundle rules 和 asset scope policy 仍以本文为当前入口。Timeline action edit 的旧 Interface 已被 KSM-0003 的 semantic statement authoring 接管；本文中 `Action` / `timelineOrder` 术语应按 `SceneStatement` / `statementOrder` 的当前实现翻译。

## Decision

`TimelineAuthoringService` 是 timeline UI 的 authoring seam，但它有两个独立 Interface：

- `author(intent)` 只覆盖 Create / Delete / Structural Authoring，并继续遵守 ADR-0005 的 typed intent、resolver、receipt、all-or-nothing 事务语义。
- `previewActionEdit` / `commitActionEdit` / `commitActionEdits` 覆盖普通 action patch、参数编辑、drag / resize、inspector patch 与 transient preview。它们不进入 structural `author(intent)`，也不把 `DocumentAdapter` 重新提升为 timeline UI 的公共写入 seam。

如果类型层需要更窄的 role Interface，可以让 `TimelineAuthoringService` 实现 `ITimelineActionEditService`，只暴露 `previewActionEdit(s)` 与 `commitActionEdit(s)`，供 inspector、stage overlay 与 track drag 使用。

`DocumentAdapter` 保留为内部执行 Adapter，负责 patch history、DocumentStore mutation 与 projection。UI 可以继续使用 undo / redo 读写能力，但 timeline action edit 不应直接调用 `documentAdapter.commitActionUpdate(s)` 或 `previewActionUpdate(s)`。

协作发布必须引入 `CollaborativeStateTransactionPlanner`：输入 previous / next `CollaborativeSceneState`、可用 client capabilities 与当前 tombstone，输出 `noop | entity | full` plan。该 Module 负责 diff 分类、`timelineOrder`、delete-wins tombstone、跨实体 full fallback 与 tombstoned record filtering；它不触碰 Yjs、`DocumentStore` 或 React。

协作执行应与规划分离：`CollaborativeStatePublishExecutor` 执行 planner 产物并处理 realtime writability、缺失 entity-level adapter、服务端拒绝与 resync/error 投影。这样 planner 保持纯规则，Yjs 与网络行为留在 Adapter seam。

协作资源准备必须引入 `CollaborativeAssetReadinessGate`：本地发布前负责 manifest build、agreement proposal、外部库文件 projectize、upload、verify；远端应用前负责 agreement、download/copy/replace、size/hash verify。失败时不能写入 `DocumentStore`，用户取消时不能 seed、应用远端状态或提交本地素材变更。

`CollaborativeResourceHandshake` 只是 `CollaborativeAssetReadinessGate` 的用户可见投影。它展示状态、文案、agreement review 与 transfer progress，但不是资源事实来源。

Live2D bundle 规则必须抽成共享纯 Module：`Live2DAssetBundle` 负责路径规范化、`.model.json` / `model.json` / `.wmdl` 依赖发现、file fingerprint、bundle hash feed 与 manifest file ordering。客户端 manifest builder、SceneAssetService 导入复制、服务端 availability check 只提供 IO Adapter。

协作素材范围必须由 `CollaborativeAssetScopePolicy` 显式锁定。当前正式接受的范围是 Live2D bundle、background image、audio file、image file 与 animation file；generic file、模板资源和导出产物暂不自动进入协作素材范围。不能让 manifest builder 的散落扫描逻辑成为事实上的产品决策。

## Consequences

- ADR-0001 中 “DocumentAdapter 是 UI 唯一写入入口” 降级为迁移期说法；当前原则是 UI 不直连引擎和共享状态，写入跨受控 authoring seam。
- ADR-0005 的 ordinary edit 非目标降级为 phase-1 scope；它不再禁止普通 action edit 进入 `TimelineAuthoringService` 的独立 Interface。
- ADR-0013 的 Live2D bundle 规则继续有效，但素材范围必须重新对齐代码与产品语言。
- `TimelineStructuralWriteGuard` 需要扩展为 timeline UI 不直接调用 `documentAdapter.commitActionUpdate(s)` / `previewActionUpdate(s)`。
- `ITimelineAuthoringService` 中 ordinary edit 方法应从 optional 变为 required，并补齐 batch `commitActionEdits`。
- 协作 planner、readiness gate 与 Live2D bundle 纯规则都应以 Module Interface 为测试面，避免继续通过 UI hook 或 Yjs integration 测试间接覆盖核心规则。

## Implementation Alignment

当前实现已对齐本 ADR 的主链路：

- `ITimelineAuthoringService` 的 `previewActionEdit` / `commitActionEdit` / `commitActionEdits` 已成为 required ordinary edit Interface；`DocumentAdapter` 保留为内部执行 Adapter，`IUiDocumentAdapter` 只暴露 undo / redo。
- `TimelineEditor`、`TimelineListView` 与 `StageOverlay` 的普通 timeline action edit 已迁到 `TimelineAuthoringService`；guard 测试阻止 timeline UI 重新直连 `documentAdapter.previewActionUpdate(s)` / `commitActionUpdate(s)`。
- timeline UI 的展示、导航与选择不再自行对 `sceneData.timeline` 执行 time sort，而是消费 `DocumentStore.getCanonicalActionSequence()` 这个 read model Interface。
- `CollaborativeStateTransactionPlanner` 负责 diff 分类、entity-level plan、full fallback、`timelineOrder` 与 tombstone-backed publish；`CollaborativeStatePublishExecutor` 负责执行 planner 产物。
- `CollaborativeStateTombstones` 提供 delete-wins tombstone 过滤与删除补 tombstone 的纯规则，planner 与 Yjs Adapter 共用同一实现。
- `CollaborationClient` 识别服务端 `collaboration:error` rejection，并用服务端 Yjs snapshot 重写本地协作 root；`CollaborativeDocumentLayer` 通过 error subscription 投影错误，避免本地 optimistic state 被误认为已接受。
- `CollaborativeAssetReadinessGate` 负责 local publish 与 remote apply 的 manifest build / reuse、agreement proposal、copy / upload / download / verify gate；`useCollaborationSession` 只提供 dialog、toast、progress 与 cancellation Adapter。
- `Live2DAssetBundle`、`CollaborativeAssetManifestRules` 与 `CollaborativeAssetScopePolicy` 已抽为共享纯 Module；Live2D recursive dependency closure 也由 `Live2DAssetBundle` 统一处理，客户端 manifest builder、SceneAssetService 与服务端 availability check 只提供 IO / server Adapter。

后续深化机会不改变本 ADR 的决策：如果协作写入继续扩展，应优先让 `TimelineAuthoringService` 向协作层暴露更明确的 ordinary-edit transaction metadata，而不是让 `CollaborativeDocumentLayer` 继续只从 previous / next state 反推用户意图。
