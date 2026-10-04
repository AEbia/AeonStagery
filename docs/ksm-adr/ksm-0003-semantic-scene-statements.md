---
status: accepted
last_verified: 2026-08-13
implementation_status: accepted; runtime-ui-deletion-documentation-gates-complete; schema-v4-cutover-and-v3-load-time-migration-complete
---

# Semantic Scene Statements and Intent-Oriented Timeline UI

当前 scene JSON 直接把运行时 `ActionType` 暴露给创作 UI，同时又把持久化输入、编辑器状态和运行时动作放在同一个 `SceneAction` 类型里。结果不是单纯“菜单太长”，而是 authoring Interface 与 runtime implementation 混在了一起：调用方必须知道旧 action 名、默认参数、兼容 alias、seek 状态和 scheduler 细节，任何新增能力都要在多个位置同步修改。

本 ADR 决定把 timeline 的持久化事实改为语义化 `SceneStatement`，并建立从 source document 到 immutable compiled scene 的单向编译 seam。目标是让创作 UI、保存、协作和模板只理解作者语义，让 `ScriptEngine`、seek、bake 和 export 只理解编译结果。

AeonStagery 尚未正式发布。本次 schema 切换不在生产加载路径中保留旧 action alias，也不要求新 schema 无损读取未版本化 scene。测试 fixture、默认模板和开发项目随实现一次迁移；需要转换历史开发文件时使用显式离线迁移工具，而不是把兼容分支留在 runtime。

## Initial Verified State (2026-07-13)

本决策在 2026-07-13 以本地 `dev` 代码为基准核实了迁移起点。下列表格保留这些起始问题作为决策依据，不代表当前实现仍原样保留所有旧 seam：

| Area | Verified behavior |
|---|---|
| Source/runtime 混用 | `src/api/types/scene.ts` 的 `SceneAction` 同时包含 `time`、`delay`、`_id`、`_seq` 和 `_explicit`；`SceneCompiler.compile()` 把稀疏输入变成编辑/runtime 对象，`decompile()` 又从该对象猜回保存格式。 |
| 多份动作事实 | 50 个 `ActionType`、`AUTHORING_ACTION_CATALOG`、`AUTHORING_ACTION_DEFAULTS`、Inspector 的手写 `<select>`、`SceneValidator` switch 和 `actionSchedulers` 分别维护自己的清单。当前 Inspector、插入目录、validator 与 scheduler 已经不一致。 |
| Alias 已进入 runtime | `moveCharacter` / `transformCharacter` 共用 scheduler；背景动作在 compile 时迁移为 `layerId: 'background'` 的环境层动作；`cameraMove` / `cameraFollow` 明确走 backward-compat 路径。 |
| 状态解析不只在 scheduler | visual recipe 动作在 scheduler 中是 no-op，由 `VisualStateResolver` 解析；lighting scheduler 只放时间标记，真实状态由 `LightingSnapshot` 扫描 timeline 得出。 |
| Load/save 不能证明 source 合法 | `SceneFileService` 先 `JSON.parse` 再 compile，随后即使 validator 返回 error 也会 replace/project；scene 顶层没有版本字段，unknown action 没有统一的 fatal gate。 |
| ID 契约互相冲突 | `decompile()` 保存时不写 action `_id`，而协作 seed 强制每个 action 有 `_id`。新模型若只有 companion ID、没有 root statement ID，无法形成稳定协作事实。 |
| 生命周期不完整 | 文本图层有 set/transform/remove，图片只有 add；overlay 与 point light 没有稳定对象 ID，所谓 remove/clear 不能可靠删除单个对象。 |
| Preview/export 不等价 | BGM、对白语音和部分 timeline audio 走不同路径；当前 `AudioMixer` 不消费 `playAudio` / `stopAudio`，不能仅靠重命名保证导出与预览一致。 |

现有 `src/services/timeline-authoring/definitions/*` 已经把插入目录和默认值部分收口，因此问题不是“完全没有 registry”，而是 author-facing definition 还没有覆盖 Inspector、runtime schema、validator 和 compiler，也没有建立 source/compiled 类型隔离。

## Final Acceptance (2026-07-28)

KSM-0003 的 inventory、source、compiler、runtime、state、collaboration、template、UI、deletion 与 documentation gates 已完成：

- rim-light baseline、set、finite modulate、reset、同时间顺序、seek 与 bake/playback 使用同一 resolver，并有 parity tests；
- 相机 position/zoom/rotation 通道生命周期由确定性 resolver（`src/engine/CameraStateResolver.ts`）重建：任何写入者之前的区间回舞台基线、`cameraFollow` 在 playback/seek/export 持有同一 position 通道所有权直到 stop/reset；GSAP 只在 playhead 穿越 tween 窗口时重渲染，因此 seek 落点在所有相机 tween 结束之后的区域时，`CameraCoordinator` 必须整体硬设解析器状态（GSAP 仅播放期权威）；
- follow 进入过渡同样属于 parity 契约：resolver 以 `position(t) = target + (preFollow − startTarget)·e^(−λ(t−s))`（λ=−60·ln(smoothing)，默认 0.85，目标按段 zoom 视口钳制、滑行值不钳制）镜像 `tickFollow()` 的指数趋近，seek 落入追随入口窗口呈现中间态而非终态；duration 到期与显式 unfollow 一样锁定最后滑行帧，起始锚点经 `resolveCharacterPositionAtTime` 取追随开始时刻的语句位置；
- runtime timeline representation 与 prepared adapter 位于 engine 内部，产品只从 `loadPreparedScene()`、`bakePrepared()` 和 `bakePreparedRange()` 进入；legacy background/camera scheduler alias 已删除；
- legacy scene migrator/types 只位于 `scripts/migrations/legacy-scene`，normal loader 与产品 barrel 不导出该边界；
- camera、visualStyle、lighting Inspector 与 timeline 专用描述直接消费 semantic metadata/source params；
- scene schema 已升级为 v3；镜头滤镜改由 `filterAdd`、`filterChange`、`filterReset` 三个 source family 表达，并覆盖严格拒绝、类别冲突、编译、runtime 过渡与 preview/export parity；
- Dialogue Inspector 支持 companion create/edit/delete/reorder、`$speaker`、anchor/offset 与 family-specific params，reorder 是单 transaction/history entry；
- template catalog 的 `statementPreset`、`dialoguePreset` 与 `timelineFragment` 都先生成纯 preview，确认提交 preview 持有的同一 intent，取消不产生 transaction；
- builtin 只保留 `manifest.v2.json`；tracked-data guard 确认仓库没有 scene/dev-project JSON，并阻止旧默认 manifest 回流；
- ADR-0004、ADR-0009、ADR-0019 与 KSM-0001 已同步当前 source/runtime/migration 边界。

