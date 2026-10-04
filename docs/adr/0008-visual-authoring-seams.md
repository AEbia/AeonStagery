---
status: accepted
---

# Split Visual Authoring Seams and Cross-Seam Transactions

视觉系统确定拆成两个基础 authoring seam 加一个协调层：`VisualAuthoringService` 只负责 `SceneVisualBlock` 等结构化视觉主数据，`TimelineAuthoringService` 继续负责 cue 与 marker，真正同时碰两边的操作再交给 `VisualCompositionAuthoringService` 统一事务化处理。这样做是为了避免任一服务重新膨胀成大一统入口，并为未来协作 / CRDT 保留清晰边界；因此 `VisualCompositionIntent` 首批只保留少数高频、强事务的删除类操作，例如删除 `VisualTarget` 时同时清理相关 cue，或删除 `LensBoundaryMarker` 时保留左段身份并把右段内容降级成正式 cue，而不是制造悬空引用或无声蒸发镜头内容。
