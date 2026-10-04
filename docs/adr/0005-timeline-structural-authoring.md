---
status: partially-superseded
superseded_by:
  - ADR-0018
  - KSM-0003
last_reviewed: 2026-07-20
---

# Timeline Structural Authoring

## 状态

Partially superseded. 本文保留 structural authoring 的 intent / receipt / all-or-nothing 事务语义与设计动机；当前 public authoring Interface 已由 KSM-0003 的 semantic statement authoring 接管。

## Current Scope Note

本 ADR 记录的是 Timeline Structural Authoring 的收敛，不是 TimelineAuthoringService 永久只能处理 structural intent 的禁令。

截至 2026-07-17，当前产品 authoring Interface 已由 `SemanticAuthoringApplicationService` 与 `SemanticAuthorIntent` 接管，authoring schema 为 3；v3 增加同时间 statement 的 `beforeStatementId` 稳定插入定位。本 ADR 中的 action-ID `AuthorIntent`、`DocumentHistoryPort` 和旧 resolver/committer 组合保留为历史设计记录，不再是当前实现契约。

当时把普通参数编辑、单 action patch / update、drag / resize 与 transient preview 列为非目标，是为了先保护 `author(intent)` 的 Create / Delete / Structural 事务语义，避免第一阶段总线膨胀。当前这些条目应理解为 ADR-0005 的阶段范围，而不是阻止后续建立普通 action edit Interface。

最新决策见 ADR-0018：`TimelineAuthoringService` 继续保留 `author(intent)` 作为 structural Interface，同时正式拥有独立的 `previewActionEdit` / `commitActionEdit` / `commitActionEdits` ordinary edit Interface。普通 action edit 不进入 structural `author(intent)`，但也不再把 `DocumentAdapter` 当作 timeline UI 的公共 authoring seam。

## 背景

当前时间轴中的“创建、删除、结构变更”能力散落在多个 UI 模块中，例如：

- `TrackArea.tsx`
- `useTimelineDrop.ts`
- `useMarkerManager.ts`
- `TimelineEditor.tsx`
- `useBlockContextMenu.ts`

这些模块直接理解并操作过多底层细节：

- 如何变更 `timeline`
- 如何处理 `markers`
- 何时调用 `pushUndo`
- 何时整段替换 `setTimeline`
- 何时使用角色轨道参数推导 `charId`
- 何时需要生成历史文案

这导致几个长期问题：

1. UI 持有过多 authoring 规则，局部改动容易破坏时间轴不变量。
2. Undo/Redo 语义分散，无法保证所有结构变更都具备一致的历史元数据。
3. Marker、模板展开、资源挂载、作用域注入、默认值补齐、排序/归一化逻辑无法形成统一的可测试流水线。
4. 旧链路大量依赖 index 和整段替换，难以稳定寻址，也难以扩展。

本 ADR 的目标是把 Timeline Structural Authoring 收敛为一个独立服务，并建立受控的 Typed Intent Command Bus，使 UI 只表达意图，不再直接操心结构性 mutation 规则。

## 决策摘要

我们将引入独立的 `TimelineAuthoringService`，其中 structural authoring 的 Interface 固定为：

```ts
author(intent: AuthorIntent): Promise<AuthorReceipt>
```

本次重构同时采纳以下强约束：

1. `TimelineAuthoringService` 必须独立存在，不能把 authoring 语义继续塞回 `DocumentAdapter`。
2. UI 侧结构性写入只允许通过单一入口 `author(intent)`。
3. 总线严格限定在 Create / Delete / Structural Authoring，不覆盖普通参数编辑与 transient 编辑。
4. Intent 与 Receipt 必须强类型、可序列化、可持久化、可测试。
5. 单次 `author(intent)` 必须满足绝对的 all-or-nothing 事务语义，不接受 partial success。
6. Marker 必须拥有稳定持久化 ID，并建立专属规范操作，不再使用 index 定位或整段 `markers` 直写作为 UI 入口。
7. 内部必须显式拆分 Resolver Stage，并由中央 Resolver 严格执行统一“降级流水线”。
8. Policy 与 Execution 必须解耦；Policy 只返回声明式 Patch/Transform 描述，不直接提交底层 mutation。
9. `origin` 只能服务于 history / telemetry / warning 上下文，不能参与核心 authoring 决议。
10. 历史文案必须在 resolve 阶段生成结构化 `historyDescriptor`，而不是由 UI 拼装字符串。

