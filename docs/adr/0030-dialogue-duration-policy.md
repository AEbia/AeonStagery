---
status: accepted
implementation_status: implemented
last_updated: 2026-10-08
---

# 对白时长 Policy Ownership

## 决策

对白时长规则由本地 `src/services/pacing/pacing.ts` 的
`resolveDialogueDuration` 作为唯一 policy 入口。调用方只声明创作语境，不能
自行选择估算函数或复制默认值、范围和文本更新策略。

支持的语境是：

- `manual-default`：时间线 UI 新建对白使用用户设置覆盖；非法覆盖在 policy
  范围内回退到默认值。
- `authoring-insert`：编辑器新建对白保留草稿默认时长，并按当前打字速度和
  入场动画补足逐字显示所需时长。
- `pace-tier`：AI 铺戏、顺序对白流和 authoring 插入按场景节奏档位估算。
  编辑器的顺序追加和插入还会按当前打字设置补足显示时长。
- `reading-speed`：WebGAL 导入按导入时阅读速度估算；该值只在导入时实体化，
  不成为运行时控制。
- `authoring-update`：仅文本改变时，在没有同时手工修改时间或时长的情况下
  按场景节奏重算，并按当前打字设置补足显示时长；手工时间或时长修改优先
  保留 authored duration。修改颜色、角色等其他属性不重算时长。

不同语境可以有意返回不同答案。统一的是 policy ownership 和优先级，不是把
手工默认、节奏档位和阅读速度强行合并成一套公式。

## 边界

`SettingsStore` 只保存和规范化用户设置，并从 pacing 模块复用默认值与范围；
它不是对白时长规则的第二个 owner。AI compiler、WebGAL converter、semantic
authoring 和 timeline UI 都通过 policy 入口取值。

自动补足仅在新增和改文时实体化，不构成最短时长限制。用户可以随后手工
缩短对白；运行时按设置速度逐字显示，播放窗口不足时截断显示，不加速。
修改打字速度设置不追溯重写已有对白时长。非打字机样式不应用逐字显示下限。

现有的 `estimateDialogueDuration` 与
`estimateDialogueDurationByReadingSpeed` 保留为 pacing 模块内的兼容性实现，
不再作为跨模块 policy 入口。

## 后果

- 修改默认值、估算公式或文本更新优先级时，维护者只需修改 pacing 模块。
- 语境差异可以通过 policy 矩阵直接测试，调用方测试只验证其传入的语境。
- 导入与 AI 的时长估算仍使用各自语境；编辑器新增和改文时另考虑当前打字设置。