自动对白镜头生成仍是产品功能延期项，不属于本迁移 gate。

## Reopened Compatibility Design (Draft, 2026-07-29)

本节记录对 scene compatibility versioning 的进行中重审；在该设计完成并重新验收前，下文现有的 `schemaVersion === 3`、template exact-match 与 mixed-version collaboration rejection 仍是当前实现契约。

已确定的兼容性原则：Scene Document 与 semantic template payload 是否可被消费，取决于它实际要求的 semantic capabilities，而不是创建它的客户端发布版本。较新客户端产生、但只使用旧客户端已支持 capabilities 的 source，应在 document envelope 与既有 statement 编译语义兼容时继续可读；实际使用未知 family/mode 的 source 仍必须在任何事实或 runtime 状态改变前拒绝。

statements 及其 discriminators 等 source facts 是 capability requirements 的唯一事实来源；versioned definitions 必须从这些 facts 确定性推导 requirements。Template manifest、collaboration room 或其他外壳若为快速准入保存 capability summary，该 summary 只是 projection，消费前必须与 source 重新验证；缺失、残留或不一致都必须在任何事实或 runtime 状态改变前拒绝。collaboration room 如何协商 capabilities 仍待决定。

一个 capability 对应 consumer 能够完整 parse、validate 和 compile 的最小 source construct，并以 syntax revision 表达该 construct 的 source-language 演进。versioned definitions 必须依据实际出现的 discriminators、字段和取值推导最低充分 revision；新增可选字段不能使未使用该字段的 source 失去旧 consumer 兼容性。syntax revision 不承载同一 source shape 的编译行为变化，后者属于独立 semantic profile。既有 statement semantic profile 的选择，以及 collaboration room 如何协商 capabilities，仍待决定。

Semantic Profile 是 Scene Document 的显式 source fact，按 source construct 固定 semantic revision；同一 document 中同一 construct 的所有 statements 必须使用同一 revision。单个全局 semantic revision 会让无关 constructs 一起升级，statement-local revision 则会允许相同 source shape 在同一 scene 中产生混合语义，二者均不采用。

authoring 在 document 中首次使用某个 construct 时选择当前 semantic revision；后续创建的同类 statements 必须继承已经固定的 revision。升级已有 construct 必须是显式、document-wide、all-or-nothing migration：在 detached working copy 中迁移所有相关 source facts，通过 codec、semantic validation 与 compile 后才原子替换，不能在普通 edit、load 或 collaboration apply 中混入逐条静默升级。旧 revisions 的支持期限、profile 的持久化表示，以及 collaboration room 如何协商 capabilities，仍待决定。

该 draft 未被验收；2026-08-13 的 v4 cutover 已由其后的新章节决定——`schemaVersion === 4` 是当前契约，`schemaVersion === 3` 开发期文档经确定性迁移后按 v4 严格校验，template exact-match 与 mixed-version rejection 规则继续有效。

## Schema v4 Cutover And V3 Load-Time Migration (2026-08-13)

本节记录 2026-08-13 的 scene schema v4 切换与 v3 加载时迁移决策。canonical statement family 表（§4 的 14 个 family）保持不变；`live2dParameterClip` 从未获许可进入该表，它只存在于 feature branch，现已连同其 `applyLive2DParameterClip` runtime action 一起删除（设计该 Clip 的 ADR-0027 标记为 superseded）。

- `SCENE_SCHEMA_VERSION` 现为 `4`。`characterPerformance` 的 Motion 来源改为判别联合 `{ kind: 'resource' | 'custom' }`；`characterPerformance.params` 顶层不再有 `durationSeconds`、`loop` 或 `priority`。普通资源 Motion 对 scene end 的贡献为 `0`，自定义 Motion 贡献其 `durationSeconds`。
- v4 codec 是严格 codec，对旧形状不宽容、不规范化。加载 `schemaVersion === 3` 的文档时，`SceneDocumentCodec.parseAndValidateWithWarnings` 先执行显式且确定性的 `SceneV3ToV4Migration`，再把迁移结果交给严格 v4 校验：
  - 裸字符串 motion 与无 `kind` 的 `{ key, fadeInSeconds? }` 改写为 `{ kind: 'resource', ... }`；
  - `characterPerformance` 顶层 `durationSeconds` 在它（或自定义 Motion 的时长、或被移除 Clip 的时长）决定旧场景结尾时并入 `meta.durationSeconds`，并入只增不减；
  - 默认 `loop: false` / `priority: 3` 静默丢弃；非默认值丢弃并产生迁移警告；
  - `live2dParameterClip` statement 与 companion 被移除，并产生带其 id 的迁移警告；
  - 迁移警告以 `severity: 'warning'` 的加载结果 issue 呈现。
- §1 与 §9 的严格拒绝规则只对 `schemaVersion === 3` 的开发期文档作上述迁移例外；v1、v2 与未版本化文档仍由普通加载器严格拒绝（"older scene schemas must be migrated offline"），`scripts/` 下的离线迁移工具现在输出 v4 文档。
- §2 的 scene end materialization 要求由该迁移的 `meta.durationSeconds` 并入满足：原本决定场景结尾的时长不会消失，迁移后场景总长度不缩短。
- "Reopened Compatibility Design (Draft, 2026-07-29)" 仍是草案，未约束本次切换。

## Relationship To Existing ADRs

本 ADR 不重新讨论以下当前实现与已记录方向；KSMADR-0001 已与本 ADR 一起验收，并固定 template package/resource 与 versioned semantic payload contract：