## 目标

本次重构的目标如下：

- 为结构性时间轴编辑建立单一 authoring seam。
- 让 UI 只表达用户意图，不再承担 mutation 细节。
- 将模板展开、资源挂载、作用域注入、默认值补齐、归一化、降级等规则集中到服务内部。
- 统一结构性历史记录、追踪元数据和 warning 回执格式。
- 基于稳定 ID 消灭 marker index 写操作。
- 为后续规则扩展和白盒测试提供可分阶段验证的内部架构。

## 非目标

本 ADR 的第一阶段明确不覆盖以下编辑类型。它们不应进入 structural `author(intent)`；当前普通 action edit 的正式 Interface 由 ADR-0018 接管：

- 普通参数编辑
- 单 action patch / update
- drag / resize
- transient preview
- 播放时实时 scrub 驱动的临时写入
- 非结构性 inspector patch
- 任何“整段替换 timeline”式逃生口

换句话说，本次总线的权限边界是“创建、删除与拓扑结构变更”，而不是“所有编辑”。

## 核心边界

### 1. 独立 Service，避免污染 `DocumentAdapter`

`DocumentAdapter` 仍保留普通文档编辑能力与已有参数级编辑接口，但不再承担 UI 的结构性 authoring 入口职责。

新架构中：

- UI 只依赖 `ITimelineAuthoringService`
- `TimelineAuthoringService` 只读 `IReadonlyDocumentStore`
- `TimelineAuthoringResolver` 生成显式 `ResolvedAuthorPlan`
- `DocumentStructuralAuthoringCommitter` 作为执行 adapter 消费 `ResolvedAuthorPlan`
- `SemanticAuthoringApplicationService` 统一承接 semantic document mutation、undo / redo 与 receipt metadata
- `DocumentAdapter` 不再公开 `pushUndo`、`setTimeline`、`setMetaField` 这类结构性写口给 UI
- UI 通过 `AppContext` 拿到的 document seam 被收窄为 `IUiDocumentAdapter`，只保留参数级 update、undo/redo 等非结构能力
- 文件加载、raw JSON 全景替换等“整场景替换”路径必须走专门的 scene 服务，而不是 UI 直接调用 `DocumentAdapter.loadScene(...)`

这使得 `DocumentAdapter` 不会继续膨胀成一个“同时处理低层 patch 和高层 authoring policy”的混合体。

### 2. Structural Interface 必须是高度结构化、可序列化的 Intent

Structural Interface 固定为：

```ts
author(intent: AuthorIntent): Promise<AuthorReceipt>
```

Intent 必须具备：

- 明确的 `version`
- 全链路 `correlationId`
- `origin`
- 显式 `scope`
- 结构化 payload

Intent 禁止包含：

- 函数
- 闭包
- UI 引用
- 非序列化对象

### 3. `origin` 的作用域被严格限制

`origin` 是显式建模的元数据，但它只能用于：

- history meta
- telemetry
- warning 上下文
- debug / tracing

`origin` 不允许参与：

- 作用域注入策略判定
- 默认值覆盖策略
- 模板展开决议
- 不变量归一化决策
- 删除/插入目标选择

核心 authoring 决议必须仅基于 Intent 本体、场景状态、注册表策略和 provenance 信息。

## 对外协议

### `AuthorIntent`

`AuthorIntent` 是结构性 authoring 的唯一请求协议。第一阶段支持：

- `insert-action`
- `insert-template`
- `paste-actions`
- `duplicate-actions`
- `delete-actions`
- `split-action`
- `add-marker`
- `remove-marker`

