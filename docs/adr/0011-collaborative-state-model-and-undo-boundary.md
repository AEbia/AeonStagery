---
status: accepted
extended_by:
  - ADR-0018
  - KSM-0003
last_reviewed: 2026-07-20
---

# ID-Backed Collaborative State and No Shared Undo

协作场景文档采用 **ID-Backed Collaborative State** 作为共享事实来源，而不是把业务操作日志作为可重放事实。第一阶段协作模式不支持已提交共享变更的 undo / redo；用户仍可在提交前取消本地 preview、草稿或未确认生成结果。

## Current Scope Note

本 ADR 的 ID-backed current state 与 no shared undo 决策仍然有效。ADR-0018 对它做了实现层深化：共享写入应由 authoring seam 降级为 **Collaborative State Transaction**，再由 `CollaborativeStateTransactionPlanner` 规划为 entity-level update 或 tombstone-backed full publish。删除与晚到更新冲突依赖 **Collaborative Tombstone**，而不是 undo log。

## Considered Options

1. **ID-backed current state with no shared undo**: 选用。它贴合现有稳定 ID、authoring seam 和 projection 架构，并避开跨用户 inverse patch 的归属与时序问题。
2. **Shared business operation log**: 拒绝。它会把协作正确性绑定到所有历史业务命令的可重放性，且会绕开现有 state/projection seam。
3. **Collaborative undo per user**: 暂不支持。远端变更穿插后，单用户 inverse patch 很难保证仍表达作者意图。
4. **Global shared undo**: 拒绝。全局撤销会让一个用户撤销另一个用户的已提交操作，authoring 体验不可预测。

## Consequences

- UI 不能直接写 Yjs 状态；共享写入必须从现有 authoring seam 降级成协作状态事务。
- 协作模式下应禁用 committed undo / redo 入口，避免给用户可撤销的错觉。
- 单机 undo / redo 由 `SemanticAuthoringApplicationService` 以 `SceneDocumentV4` 前后快照维护；它不是协作共享事实的一部分，协作模式仍不提供 committed undo / redo。