- ADR-0004 的 `SceneFileService` I/O seam 保留；source codec、验证顺序和保存对象已切换到 semantic source contract。
- ADR-0005 与 ADR-0018 的 structural/ordinary edit、receipt 和 all-or-nothing 事务语义保留；legacy `TimelineAuthoringService` 与 action edit Interface 已由 semantic authoring application service 替代，实体从 action 改为 statement。
- ADR-0007 与 ADR-0008 的 `SceneVisualBlock`、`VisualAuthoringService` 和 semantic visual composition seam 保留；旧 action-based `VisualCompositionAuthoringService` 已删除，timeline statement 不能吞掉结构化 visual 主数据。
- ADR-0009 的 canonical environment layer 与保留 `background` LayerId 继续有效；本 ADR 只删除旧背景 action sugar。
- ADR-0014 与 ADR-0018 的 project-relative asset reference 和 collaboration readiness gate 继续有效。
- ADR-0011 的 ID-backed shared state 与 no shared undo 继续有效。
- ADR-0015 至 ADR-0017 的 Collaborative Document Layer、服务端事实来源和同时间显式顺序继续有效。
- KSMADR-0001 的 template package、source precedence、资源 projectize 与三种 semantic payload 规则继续有效。
- ADR-0019 的 Live2D runtime Adapter 与 bundle 规则继续有效。

本 ADR 已局部替代三项旧说法：ADR-0004 中“compile 负责给持久化 action 补 ID”、ADR-0009 中“旧背景 action 可在普通加载路径迁移”、ADR-0019 中对外 authoring 名固定为 `addCharacter` / `playMotion` / `setExpression`。这些 action 名仍可作为内部 compiled action，不能继续作为 scene JSON 契约。

## Decision

### 1. Source Document And Compiled Scene Are Different Types

新的持久化 schema 固定为 `SCENE_SCHEMA_VERSION = 4`。未提供 `schemaVersion` 的文件视为 legacy；v2 scene 不迁移、不部分加载，也不静默跳过旧镜头语句。`schemaVersion === 3` 的开发期文档由显式 v3→v4 加载时迁移处理后按 v4 严格校验（见下文 "Schema v4 Cutover And V3 Load-Time Migration (2026-08-13)" 一节）；v1/v2 与未版本化文档仍须由离线迁移工具处理。

```ts
export const SCENE_SCHEMA_VERSION = 4 as const;

interface SceneDocumentV4 {
  schemaVersion: typeof SCENE_SCHEMA_VERSION;
  sceneId: string;
  meta: SceneMetaV4;
  visual?: SceneVisualBlock;
  statements: SceneStatement[];
}

interface SceneMetaV4 extends SceneMeta {
  durationSeconds?: number;
}

interface StatementBase<Family extends StatementFamily, Params> {
  id: string;
  time: number;
  type: Family;
  params: Params;
}

interface CompiledScene {
  readonly sourceSchemaVersion: typeof SCENE_SCHEMA_VERSION;
  readonly sceneId: string;
  readonly meta: Readonly<SceneMetaV4>;
  readonly visual?: Readonly<SceneVisualBlock>;
  readonly durationSeconds: number;
  readonly actions: readonly CompiledAction[];
}

interface CompiledAction {
  readonly id: string;
  readonly time: number;
  readonly action: RuntimeActionType;
  readonly params: RuntimeActionParams;
  readonly source: {
    readonly statementId: string;
    readonly companionId?: string;
    readonly outputKey: string;
  };
}

interface PreparedAssetRef {
  readonly source: string;
  readonly runtimeUri: string;
}

type PreparedCompiledAction = Omit<CompiledAction, 'params'> & {
  readonly params: PreparedRuntimeActionParams;
};

type PreparedCompiledScene = Omit<CompiledScene, 'actions'> & {
  readonly kind: 'prepared-compiled-scene';
  readonly actions: readonly PreparedCompiledAction[];
};
```

`SceneDocumentV4` 是保存、Raw Script、普通 authoring 和协作 materialization 的数据。`CompiledScene` 是纯语义 lowering 结果，仍持有 portable resource references；`PreparedCompiledScene` 是 runtime asset Adapter 把每个 asset slot 转换为 `PreparedAssetRef` 后返回的 branded runtime 输入。`RuntimeAssetPreparer.prepare(compiled)` 必须返回新的 deep-immutable object，不能原地修改 source 或 compiled scene。semantic preview、seek、playback、bake 和 export 的 public path 只接收 `PreparedCompiledScene`；runtime 内部可以从 prepared scene 生成 detached scheduler representation，但该 representation 不得重新成为 source/document Interface。

source、compiled 与 prepared 三者不共享 statement/action 数组，也不允许 runtime 把默认值、解析路径或运行状态写回前一层对象。

`DocumentStore` 在单机模式保存 `SceneDocumentV4` 的 source facts；协作模式下它仍是 Collaborative Document Layer 派生的 materialized read model，不升级为共享事实来源。compiled scene 由 projection 层按 source version 缓存，不能成为保存或协作输入。

`SceneDocumentV4` 不再保存顶层 `audio.bgm`。初始 BGM 是 `time: 0` 的 `audio` statement，后续切换/停止使用同一 family，从而删除“顶层 BGM 与 timeline setBGM 谁优先”的双事实。

### 2. Persistent Identity, Time And Ordering

- 每条 root statement 必须有持久化、scene 内唯一的 `id`。不再使用“load 时随机补 `_id`”作为正常路径。
- statement 使用绝对 `time`，单位为秒；不再持久化 `delay`、`_seq` 或 `_explicit`。
- JSON 中 `statements` 的数组顺序是同时间语句的 author order。协作状态以独立 `statementOrder` 保存同一事实。
- 每个 lowerer 输出命名的 `outputKey`。同一 root/companion 的 output keys 必须唯一，并在 scene schema version 内稳定。compiled ID 由带字段 tag 的 `(statementId, companionId?, outputKey)` UTF-8 byte-length-prefixed tuple encoding 可逆生成，compiler 还必须对最终 ID 集合做 uniqueness assertion；禁止依赖数组 index、展示名称、易碰撞 hash 或模板顺序。
- compiled actions 按 `(time, statementOrder, primary/companion order, lowerer output order, compiled id)` 稳定排序。root primary output 先于其同时间 companions，companions 再按显式 order 排序。
- 复制或模板应用生成新的 root statement ID。companion ID 只要求在父 statement 内唯一，因此复制父 statement 时可以保留语义 companion ID；compiled ID 仍因新父 ID 而不同。

`wait` 不再是 statement。`meta.durationSeconds` 若存在，表示显式 scene 结束时间，必须大于等于所有 root/companion 的计算结束时间；若缺省，则由最后一个 statement/companion 的结束时间派生。这样可以表达尾部留白，又不需要伪装成 runtime action。