所有 Intent 都必须包含：

```ts
interface BaseAuthorIntent {
  version: number;
  correlationId: string;
  origin: AuthoringOrigin;
  scope?: AuthoringScope;
}
```

### `AuthoringScope`

作用域必须显式建模，而不是通过 UI 约定暗传：

```ts
type AuthoringScope =
  | { kind: 'none' }
  | { kind: 'character'; charId: string }
  | { kind: 'inferred-character'; charId: string; source: 'drop-target' | 'blank-menu-track' };
```

这里区分：

- `character`: 用户或上层明确指定的角色作用域
- `inferred-character`: 来自轨道、drop target 等上下文推导出的角色作用域
- `none`: 无作用域

### `AuthorReceipt`

`author(intent)` 必须返回结构化回执，而不是 `void` 或裸 ID：

```ts
interface AuthorReceipt {
  version: number;
  correlationId: string;
  intentType: AuthorIntent['kind'];
  origin: AuthoringOrigin;
  historyDescriptor: HistoryDescriptor;
  warnings: AuthoringWarning[];
  resolvedScope: ResolvedAuthoringScope;
  createdActionIds: string[];
  updatedActionIds: string[];
  deletedActionIds: string[];
  createdMarkerIds: string[];
  deletedMarkerIds: string[];
  createdMarkers: SceneMarker[];
  deletedMarkers: SceneMarker[];
  sideEffects: AuthoringSideEffect[];
  timeRange?: { start: number; end: number };
}
```

回执必须保证：

1. 对结构性结果可直接消费。
2. 对 warning 可直接渲染、记录或分析。
3. 对所有未应用项给出明确说明，而不是隐式吞掉。

### Warning 语义

系统必须保留 warning，并在 receipt 中明确指出“未应用”。建议 warning 至少包含：

- `code`
- `message`
- `severity: 'warning'`
- `details`

其中 `details` 至少应支持表达：

- 哪个阶段产生了 warning
- 哪个实体未被应用
- 原因是什么
- 是否显式为 `applied: false`

例如：

- 作用域不适用于该动作类型
- 资源无法映射到目标字段
- 模板展开后某项被归一化策略拒绝

只要仍能保证整体 intent 一致成功，warning 可以存在；但 warning 不能被解读为 partial success。它表示“该项本就被策略定义为不适用或被降级忽略”，而不是“事务执行了一半”。

## 标识与寻址

### 1. Marker 必须升级为稳定持久化 ID

`SceneMarker` 正式持久化 `markerId`：

```ts
interface SceneMarker {
  markerId: string;
  time: number;
  label: string;
  color?: string;
}
```

这意味着：

- 所有 marker 写操作都使用 `markerId` 寻址
- 禁止再使用 marker index 删除或更新
- 禁止 UI 通过整段 `markers` 数组替换表达语义

### 2. 旧数据兼容策略

`markerId` 必须在 load / normalize 阶段一次性补齐。

允许两种实现策略，二选一即可：

1. 在加载/规范化阶段自动补齐旧数据中的 `markerId`
2. 明确放弃对旧剧本的兼容支持

当前建议采用第一种：在 normalize 阶段一次性补齐，使后续 authoring 流水线不再需要处理“marker 可能没有 ID”的不稳定状态。

### 3. 删除类 Intent 只接受显式稳定目标

第一阶段删除类结构意图只接受：

- `actionIds: string[]`
- `markerId: string`

不接受：

- query 风格删除
- 按 index 删除
- “删除当前选中但由服务自己推断”

这保证 Intent 的可重放性与可审计性。

## 内部中间模型

### 1. 显式阶段对象

服务内部不得直接从 Intent 一步到 DocumentAdapter 调用；必须拆出显式阶段对象。

建议至少存在以下内部对象：

- `DraftAction`
- `ResolvedAuthorPlan`
- `DraftParamTransform`
- `StructuralAuthoringOperation`

这些中间对象必须是纯数据结构，不包含闭包，不绑定 UI，不直接触碰底层提交器。

