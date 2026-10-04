---
status: accepted
extended_by:
  - ADR-0028
---

# Optimistic Collaboration with Presence Instead of Hard Locks

协作编辑第一阶段采用乐观合并策略，不对 action、marker、visual target 或 segment 加硬锁。UI 通过 presence 显示协作者的位置和编辑意图；不同字段的并发修改可以合并，同一字段并发修改接受协作状态的最终结果，删除与晚到更新冲突时删除优先。

> Current reading: 普通协作编辑继续遵守本 ADR；ADR-0028 仅为内联自定义 Motion
> 创作增加角色表演实体级的服务端租约，因为该高密度编辑对象当前按完整 statement
> 或 companion 发布，不能安全地按轨道或关键帧乐观合并。

## Considered Options

1. **Optimistic editing with presence**: 选用。它保持实时 authoring 的流动性，符合现有稳定 ID 与 authoring seam 设计。
2. **Hard locks**: 拒绝。锁会增加占用、释放、断线恢复和误锁处理成本，也会让细碎时间线编辑变得笨重。
3. **Soft locks with warnings**: 暂不作为第一阶段规则。presence 已能表达“有人在这里”，后续可在高风险操作上加局部 warning。

## Consequences

- Presence 不能被当作权限或互斥机制使用。
- 同一字段的最终值可能由最后到达的协作状态决定，UI 应尽量让用户看见远端变化。
- 删除操作需要具备 tombstone 或等价防护，避免晚到更新把已删除对象重新带回共享状态。
- 第一阶段 tombstone 可以随 room 持久化；未来如果要清理 tombstone，需要单独设计 compaction 流程。
- 本地未提交 preview 如被远端 committed state 影响，第一阶段取消 preview 并回到最新服务端状态，不做自动 rebase。