每个 statement variant 必须在 definition 中提供纯 `temporalExtent(params)`，返回该 statement 对 scene end 的有限 duration contribution。它描述 transition/envelope/可见或可听内容时长，不描述 latching state 的存活期：follow、BGM、lighting preset 等状态可以持续到后续 statement，但不能让 scene end 变成 Infinity。任何会影响 scene end 的 motion、SFX、voice 或 animation 资源时长都必须在 authoring/import 时 materialize 为 source 中的显式 duration；compiler 不通过文件探测猜时长。

### 3. Compilation Is One-Way And Deterministic

`SceneStatementCompiler.compile(document)` 是单向 Module，不提供 `decompile()`。它必须满足：

1. 输入已经通过 source schema validation；compiler 不接受 `Record<string, any>` 式半合法对象。
2. 同一 document 与同一 versioned definition 必须产生字节语义等价、ID 和顺序稳定的结果。
3. compiler 可以解析 `$speaker`、角色 metadata、statement companions 和 schema 固有默认值，但不能读取当前模板优先级、用户设置或文件系统。
4. 模板建议值和项目默认值只在创建 statement 时由 `SceneStatementFactory` materialize 到 source。模板更新不能改变已有 statement 的编译结果。
5. 只有被 schema 明确定义、且在该 schema version 内不可变的 intrinsic default 可以在 compile 时补齐。
6. source 保存 project-relative asset reference。模板相对路径必须在插入前通过 template application/resource seam 转成项目引用；compiler 不把 template id、绝对路径或当前外部库扫描结果写进 source。
7. runtime 路径解析由 `ProjectResourceService` / runtime asset Adapter 完成。preview、bake 和 export 必须消费同一份 compiled scene 和同一资源解析规则。
8. 任一 `$speaker`/target 等语义引用、family/mode 或 lowerer 输出无法解析时，整个 compile 失败，不产生可投影的半成品。asset reference 在本阶段只验证 portable syntax；存在性与 runtime URI 解析属于 `RuntimeAssetPreparer`。

`SCENE_SCHEMA_VERSION` 同时冻结 source shape 与 observable compilation semantics，包括 intrinsic defaults、state keys、`temporalExtent`、lowerer mapping、output keys 和稳定排序。任何会改变同一 source document 编译结果的修改都必须 bump scene schema；仅保持结果等价的 implementation refactor 不需要新版本。

原 `SceneCompiler.compile/decompile` 混合了 legacy migration、默认值、ID 补全、稀疏化和 runtime lowering。新实现必须拆成：

```text
raw JSON
  -> SceneDocumentCodec.parseAndValidate
SceneDocumentV4
  -> SceneStatementCompiler.compile
CompiledScene
  -> runtime asset preparation
PreparedCompiledScene
  -> ScriptEngine / BakeEngine / export
```

### 4. Canonical Statement Families

只有目标身份、状态 key 和生命周期相同，且差异能由 discriminated union 完整表达的语义才进入同一 family。每个 `(family, mode/effect)` 都有独立 params schema，不允许把下表实现成一个巨型可选参数对象。

| Family | Discriminator and invariant | Replaces current facts |
|---|---|---|
| `dialogue` | 说话人、文本、语音、样式、必需的 `durationSeconds` 与可见 companions | `dialogue` |
| `characterPresence` | `mode: enter \| exit`；稳定 character id、模型/variant 与入退场过渡 | `addCharacter`, `removeCharacter` |
| `characterTransform` | position、scale、rotation、opacity、z、duration、easing；省略字段表示保持当前值 | `moveCharacter`, `transformCharacter` |
| `characterPerformance` | motion、expression、lookAt、blink 的 typed partial，至少一项；一次 authoring transaction 可 lower 为多个 named outputs | `playMotion`, `setExpression`, `characterLookAt`, `characterBlink` |
| `camera` | `mode: focus \| move \| follow \| path \| shake \| hitchcock \| reset`；每个 mode 有独立 schema 和状态通道 | 全部 `camera*` actions |
| `environmentLayer` | `mode: set \| transform \| remove`；稳定 `layerId`，`background` 是保留主背景 ID | 背景和环境层六个 actions |
| `visualStyle` | 只允许 `scope: object`；target、slot、`mode: set \| modulate \| reset` 与角色融入 recipe/override | object/composite recipe 与角色融入语句 |
| `filterAdd` | 必须有 `recipeId`；类别由 recipe catalog 推导；目标类别已有滤镜时失败 | 镜头添加滤镜 |
| `filterChange` | 必须有 `fromRecipeId` 与 `recipeId`；允许跨类别替换；当前滤镜不存在或目标类别冲突时失败 | 镜头变化滤镜 |
| `filterReset` | 不接受模板；清除全部镜头滤镜并回到 segment baseline/neutral default | 镜头重置滤镜 |
| `lighting` | `effect: preset \| blur \| godrays \| post \| overlay \| pointLight`，每个 effect 再以 typed mode 表达 singleton 或 collection 生命周期 | 当前 lighting/post/light actions |
| `audio` | `role: bgm \| sfx`、`mode: play \| stop`；BGM 是 singleton，SFX 是稳定 instance id 的 collection | 顶层 BGM、`playAudio`, `stopAudio`, `setBGM` |
| `graphicLayer` | `kind: image \| text`、`mode: set \| transform \| remove` 与稳定 layer id | `addImage` 和文本图层三个 actions；需先补图片完整生命周期 |
| `customAnimation` | 声明式 animation resource、稳定 target layer 与 duration | `playCustomAnimation` |

`custom` 被删除。未来扩展必须由单独的 plugin/permission ADR 定义签名、权限、sandbox 和 versioning，不能接受任意 JSON 再在 runtime 打印 unknown action。

#### Character Performance Atomicity

`characterPerformance` 的“原子”指 source edit、history、undo 和协作 transaction 原子，不表示 runtime 只生成一个 action。lowerer 为 motion、expression、lookAt、blink 生成稳定 `outputKey`；各 runtime effect 仍保留 event/latching/seek 语义。缺省字段表示不改变该状态，不允许 compiler 用当前 UI 默认值补齐并意外重置其他状态。

#### Camera State Contract

camera family 不能只把旧 action 名塞进一个 `mode` 字段，还必须固定状态生命周期：