### 2. `DraftAction` 使用 Anchor + Offset

在 Resolver 内部，时间语义应拆为：

- `anchor`
- `offset`

而不是过早把所有动作都直接拍平成最终绝对时间。

原因：

- 模板展开天然产生相对时序
- paste / duplicate 也更适合以相对偏移表达
- scope / defaults / normalization 阶段不应过早依赖最终绝对时间

最终在归一化或降级阶段才收敛为真正的绝对 `time`。

## 中央 Resolver 与严格流水线

服务内部必须存在中央 Resolver，并强制执行如下严格降级流水线：

1. `Preflight`
2. `Template Expansion`
3. `Resource Resolution`
4. `Scope Application`
5. `Defaults Hydration`
6. `Invariant Normalization`
7. `Operation Lowering`
8. `Commit`

顺序不可随意交换，尤其必须满足：

- 模板展开尽可能早
- 默认值补齐尽可能晚

理由是模板展开后会产生新的原子动作骨架，这些动作必须先经历作用域注入和资源挂载，再做默认值补齐，才能得到正确且最少惊讶的最终形态。

### 阶段说明

#### 1. Preflight

异步前置校验，不修改场景，仅准备运行条件：

- 文件权限校验
- 资源路径解析
- 相对路径计算
- 资产导入准备
- 外部资源元数据探测

#### 2. Template Expansion

模板在此阶段“爆炸”成原始动作集合。

完成该阶段后，后续流水线中不再存在“模板”这一语义实体，只存在一组原始动作骨架。

#### 3. Resource Resolution

将 Preflight 准备好的资源结果挂载到动作草稿的目标字段中。

这一阶段只负责“资源如何附着”，不负责作用域和默认值。

#### 4. Scope Application

由 `ScopeApplicationRegistry` 中注册的 Policy 决定如何为具体动作类型应用作用域。

这里禁止在 Service 层硬编码“总是覆盖”或“只填空”。该决策权必须完全下放给 Policy，并且 Policy 必须能读取 `Provenance Map`。

也就是说：

- 如果参数来自模板
- 如果参数来自 paste
- 如果参数来自 duplicate
- 如果参数已由资源阶段明确写入

Policy 必须能据此决定：

- 覆盖
- 仅填空
- 跳过
- 报 warning

#### 5. Defaults Hydration

默认值补齐要尽量后置。此时动作类型、作用域、资源挂载都已明确，系统可以安全地向 `ActionDefaultsRegistry` 请求默认参数，并填充所有仍为 `undefined` 的空洞。

同时，本阶段负责自动推导 `_explicit`。

#### 6. Invariant Normalization

这是高价值阶段，负责做纯规则与纯数学的不变量对齐，例如：

- 时间对齐与 rounding
- 超界钳制
- 冲突消解
- marker 排序
- 动作排序
- 禁止非法重叠

是否需要更复杂的冲突处理，可在后续阶段继续扩展，但所有结构性 authoring 都必须先经过这一统一归一化面。

#### 7. Operation Lowering

将已经归一化的内存计划降级为底层提交器可以理解的规范操作。

这里输出的是 canonical ops，而不是直接写 store。

#### 8. Commit

通过窄接口提交操作，形成一次原子历史记录。

## 当前实现形态

当前代码已经落成以下显式 seam：

- `TimelineAuthoringService`
  只负责校验入口协议、协调 resolver 与 committer，并生成 `AuthorReceipt`。
- `TimelineAuthoringResolver`
  负责把 `AuthorIntent` 降级为 `ResolvedAuthorPlan`。
- `ResolvedAuthorPlan`
  作为 resolver 与 committer 之间唯一共享的纯数据中间对象。
- `DocumentStructuralAuthoringCommitter`
  负责消费 `ResolvedAuthorPlan`、做最终预校验与原子提交。
- `SemanticAuthoringApplicationService`
  负责以 `SceneDocumentV3` 前后快照承接本地 history stack、undo/redo 状态与 semantic receipt metadata。
