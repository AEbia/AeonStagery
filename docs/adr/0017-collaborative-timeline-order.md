---
status: accepted
translated_by:
  - KSM-0003
last_reviewed: 2026-07-20
---

# Collaborative Timeline Order for Same-Time Actions

协作状态中 timeline facts 按 ID 存储，但需要额外保存一条显式 order 序列作为 **Collaborative Timeline Order**。原始决策使用 action 术语；KSM-0003 之后，当前协作事实是 `statementsById` / `statementOrder`，dialogue companions 另有按父 statement 分组的 `companionsById` / `companionOrder`。

## Current Scope Note

本 ADR 的 order 决策仍然有效，并被 KSM-0003 与 ADR-0018 的 transaction planner 继承：普通 time patch 不改变同时间点 **Local Statement Order**；只有显式排序语义才应更新 **Collaborative Timeline Order**。删除 statement 或 companion 时，planner 必须同时移除对应 order id，并通过 **Collaborative Tombstone** 保持 delete-wins。

## Considered Options

1. **Entity map plus collaborative order sequence**: 选用。它保留 ID-backed state，同时不丢失同一时间点 statement / companion 的作者顺序。
2. **Persist `_seq` in SceneScript**: 拒绝。`_seq` 当前是本地逻辑时钟，不应在协作接入中隐式升级成公开 schema。
3. **Sort ties by `_id` only**: 拒绝。ID 字典序不能表达作者对同一时刻动作先后的语义。

## Consequences

- Yjs 状态需要同时维护 `statementsById` 与 `statementOrder`；dialogue companions 维护 parent-scoped `companionsById` 与 `companionOrder`。
- 删除 statement 或 companion 时必须从对应 order 中移除 ID，并写入 tombstone。
- 本地投影可以继续派生 display tie-breaker，但该派生值不是共享事实。