- `focus` / `move` / `path` / `hitchcock` 竞争 camera transform channels；相互重叠写同一 state key 是 validation error，除非 definition 明确声明可组合。
- `shake` 是可叠加的有限 envelope，不取得持久 transform ownership。
- `follow` 使用 `operation: start \| stop`，不再用 `duration: 999` 或 Infinity 暗示生命周期。follow start 持有 position channel，直到同一 camera family 的 follow stop 或 reset 释放；在此期间任何写 position 的 focus/move/path/hitchcock 都必须先按 statement order stop follow，否则 validation error。只写 disjoint zoom/rotation keys 的操作可在 definition 明确声明后并行。
- `reset` 复位 position/zoom/rotation，并终止 active follow 与未结束 shake。该语义必须同时用于 playback、seek 和 bake。
- zoom 必须写成 `{ kind: 'absolute' | 'delta', value: number }`。禁止继续让裸 `zoom: 0.3` 同时承担“目标缩放 0.3”与“推进 0.3”的两种解释。
- 同时间 camera statements 按 statement order 执行；registry 的 overlap/state-key validator 必须给出确定结果。

#### Environment State Contract

`environmentLayer` 沿用 ADR-0009：`layerId` 是稳定身份，`background` 只是一条保留 ID。transform/remove 必须引用已经存在或在同时间更早创建的 layer；同一 layer 的 transition 不得重叠；set/transform/remove 的中间态必须在 seek、scrub、preview 和 bake 中一致。

#### Visual And Lighting Contract

`scene.visual` 继续保存 VisualTarget、segment baseline 和 recipe overlay 等结构化主数据；`visualStyle` statement 只处理 object scope 的角色融入与对象视觉 cue。它不取代 `VisualAuthoringService`，也不把跨 visual/timeline 写入从 `VisualCompositionAuthoringService` 抢走。镜头 scope 不再属于 `visualStyle`，必须使用下述三个滤镜 family。

object scope 的 `visualStyle` 保留角色融入与轮廓光语义；其 set/reset、有限 modulate、seek 和 bake 继续由同一 visual resolver 处理。它与镜头滤镜是两个不同的 state channel，不能互相替代。

`visualStyle(mode: 'reset')` 清除指定 object `(target, slot)` 的 latched cue 与仍在生效的 modulation，使 resolver 回到 `scene.visual` 中对应 object baseline；只有 baseline 缺失时才使用该 scene schema version 固定的 builtin neutral default。reset 不能读取当前模板默认值。

#### Lens Filter Statement Contract

v3 不再接受带 `scope: 'lens'` 的 `visualStyle`。镜头滤镜必须使用三个严格 source family，内部仍保存 recipe catalog 的 `recipeId`，而不是把类别或 UI 名称写入 source：

- `filterAdd` 必须选择一个镜头滤镜模板。catalog 自动从 `recipeId` 推导类别；同一类别已经存在滤镜时，codec/semantic validator 报错，不能隐式替换已有滤镜。
- `filterChange` 保存 `fromRecipeId`（当前滤镜）和 `recipeId`（目标滤镜）。当前滤镜必须存在；目标模板可以跨类别，但目标类别若已有另一个滤镜则报错，避免隐式删除第三个效果。
- `filterReset` 不接受模板，清除所有当前镜头滤镜并回到当前 segment 的 `scene.visual` baseline；没有 baseline 时回到该 schema 版本固定的中性状态。
- Inspector 将 `recipeId` 显示为“滤镜模板”，按“色调基底 / 镜头质感 / 空气氛围 / 画面纹理”分组；类别由 catalog 推导，source 不暴露 `slot`、`mode`、`semanticOverride` 或 `advancedOverride`。变化语句额外显示“当前滤镜”。
- 参数覆写只显示当前模板类别有效的字段：色调基底为后期强度、冷暖；镜头质感为后期强度、Bloom、色差；空气氛围为后期强度、冷暖、空气感、介质感；画面纹理为后期强度。时长字段在 UI 中称为“过渡时长”，单位为秒。
- 默认过渡时长固定为添加 `0.6` 秒、变化 `0.6` 秒、重置 `0.4` 秒；显式 source 值可以覆盖这些创建默认值。
- runtime 对添加执行淡入；变化执行旧滤镜淡出与新滤镜淡入的交叉过渡；重置对全部当前滤镜执行淡出。播放、seek、scrub、preview、bake 和 export 由同一 resolver 计算，过渡期间插值最终视觉 overlay 的亮度、色调、Bloom、色差、体积光和叠加层强度。

lighting family 的 singleton 与 collection 必须分别建模：

- preset、blur target、godrays 和 post fields 使用明确 state key 与字段级 last-writer 规则。
- godrays 与 post 若写同一 post-processing 字段，definition 必须声明冲突与覆盖顺序。
- overlay 和 point light 必须有稳定 object ID，才能提供 remove-one。没有 ID 的 legacy 数据只能迁移为 clear-all，不能伪装为删除单个对象。
- 每个 effect/mode 都有自己的 strict schema；UI 不渲染一个包含所有 lighting 字段的大表单。

#### Audio And Graphic Lifecycle Gates

- `audio(role: 'bgm')` 是固定 state key；play 替换当前 BGM，stop 明确 fade/结束语义。
- `audio(role: 'sfx')` 的 play 必须有稳定 instance id，stop 必须引用该 id。一次性音效也保留 ID，以保证 seek、停止和诊断可寻址。
- preview 与 export 必须从同一 compiled audio interval model 生成结果；当前 `AudioMixer.collectPreparedSources()` 已直接消费 prepared compiled actions，并覆盖 BGM replacement、sfx play/stop、start offset、duration、volume、loop、fade 和 output duration cap。后续如果 runtime audio scheduler 增加新语义，必须先补同一 interval model 的 preview/export parity tests。
- `graphicLayer(kind: 'image')` 在当前 runtime 只有 add。切换 v2 前必须实现 transform/remove、重建、seek、visual target 和 export parity；否则不能把 image/text 宣称为同一完整生命周期。

### 5. Definition Registry Is Declarative; Lowerers Stay In The Compiler

新增 immutable `SceneStatementDefinitionRegistry`，作为 author-facing facts 的单一读取 Interface。每个 family definition 至少声明：

- family 与 mode/effect discriminators；
- strict source schema parser；
- 新建 statement 的 versioned intrinsic defaults 与 authoring default factory；
- label key、category、常用/高级字段、资源字段和轨道投影；
- 合法 mode transition 及其显式 migration function；
- `attachableTo` 规则；
- state keys、overlap policy、纯 `temporalExtent(params)` 与 semantic validators。