- `DocumentStore`
  对外只保留只读 public seam；写入通过内部 `_set*` / `_apply*` / `_insert*` 方法被更高层模块消费。

这意味着：

- `TimelineAuthoringService.author(intent)` 不再直接拼接 commit metadata 后调用底层文档 adapter。
- structural execution 已从 `DocumentAdapter` 中拆出。
- `ResolvedAuthorPlan` 不再只是文档术语，而是实际运行时 seam。

## 邻接但独立的写入边界

本 ADR 明确只收敛“创建、删除、拓扑结构变更”。

`meta.characters` 目录编辑虽然同样属于受控写入，但它不是 structural bus 的职责，不应为了“单一总线”而反向稀释边界。原因是：

- 它主要修改的是角色目录元数据，而不是 timeline 拓扑结构本身。
- 它有自己独立的引用传播规则，例如角色 `id` / `name` / `model` 变更如何映射到 timeline 中的引用字段。
- 如果硬塞进 `author(intent)`，会把本 ADR 已锁定的 structural bus 边界重新扩大。

因此当前实现采用第二条独立但同样受控的 seam：

- `CharacterDirectoryService.apply(command): CharacterDirectoryReceipt`
- `SceneFileService.loadFromPath(...) / loadFromRawJson(...)`

它负责：

- `add-character`
- `update-character-id`
- `update-character-name`
- `remove-character`
- `set-character-color`
- `set-character-model`
- `add-character-variant`
- `update-character-variant-name`
- `update-character-variant-model`
- `remove-character-variant`

并且必须满足：

- UI 不再通过 `setSceneData(...) -> loadScene(...)` 伪装角色目录编辑
- 角色目录写入同样返回结构化 receipt
- 角色目录相关历史记录同样通过受控事务进入统一 undo/redo 栈
- 该服务与 `TimelineAuthoringService` 并列，而不是回流进 `DocumentAdapter`
- Raw Script / 旧 PlayerView 这类整场景替换入口，同样不得直连 `DocumentAdapter`，而是通过 `SceneFileService` 进入受控加载链路

## Policy / Registry / Execution 解耦

### 注册表

服务内部需要显式 Registry，而不是散落的 `switch`：

- `ActionDefaultsRegistry`
- `TemplateRegistry`
- `ScopeApplicationRegistry`
- `ResourceAuthoringPolicy` 或同级策略注册器

这些 registry 背后的 policy inputs 也必须由 authoring module 自己持有，例如：

- action defaults 定义
- template catalog
- structural action catalog

UI 可以消费这些定义来渲染菜单、卡片和提示，但不再拥有它们的源头。换句话说，authoring policy 的所有权属于 `src/services/timeline-authoring/*`，而不是 `src/ui/*`。

### Policy 的职责

Policy 负责回答“应该怎么做”，但不直接执行提交。

Policy 的产物应是声明式的 Patch / Transform 描述，例如：

- 给哪个字段注入哪个值
- 注入来源是什么
- 应否覆盖
- 如果不适用，要产生什么 warning

当前第一阶段已显式实现 `DraftParamTransform`，用于承载作用域与资源挂载等参数级声明式变换。
当前实现中，`TimelineAuthoringService` 已从 authoring-owned definitions 装配 `ActionDefaultsRegistry` 与 `TemplateRegistry`，UI 侧改为反向消费这些定义，而不再作为 policy 源头。

### Execution 的职责

Execution 只负责：

- 应用已决议的 transform
- 做归一化
- 降级为 canonical ops
- 原子提交到底层 committer

这样可以彻底把“规则”与“执行”解耦。

## Canonical Operations

第一阶段允许的规范操作为：

- `insert-actions`
- `delete-actions`
- `split-action`
- `add-marker`
- `remove-marker`

要求如下：

1. Marker 必须使用专属规范操作。
2. 删除动作必须使用显式 `delete-actions`。
3. 不允许 `replace-timeline` 作为结构 authoring 的逃生口。
4. 不允许 UI 通过 `setMetaField('markers', ...)` 表达 marker 语义。

