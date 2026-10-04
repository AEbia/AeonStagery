---
status: accepted
---

# SceneVisualBlock as Structured Visual Canon

视觉系统的稳定主数据不再伪装成时间线事件，而是集中放入 `SceneVisualBlock` 这个顶层 `scene.visual` 区块：目标级主数据内聚在 `VisualTargetRegistry`，段级主数据内聚在按 `SegmentId` 寻址的 segment records，`LensSegment` 的时间范围继续由 `LensBoundaryMarker` 规范化推导。我们同时决定“逻辑全量存在、持久化稀疏”：所有 `VisualTarget` 与 `LensSegment` 在逻辑上都可稳定寻址，但 JSON 只写非空 record，派生环境状态如 `LensEnvironmentProfile` 不写盘。这样可以同时保住稳定身份、CRDT 友好性、结构可读性和 scene 文件的稀疏度。