UI 只消费 registry 的 presentation projection，不读取 compiler 或 scheduler function。模板优先级、项目资源 I/O、collaboration mutation、DocumentStore commit、visual block mutation和 runtime scheduler 都不进入该 registry。

`SceneStatementLowererRegistry` 是 `SceneStatementCompiler` 的内部 typed map，负责 family -> named compiled outputs。它不暴露给 UI。通过 TypeScript exhaustive map 与 completeness tests 保证：每个 `SceneStatement` variant 恰有一个 definition 和一个 lowerer，unknown family/mode 无法落到 runtime。

现有 `ActionDefaultsRegistry`、`TemplateRegistry`、`ScopeApplicationRegistry` 和 `ResourceAuthoringPolicy` 可以在迁移期间作为 implementation 复用，但不能被揉成一个巨大 pass-through registry。最终公开持久化类型不得继续使用 `Record<string, any>`。

### 6. Dialogue Companions

对话在 UI 中只有一个入口。镜头对焦、Live2D performance、音效或画面强调可以作为可见、可编辑的 companion 附在对话下方：

```json
{
  "id": "stmt_dialogue_001",
  "time": 12.4,
  "type": "dialogue",
  "params": {
    "speakerId": "anon",
    "text": "我知道。",
    "durationSeconds": 3,
    "voice": "vocal/anon/001.ogg"
  },
  "companions": [
    {
      "id": "focus-speaker",
      "anchor": "start",
      "offset": 0,
      "type": "camera",
      "params": {
        "mode": "focus",
        "target": "$speaker",
        "zoom": { "kind": "delta", "value": 0.3 }
      }
    },
    {
      "id": "speaker-expression",
      "anchor": "start",
      "offset": 0,
      "type": "characterPerformance",
      "params": {
        "target": "$speaker",
        "expression": "smile"
      }
    }
  ]
}
```

Companion contract：

- companions 只允许一层；companion 不能再有 companions。
- companion ID 在父 statement 内唯一并持久化，数组 order 同样是语义事实。
- `anchor: start | end`；`end` 严格使用父 dialogue 持久化的 `durationSeconds`，不是音频探测时长或 UI 当前默认值。
- `offset` 必须为 finite number，最终时间不得小于 0。
- `$speaker` 只在 dialogue companion 中合法；父 dialogue 缺 `speakerId` 或目标不存在时 compile 硬失败。
- 只有 registry 明确标记为 `attachableTo: ['dialogue']` 的 family/mode 可附挂。角色登退场、环境删除、BGM 切换等高副作用操作默认禁止。
- 父 statement 的插入、删除、复制和单机 history/尚未发布的本地 structural commit 与 companions 构成一个原子 transaction。共享事务一旦提交，不提供 shared undo；修正已提交协作事实必须产生新的 authoring transaction，遵守 ADR-0011。
- 同一 dialogue 的 companion 可在协作状态中独立寻址，但删除父 statement 必须原子删除/墓碑化其 companion records。

模板可以建议“说话人轻推镜头 + motion + expression”，但插入预览必须先展示将生成的 companions。确认后结果 materialize 为普通 source fields；scene 不保存 template id 或当前模板优先级。用户删除 companion 后，模板更新不得静默加回。

### 7. Timeline UI Information Architecture

时间轴插入菜单展示七个 authoring 一级入口：

1. 对话
2. 角色
3. 镜头
4. 场景
5. 画面效果
6. 音频
7. 图层

最近使用、搜索和模板是辅助入口，不计入七个 domain categories，也不与动作 family 平铺竞争。对话可直接创建；其余入口使用紧凑的二级 mode/effect selector、资源选择器和 preset 菜单。

时间轴块标题由 `family + mode/effect + target` 投影，例如“镜头 · 对焦 anon”“角色 · 表情 anon”“场景 · 设置 background”。Inspector 先展示常用字段，专业参数放入高级区。

类型切换必须同时满足：

1. 仍在同一 family；
2. registry 明确声明该 discriminator transition 合法；
3. 有显式 migration function，能说明保留、删除和新建哪些字段。

“同 family”只是必要条件，不是充分条件。例如 image -> text 会改变实体类型，不能因为都属于 `graphicLayer` 就自动转换。UI 不再提供能把 dialogue 直接改成 point light 的全局 ActionType 下拉框。

### 8. Template Payloads

KSMADR-0001 的 `authoringCombos` 改为三种显式 payload，不再根据数组长度或时间差猜语义：

- `statementPreset`：生成一个 root statement 的参数方案。
- `dialoguePreset`：生成一个 dialogue 及其 attachable companions。
- `timelineFragment`：生成两个或更多独立 root statements；即使它们时间相同，也仍是 fragment。

例如现有 `char_enter` 同时生成 presence 与 performance，它是 `timelineFragment`；只有能合法附挂在 dialogue 下的同时动作才能折叠为 companions。模板 loader 输出 `SceneStatementDraft[]` 或 `DialogueStatementDraft`，不再输出 `ActionType[]` / `DraftAction[]`。所有 draft 在进入 DocumentStore 前经过同一 factory、resource、scope、schema 和 transaction pipeline。

承载这些 payload 的 template manifest 必须增加 `manifestSchemaVersion: 2`，并在 `template.compatibility.sceneSchemaVersion` 声明目标 scene schema `4`。当前 scene loader 拒绝 legacy `authoringCombos.actions: ActionType[]`；内置、用户和项目模板通过显式迁移工具改成上述三种 payload，不能在 loader 中长期猜测旧数组含义。

### 9. Validation, Load, Raw Edit And Save

`SceneDocumentCodec` 是所有 source 入口的强制 seam：文件打开、example、Raw Script、协作 materialization、AI/模板生成和测试 fixture 都不能绕开。

加载顺序固定为：

1. JSON parse；
2. strict scene schema 与 `schemaVersion === 4` 检查（`schemaVersion === 3` 的开发期文档先经显式 v3→v4 迁移，见 "Schema v4 Cutover And V3 Load-Time Migration (2026-08-13)" 一节）；
3. statement/companion ID、顺序、discriminator、params 和 portable resource reference 检查；
4. cross-statement semantic validation；
5. source asset readiness/normalization；
6. compile source document；
7. prepare runtime asset references；
8. atomically replace source facts and project the prepared compiled scene。