这组 canonical ops 是 UI 与底层 document mutation 之间唯一允许的结构性交换语言。

当前这些 canonical ops 的执行方已是独立的 `DocumentStructuralAuthoringCommitter`，而不是 `DocumentAdapter`。

## 事务与错误模型

### 1. Absolute All-or-Nothing

针对单次 `author(intent)`，系统必须坚持绝对事务语义：

- 要么整个 intent 成功提交
- 要么整个 intent 失败回滚

不接受：

- partial success
- “成功一半并附带失败列表”
- “先插入一部分动作，再留下 warning 表示剩余没做”

### 2. Fatal Error 与 Warning 分离

- `fatal error`: 直接中止整个 intent，不产生 commit
- `warning`: 允许继续，但必须体现在 receipt 中

warning 不代表事务被部分提交；它只表示某些 declarative transform 在策略定义下被明确判定为“不适用”。

## 历史、追踪与文案

### 1. `correlationId` 贯穿整个生命周期

每次 authoring intent 都必须携带 `correlationId`，并贯穿：

- Intent
- Resolver Plan
- Canonical Ops
- Commit Metadata
- Receipt
- Undo / Redo History Entry
- Telemetry / Log

这允许后续做：

- 历史归因
- 调试追踪
- 回放分析
- 跨模块问题定位

### 2. `historyLabel` 在 Resolve 阶段生成

UI 不再直接构造历史文案。

Resolver 必须生成结构化 `historyDescriptor`：

```ts
interface HistoryDescriptor {
  key: string;
  args: Record<string, string | number | boolean | null>;
  fallbackLabel: string;
}
```

优势：

- 可国际化
- 可延迟格式化
- 可用于 telemetry
- 可用于更稳定的测试断言

## Marker 专属建模

Marker 不是“timeline 上一个普通 action”，也不是“meta 上一段可随手替换的数组”。

因此必须为 Marker 建立专属规范操作与专属删除/新增 Intent：

- `add-marker`
- `remove-marker`

并在 Receipt 中返回：

- `createdMarkerIds`
- `deletedMarkerIds`
- `createdMarkers`
- `deletedMarkers`

这让 Marker authoring 与 Action authoring 共享总线，但不再共享错误的底层表示。

## 与 UI 的集成方式

UI 层结构性写入必须收口到 `useTimelineAuthoringService()`：

- drop 插入动作
- drop 插入模板
- blank area paste
- duplicate
- split
- delete
- marker add/remove

UI 的职责只剩：

- 组织 Intent
- 传入显式 scope
- 使用 Receipt 做选区、提示、埋点等后处理

UI 不再负责：

- 推导默认参数
- 手写 undo 文案
- 直接拼 mutation 顺序
- 替换整段 timeline
- 直接操作 markers 数组

## 第一阶段显式排除项

以下能力必须明确排除在本次 structural bus 之外，避免边界膨胀：

- 普通 inspector update
- patch 型参数写入
- drag / resize
- transient preview
- 角色目录元数据编辑

其中“角色目录元数据编辑”并不是重新放回自由写入，而是明确交给独立的 `CharacterDirectoryService` 负责。

如果某能力尚未建模成清晰的结构性 Intent，就不应强行塞进本次总线。

## 测试策略

测试必须同时覆盖白盒阶段测试与黑盒端到端测试。

### 白盒测试夹具

为每个阶段建立独立测试夹具，至少包括：

- `Preflight`
- `Template Expansion`
- `Resource Resolution`
- `Scope Application`
- `Defaults Hydration`
- `Invariant Normalization`
- `Operation Lowering`

这些测试应直接验证：

- 输入 Draft / Intent
- 输出 Plan / Transform / Warning / Ops
- provenance 对策略判定的影响

### 黑盒端到端测试

保留 `author(intent)` 级别的黑盒测试，验证：

- 返回 receipt 结构
- history metadata 完整
- markerId 行为稳定
- split 返回 `updatedActionIds`
- delete 返回 `deletedActionIds` / `deletedMarkerIds`
- warning 被正确保留
- all-or-nothing 语义成立

