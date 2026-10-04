---
status: accepted
extended_by:
  - ADR-0018
  - KSM-0003
last_reviewed: 2026-07-20
---

# Collaborative Document Layer Above DocumentStore

协作接入不直接用 Yjs 替换 `DocumentStore`。协作模式新增 **Collaborative Document Layer** 作为共享事实来源；它接收现有 authoring seam 降级后的协作事务，更新共享状态，并派生 `SceneScript` 快照写入本地 `DocumentStore`，再由现有投影层刷新运行时。

## Current Scope Note

本 ADR 的层次方向仍然有效：`DocumentStore` 是 materialized read/projection model，不是共享事实来源。ADR-0018 已把 `Collaborative Document Layer` 内部的 diff 规划、publish 执行与资源 readiness 拆成更深 Module：`CollaborativeStateTransactionPlanner`、`CollaborativeStatePublishExecutor`、`CollaborativeStateTombstones` 与 `CollaborativeAssetReadinessGate`。后续协作扩展应继续把纯规则放在这些 Module 或新的纯规则 Module 中，`Collaborative Document Layer` 只负责房间生命周期、materialization 与 Adapter 编排。

KSM-0003 已把共享事实从 action-backed scene state 切到 semantic statement state。本文中的 `SceneScript` 派生快照应按历史语境理解；当前 materialization 先得到 `SceneDocumentV4` source facts，再经 semantic codec / compiler / runtime asset preparation 投影到本地 read model 和 prepared runtime。

## Considered Options

1. **Collaborative layer above DocumentStore**: 选用。它保留现有 UI read model、`SceneScript` 投影路径、单机模式和保存格式。
2. **Replace DocumentStore with Yjs maps**: 拒绝。这样会把 UI、projection、validation、autosave 和 tests 全部拖进 Yjs 细节。
3. **Let UI write Yjs directly**: 拒绝。它会绕开现有 authoring seam、policy、history metadata 和 structural guards。

## Consequences

- 协作模式下 `DocumentStore` 不再是共享事实来源，只是 materialized read/projection model。
- 本地写入和远端更新都应经过同一套 materialization 路径刷新 `DocumentStore`。
- `DocumentProjectionCoordinator` 不需要知道 Yjs；它继续消费 `SceneScript`。