步骤 1-7 只操作 detached working copy。任何 error 都必须在 DocumentStore、协作状态或 runtime 改变前中止。warning 可以随 `LoadResult` 返回，但不能掩盖 schema error。当前 raw JSON parse 已集中在 `SceneFileService`/semantic coordinator seam；产品 runtime 入口已收敛到 branded `PreparedCompiledScene`，`ScriptEngine` 内部的 scheduler representation 不得向外泄漏。协作 remote apply 同样先 materialize `SceneDocumentV4`，再过 codec/compiler seam。

Raw Script 编辑 `SceneDocumentV4` 本身。合法的单 statement patch 继续走 ordinary edit Interface；结构变化走 structural Interface；整份替换走 `SceneFileService`。保存从 DocumentStore 取得 immutable source snapshot，clone 后交给 pure `prepareForSave(snapshot)` 生成新的 serializable document，再写盘；该过程不得通过 `ref.set(...)` 或其他方式原地修改 DocumentStore facts，也不再调用 `decompile()`。

普通加载器严格拒绝未版本化文件、v2 scene、旧 action alias、旧镜头 `visualStyle`、绝对路径和 URL-style asset reference；错误不得被部分加载或静默跳过。开发期迁移由显式 `scripts/migrate-scene-v2` 一次完成：它必须通过 `ProjectResourceService` 把可识别的绝对/外部 mount 路径 projectize/copy 或转换为无歧义的 registered-root-relative reference；缺失、冲突或无法归属的路径以逐项报告失败，不能静默保留。该工具输出 v4 文档，迁移结果再次运行 v4 codec；它不是 runtime compatibility layer。

### 10. Collaboration Contract

scene schema 与 collaboration wire schema 是两个独立版本，不能共用一个 `schemaVersion` 含义。当前协作 wire 已切换为 `COLLABORATION_SCHEMA_VERSION_V2 = 2`：server、client transport、presence、YDoc、agreement adapter、planner 和 snapshot 只接受 v2。`SemanticSceneMigrationInventory` 中保留的 v1 `actionsById` 记录只是历史迁移事实，不是 runtime/API compatibility layer。v2 contract 包括：

- 增加 `sceneSchemaVersion: typeof SCENE_SCHEMA_VERSION`，其值为 `4`；
- 把 `actionsById` / `timelineOrder` / `tombstones.actions` 改为 `statementsById` / `statementOrder` / `tombstones.statements`；
- 把 dialogue companions 规范化为按父 statement 分组的 `companionsById + companionOrder`，materialize 时再生成嵌套 JSON；
- 增加按父 statement 分组的 `tombstones.companions`。删除单个 companion 必须从 `companionOrder` 移除并写 tombstone；删除父 statement 必须在同一 transaction 中移除 statement/order/companion group，并为父与现存 companions 写 delete-wins tombstones；
- 删除协作状态中的顶层 `audio`，BGM 与 SFX 都通过 statement records materialize；
- 把 presence/editing target 从 action id 改为 statement id，companion target 同时携带 parent statement id 与 companion id；
- 让 planner、Yjs Adapter、materializer、tombstone filter、server persistence 和 snapshots 全部以 source statement 为事实；
- 明确 compiled actions 从不进入 Yjs、server snapshot 或 asset manifest diff。

`statementOrder` 必须恰好包含每个 live statement ID 一次；每个 `companionOrder` 也必须恰好包含该父 statement 的每个 live companion ID 一次，不允许 duplicate、missing 或 dangling ID。普通 time patch 不改变 collaborative order，只有显式 reorder intent 才能改 order；删除实体必须同时移出对应 order 并写 tombstone。这些规则直接继承 ADR-0017，而不是重新用 ID 字典序推导作者顺序。

join、seed、publish 或 resync 发现任一 wire/scene version 不匹配时必须拒绝，不能让不同 schema 客户端进入同一房间，也不能跨版本自动 Yjs merge。项目尚未发布，因此旧开发房间应重建或通过显式离线迁移处理。

VisualTarget、segment、marker 和 asset 继续使用现有独立 records、tombstones 与 readiness gate。新 statement 模型不能把它们重新压回一个 timeline JSON blob。

### 11. Authoring And Runtime Seams

- authoring schema 当前为 `AUTHORING_SCHEMA_VERSION = 3`。v3 在 statement/companion locator 与 typed receipt 契约上增加 `insert-statement.beforeStatementId`，用于在同一 source time 内稳定插入 lifecycle end boundary（同刻 order）；scene schema 已为 v4。旧 action-ID authoring types 与旧 intent payload 不再是产品 Interface，历史 payload 只能由显式离线 migration 处理。

> **Editor presentation note (2026-07-24):** Timeline UI no longer projects a State Span super-object. Lifecycle pairing is a lightweight helper only — see `docs/ksm-adr/timeline-lifecycle-pairing-notes.md`. Source statements remain enter/exit (etc.) pairs; schema is unchanged.

- semantic authoring service 已能创建/删除/复制/粘贴 `SceneStatement` 并返回 typed receipt 和 all-or-nothing result；legacy `TimelineAuthoringService`、resolver、DraftAction 和 action edit Interface 已删除。
- UI gate 完成后，ordinary edit Interface 必须改为 typed statement edit；discriminator transition 使用 registry migration，不接受裸 `Partial<Record<string, any>>`。
- semantic character directory command 保持独立受控 seam，并把角色 ID 变更传播到 source statements 与 companions；旧 `CharacterDirectoryService` 已删除。
- `VisualAuthoringService` / `SemanticVisualCompositionAuthoringService` 保持独立，跨 visual block 与 statement 的操作继续由 composition transaction 协调；旧 action-based composition service 已删除。
- AI authoring 输出 `SceneStatementDraft[]`；pause 只推进 draft cursor，尾部 pause 写入 scene duration，不生成 `wait`。
- 跨 visual block/statement 的 composition intent、plan、receipt 与 transaction fact 必须和当前 authoring schema 一起 inventory/version，不能在内部继续保存 action IDs。
- semantic projection、`BakeEngine.bakePrepared*`、PreBakeDaemon 和 export `AudioMixer.collectPreparedSources` 已接收同一 immutable `PreparedCompiledScene` contract；prepared bake 会在进入内部 scheduler bridge 前把 prepared model asset refs 注册为 source/runtime URI 双键 path map；`ScriptEngine.loadScene(SceneScript)` 已删除，runtime scheduler map 只作为 prepared scene 的内部 implementation detail。协作 manifest/readiness 与保存 portability 检查扫描 `SceneDocumentV4` source statements，不能反向扫描 prepared runtime URI。
- runtime scheduler map 可以在迁移期保留旧 `RuntimeActionType` 名，但它是 compiler implementation detail，不能被 UI、模板或 source validator import。