### 防回退守卫

需要同时使用 lint 与 tests 防止 UI 回退到旧结构写法。守卫目标包括：

- UI 直接调用 `setTimeline(...)`
- UI 直接调用 `setMetaField('markers', ...)`
- UI 直接进行结构性 `pushUndo() + add/delete/paste`
- UI 使用 index 删除 marker

当前实现中，守卫测试已从“指定文件名单”升级为扫描整个 `src/ui` 目录树，并显式拦截 `documentAdapter.addAction(...)` / `documentAdapter.duplicateAction(...)` 等结构性旧入口。
同时，`useDocumentAdapter()` 的返回类型已经收窄为 `IUiDocumentAdapter`，把结构性旧写口以及 `loadScene(...)` 这类整场景替换口在类型层直接移出 UI seam。

## 迁移策略

迁移遵循“先搭骨架，再迁入口”的顺序。

第一批迁移目标：

- library insert
- drag/drop 插入
- paste
- duplicate
- delete
- split
- marker add/remove

迁移后要求：

- 结构性 UI 入口全部转向 `author(intent)`
- `replace-timeline` 不得作为新链路的实现手段
- Marker 删除一律使用 `markerId`

普通编辑链路不进入 structural `author(intent)`；当前应通过 ADR-0018 定义的 `Timeline Action Edit Interface` 进入 `TimelineAuthoringService`。

当前 UI 中的 `split` 已提升为独立的 `split-action` intent，并通过 `TimelineAuthoringService.author(intent)` 进入同一条结构事务链路。
`TimelineListView` 中原本通过整场景 reload 完成的角色目录编辑，也已迁移为 `CharacterDirectoryService.apply(command)`，不再借道 `setSceneData`.

## 预期收益

完成本 ADR 后，系统将获得以下收益：

1. UI 表达的是意图，而不是 mutation 脚本。
2. 时间轴结构不变量有单一落点。
3. Undo/Redo、历史标签、追踪元数据得到统一。
4. Marker、模板、资源、作用域、默认值等规则能以白盒方式稳定测试。
5. 未来若继续扩展 structural intent，不需要再向 UI 派发更多底层写入知识。

## 当前已锁定但仍需持续落地的约束

以下条目已经确定，不应在后续实现中被悄悄放松：

- `TimelineAuthoringService` 独立存在
- Structural Interface 固定为 `author(intent)`
- 结构性总线范围仅限 Create / Delete / Structural Authoring
- `origin` 不参与核心决议
- Marker 使用持久化 `markerId`
- `split-action` 必须坚持稳定 `actionId` 寻址，并在 receipt 中返回 `updatedActionIds`
- 删除结果必须返回 `deletedActionIds` / `deletedMarkerIds`
- warning 必须保留，并在 receipt 中明确说明未应用
- 历史文案由 resolve 阶段生成 `historyDescriptor`
- Policy 必须可读取 provenance map
- 单次 intent 必须 all-or-nothing
- Policy 与 Execution 必须显式解耦
- 阶段对象必须显式建模
- 必须保留白盒阶段测试与黑盒总线测试
- UI document seam 必须持续维持窄接口，不重新暴露结构性 `add/delete/paste/duplicate` 能力
- UI hooks 不得重新暴露 `setSceneData` 这类整场景回写逃生口
- 结构性执行不得重新回流到 `DocumentAdapter`
- `ResolvedAuthorPlan` 必须持续作为 resolver 与 committer 之间的唯一中间 seam

## 后续工作

本 ADR 只定义结构性 authoring 总线的目标形态与边界，不等于普通编辑路径应被排除在 `TimelineAuthoringService` 之外。

后续若要继续演进，可分别建立独立 ADR 处理：

- 普通 patch/update Interface 的继续深化
- merge 等后续复合结构编辑
- 参数级 authoring provenance
- 更复杂的时间冲突消解策略
- 更强的 lint 规则与静态分析