## Migration And Acceptance Gates

实现采用“平行建设、一次切换”，不在可运行产品中长期维护双 schema：

1. **Inventory gate**：建立 old action -> new family/mode -> lowerer output 的完整矩阵；50 个旧 ActionType、顶层 BGM、AI wait、authoring v1 intent/receipt 和 visual composition contracts 都必须有明确 migrate/drop/version 结论。
2. **Source gate**：实现 `SceneDocumentV4` unions、strict codec、definition registry、factory、ID/order/duration tests 和离线迁移工具；normal loader 对 v2/legacy fixtures 必须失败，并对旧镜头 `visualStyle` 明确报错。
3. **Compiler gate**：实现 exhaustive lowerers 与 golden tests，证明 source 不变时 compiled IDs/order/params 不变；删除任何从 compiled action 反推 source 的需要。
4. **Runtime parity gate**：逐项证明 playback、seek/scrub、reconstruct、bake 与 export 一致；先修 camera follow/reset/zoom、rim resolver、image lifecycle 和 audio export 四个已知阻断项。
5. **State gate**：将 DocumentStore、SceneFileService、Raw Script、asset collection、CharacterDirectory、visual composition 和 AI authoring 切到 statements；bump authoring schema 并完成 statement/companion locator 与 receipts。
6. **Collaboration gate (v2 wire cutover complete)**：wire schema bump、statement/companion records、order、tombstones、planner/materializer/Yjs/server persistence、presence locator 和 mixed-version rejection tests 已完成；projected action/read-model 与 legacy authoring/document bridge 的后续清理已由 UI/deletion gates 完成。
7. **Template gate**：bump manifest schema、声明 scene compatibility、迁移 builtin/user/project payload，并测试 loader 对 legacy `ActionType[]` 的拒绝。
8. **UI gate (complete)**：七个入口与所有 semantic family source-param forms 已落地；Dialogue companion editor 支持 CRUD、typed params 与显式 reorder；三种 template payload 都有 commit-ready confirmation preview。
9. **Deletion gate (complete)**：产品 source/state/UI 不再依赖 legacy scene schema、public runtime scene 或 legacy scheduler alias。显式 legacy migrator 位于 scripts-only boundary；builtin template 与 tracked scene data 由 v4 guard 固化。

在 gates 2-7 通过前，不允许先提交“只隐藏菜单项”的产品改造。否则新 UI 仍被旧 `ActionType`、decompile、协作 actionsById、legacy template payload 和不完整 runtime lifecycle 反向限制。

验收测试至少包括：

- source codec 对每个 family/mode 的 valid/invalid fixtures；
- `filterAdd` / `filterChange` / `filterReset` 的 recipe category 推导、重复类别、缺失当前滤镜、目标类别冲突、默认时长与 preview/export transition parity；
- duplicate IDs、companion nesting、非法 attachment、未知字段和旧版本拒绝；
- compile determinism、unique output keys/IDs、stable ordering、`$speaker`、end anchor 和 pure temporal extent；
- runtime asset preparation 返回新的 immutable prepared scene，save preparation 不修改 source facts；
- same-time camera/environment conflict 与 seek parity；
- preview/bake/export 的 visual、lighting、image 和 audio parity；
- save -> load 保持 source 语义，无 decompile round trip；
- collaboration statement/companion 并发编辑、companion tombstone、time-patch order stability、delete-wins 和 mixed-version rejection；
- authoring v2 locator/receipt、template manifest v2/scene compatibility 与 legacy payload rejection；
- template/AI 只能生成 schema-valid drafts，不能绕过 resource/authoring seam；
- guard test 阻止 UI、模板、协作或 runtime 重新 import source-level legacy `ActionType`。

## Consequences

- 作者从七个 domain entry 插入语义草稿；timeline presentation、selection 与 Inspector 使用 semantic metadata/source params，compiled action 只保留内部 runtime selection identity。
- semantic source document、v4 scene source、v2 协作事实与 runtime compiled action 具有明确 Interface；保存不依赖反编译，legacy schema 只存在于离线 migration scripts。
- family definition 和 lowerer 分别获得 locality：UI facts 集中在 declarative registry，runtime lowering 集中在 compiler，completeness test 防止二者漂移。
- `characterPerformance` 与 dialogue companions 能表达一次用户意图，同时保留 runtime 对 event/latching effect 的正确实现。
- 环境、camera、lighting、audio 和 graphic layer 的 identity/lifecycle 被明确建模，不再靠 `clear`、Infinity duration 或参数命名暗示。
- 代价是一次破坏性 schema、collaboration wire 和模板 payload 迁移，以及 image/rim/audio/camera 四项必须先完成的 runtime 深化。
- scene 文件会比旧 sparse/decompile 格式更显式，但行为不会因模板默认值或 reverse compiler essential-key list 变化而静默漂移。

## Rejected Alternatives

- **只把现有 ActionType 分组或隐藏菜单项**：拒绝。它不解决 source/runtime 混用、保存反编译、validator/scheduler 漂移和协作事实错误。
- **保留全部旧 action alias 或镜头 `visualStyle` 作为 v3 输入**：拒绝。项目未发布，长期 alias 会让新 registry 与 compiler继续承担双语义，并掩盖滤镜类别冲突。
- **一个 registry 同时持有 UI、文件 I/O、collaboration mutation 和 scheduler function**：拒绝。它会制造宽而浅的 Interface；declarative definitions 与 compiler lowerers应通过 typed key 和 completeness test 对齐。
- **compiled actions 继续作为 DocumentStore/协作事实**：拒绝。这样仍需要 decompile，companions和模板意图也会在保存前丢失。
- **在 compile 时读取当前模板默认值**：拒绝。已有 scene 会随模板顺序或版本变化而改变；模板只影响新建 draft。
- **继续保留顶层 BGM fallback**：拒绝。它与 timeline audio 形成双事实和不透明优先级。
- **用一个大 `lighting.params` / `graphic.params` 对象容纳所有 mode**：拒绝。family 合并不等于丢弃 discriminated union 和独立生命周期。
