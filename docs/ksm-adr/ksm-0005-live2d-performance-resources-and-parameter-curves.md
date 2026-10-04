---
status: draft
last_verified: 2026-07-29
implementation_status: decision-updated-for-semantic-scene-v3; implementation-pending
---

# Live2D Performance Resources and Parameter Curves

AeonStagery 当前只能按 Live2D 模型 JSON 已注册的 group/name 播放 motion 和 expression。用户在 Cubism Editor 中新建一个 `.mtn`、`.motion3.json`、`.exp.json` 或 `.exp3.json` 文件后，即使已经把文件放进项目，仍需手工修改 `model.json` 或 `model3.json` 才能在编辑器中选择和播放。这个要求把角色模型入口文件同时变成了 AeonStagery 的资源数据库，妨碍同一角色的多个 outfit 共用表演资源，也使社区模板更新容易与用户修改产生冲突。

项目已经有直接写入 Live2D 参数的底层能力。`Live2DManager.setParameter()`、lip sync 和角色目录参数滑杆都能修改 core model parameter，runtime adapter 也能在模型 update 后重新应用 injected parameter。但是 scene schema 没有可保存的参数动画，UI 不能创建关键帧或缓动，现有 `injectedParams: Record<string, number>` 也无法表达多个来源、混合方式、结束恢复和 seek。`playCustomAnimation` 是 HTML 图层动画，不是 Live2D 参数动画。

KSM-0003 已实现 versioned `SceneDocumentV2`、单向 compiler、`PreparedCompiledScene` 和 semantic authoring seams；KSM-0004 负责短资源输入、namespace、owner、路径约定和 authoring-time materialization。本 ADR 负责 materialized motion/expression 文件如何进入 prepared/runtime 阶段，以及 AeonStagery 自身如何用参数曲线驱动模型。

## Decision

Live2D 角色表演支持两条并列路径：

1. **External performance resource**：直接加载独立 motion/expression 文件，保留 Cubism 文件的曲线、fade 和 runtime 播放语义。
2. **Authored parameter track**：由 AeonStagery 保存参数关键帧、缓动和混合方式，适合快速调整、叠加微动作和模板 preset。

模型 JSON 继续是模型 bundle 和内置表演资源的合法声明来源，但不再是 motion/expression 的唯一注册入口。应用不能为了播放外部文件而重写用户的模型 JSON；外部资源只在项目索引、prepared scene 和运行时 registry 中注册。

现有 scene v3 `CharacterPerformanceParams` 把 `motion`、`expression` 表示为模型内逻辑 key。外部文件和 `parameterTracks` 不能继续伪装成同一种 string，也不能在不改变 schema version 的情况下加入。默认决策是在下一 `SCENE_SCHEMA_VERSION` 中引入显式 union；如果团队决定在 v3 产品接受前原子修订 v3，则必须同时更新 constant、codec、definition registry、compiler golden tests、迁移 CLI、manifest compatibility 和全部 fixtures，不能只放宽 parser。

建议 source contract：

```ts
type PerformanceSelection =
  | { kind: 'modelKey'; key: string }
  | { kind: 'externalResource'; file: string; runtimeKey: string };

interface CharacterPerformanceParamsNext {
  target: string;
  motion?: PerformanceSelection;
  expression?: PerformanceSelection;
  parameterTracks?: ParameterTrack[];
  // existing look-at / blink fields remain discriminated and validated
}
```

`file` 是 KSM-0004 在 semantic mutation 前 materialize 的 project-relative reference；`runtimeKey` 是加载后用于 queue、snapshot、seek 和诊断的稳定 key。compiler 只 lower union，不访问文件系统。

## External Performance Registry

新增 runtime-neutral `Live2DPerformanceRegistry`。它接收 `RuntimeAssetPreparer` 生成的 `PreparedAssetRef` 和 compiler 透传的 runtime key/metadata，按项目、模型实例和 runtime family 管理资源状态：

```ts
interface Live2DPerformanceResource {
  runtimeKey: string;
  kind: 'motion' | 'expression';
  asset: PreparedAssetRef;
  runtimeFamily: 'cubism2' | 'cubism3-plus';
  metadata?: {
    fadeIn?: number;
    fadeOut?: number;
    loop?: boolean;
    sound?: string;
    targetSubmodels?: string[];
    requiredParameterIds?: string[];
  };
}

interface Live2DPerformanceRegistry {
  register(resource: Live2DPerformanceResource): Promise<void>;
  prepare(modelId: string, resource: Live2DPerformanceResource): Promise<PreparedPerformance>;
  releaseModel(modelId: string): void;
}
```

runtime-specific 文件解析、缓存和播放只能位于 `Live2DRuntimeAdapter` 后面。UI、scene compiler、短资源 resolver 和 `RuntimeAssetPreparer` 不允许直接修改 `internalModel.settings`、motion manager 私有数组或 Cubism queue。

每个 runtime adapter 应提供等价能力：

```ts
registerExternalMotion(model, runtimeKey, source, metadata): Promise<void>;
registerExternalExpression(model, runtimeKey, source, metadata): Promise<void>;
unregisterExternalPerformance(model, runtimeKey): void;
```

Cubism 3+ 官方适配器已经可以从 buffer 构造 motion/expression，新增外部入口后应直接写入现有 motion/expression cache。Cubism 2 的 `pixi-live2d-display` 主要按 model settings definitions 加载；动态 definitions、加载槽位和表达式索引必须封装在 Cubism 2 adapter 内，不能成为跨项目使用的裸私有 API。WMDL 由多个具体模型组成，registry 应把资源分发给 runtime family 与参数集合兼容的子模型；`targetSubmodels` 可以显式收窄目标。

`SceneStatementDefinitionRegistry` 必须把 external motion/expression 的 `file` 标记为 typed asset slot。`RuntimeAssetPreparer` 根据 slot metadata 生成 deep-immutable `PreparedAssetRef`，不能继续仅靠全局 `file/image/model/voice/animation` 字段名集合猜测。prepared scene 进入 `PreparedSceneRuntimeAdapter` 时，先注册 external performance，再交给 `ScriptEngine`、BakeEngine 或 export runtime。

资源采用 lazy runtime registration 和按规范 runtime URI/内容版本缓存。编辑器资源列表只有在 authoring resolver 能定位、且对应 adapter 声明支持该格式时才标记为可用；实际 prepare/compatibility 失败仍阻断 playback，而不是仅因文件存在就宣称可以播放。主预览、PreBakeDaemon、BakeEngine 和导出必须共享相同 prepared asset 与 adapter 行为。

## Resource Resolution and Overrides

新的 `characterPerformance` authoring intent 先由 KSM-0004 补全资源类型、owner、namespace 和活动 outfit，再按以下顺序选择资源并 materialize source union：

1. authoring draft 中显式选择的完整路径或 namespace-qualified asset entry。
2. 当前 outfit 目录显式提供的外部资源，例如 `models/{outfit}/motions/{name}`。
3. 当前模型 JSON 声明的 motion group 或 expression name。
4. 当前角色公共目录资源，例如 `live2d/{character}/motions/{name}`。
5. 模板 package-local convention 的其他候选。

同一层级出现多个扩展名或多个文件时返回歧义诊断。outfit 专用文件允许有意覆盖模型 JSON 中的同名资源；角色公共文件默认作为模型声明的 fallback。用户在冲突 UI 中确认模板来源后，semantic authoring service 将外部文件 projectize，并写入 `{ kind: 'externalResource', file, runtimeKey }`；模板 namespace 留在 authoring receipt/provenance，不在 compiler 中重新求值。

外部文件缺少原模型 JSON entry 中可能携带的关联信息时，使用以下来源顺序补足：

1. manifest `assets.index[].metadata` 或资源旁路 metadata；
2. 文件格式自身提供的值；
3. AeonStagery runtime family 默认值。

音频文件是独立项目资产，不能因为 motion metadata 引用了 sound 就绕过 projectize、协作 manifest 或导出收集。

## Compatibility Validation

直接找到文件不代表它能安全应用给目标模型。runtime registration 阶段必须产生结构化兼容报告；轻量格式/runtime-family 检查可以在 authoring 阶段提前执行，但 preview、bake 和 export 以同一 adapter 报告为准：

```ts
interface PerformanceCompatibility {
  status: 'compatible' | 'partial' | 'incompatible';
  missingParameterIds: string[];
  ignoredParameterIds: string[];
  diagnostics: string[];
}
```

规则如下：

- Cubism 2 文件不能加载到 Cubism 3+ runtime，反之亦然。
- 资源声明了 `requiredParameterIds` 且目标缺少其中任意参数时，默认拒绝；用户或模板可明确允许 partial。
- 未声明 required parameter 时，adapter 应在解析文件后尽可能收集参数 id；未知参数可以忽略，但必须形成 warning。
- 跨角色调用如目标为 anon、资源为 `soyo:idle01`，owner 只决定资源来源，不改变实际 action target。
- WMDL 中兼容的子模型可以执行，未命中的子模型应记录诊断；全部未命中时拒绝播放。
- validation daemon 使用与 runtime 相同的 registry 和兼容报告，不能维护另一套文件名推断。

## Authored Parameter Tracks

下一 scene schema version 的 canonical `characterPerformance` 增加 `parameterTracks`。它可以单独出现，也可以与 motion、expression、look-at 等表演属性在同一语句中组合：

```json
{
  "id": "stmt-performance-001",
  "time": 12.4,
  "type": "characterPerformance",
  "params": {
    "target": "anon",
    "motion": { "kind": "modelKey", "key": "idle01" },
    "parameterTracks": [
      {
        "parameterId": "PARAM_ANGLE_X",
        "keyframes": [
          { "time": 0, "value": 0 },
          { "time": 0.35, "value": 22, "ease": "power2.out" },
          { "time": 0.8, "value": 0, "ease": "sine.inOut" }
        ],
        "blend": "add",
        "endBehavior": "restore"
      }
    ]
  }
}
```

关键帧 `time` 相对语句开始时间。第一版支持数值参数、`override | add | multiply` 三种 blend 和 `restore | hold` 两种结束行为；默认 `blend` 为 `override`，默认 `endBehavior` 为 `restore`。参数 id 保存 runtime 的精确 id，显示名称和未来语义 alias 不替代持久化 id。

第一版 UI 不要求完整曲线图编辑器。参数选择器应读取活动模型的 parameter id、当前值、default、min 和 max，先提供：

- 起始值、目标值、duration 和 easing 的简单 tween；
- 可添加的少量关键帧列表；
- 模板 parameter-track preset；
- 预览、恢复和兼容警告。

完整 graph editor、切线编辑和批量曲线工具可以后置。Cubism 2 无法可靠提供参数范围时，UI 使用已知参数 metadata 或模板声明，并明确标记未知范围，不能统一假设所有参数都在 `0..1`。

## Deterministic Curve Evaluation

参数动画不能只实现为 GSAP tween 的 `onUpdate -> setParameter()`。这种实现依赖播放过程，无法保证任意 seek、快照重建、PreBakeDaemon 和离线导出得到相同值。

参数轨道由 versioned `SceneStatementDefinitionRegistry` 校验，并编译为可按任意 scene time 求值的纯数据：

```ts
evaluateParameterTrack(track, relativeTime): number | undefined;
```

easing 可以复用项目采用的 GSAP easing 名称和数学函数，但求值器必须能够直接计算 progress，而不是要求某个 tween 已经从头运行。预览、BakeEngine 和导出调用同一个 evaluator。暂停、向后 seek 和从任意时间开始导出时都必须重建相同参数状态。

短参数 tween 可以编译成两个 keyframe；preset 应展开为普通 `parameterTracks`，scene 不保存依赖当前模板优先级的不可见执行逻辑。

## Parameter Channel Mixer

现有 `injectedParams: Record<string, number>` 替换为有来源和生命周期的 `Live2DParameterMixer`。这是 runtime state，不进入 `SceneDocumentV2` 或 compiled source facts。模型每帧先执行 runtime motion、expression、physics 和 pose，再由 mixer 按确定顺序应用外部参数层：

1. runtime base：motion、expression、physics、pose；
2. authored tracks：用户和模板展开后的 parameter tracks；
3. behavior controllers：look-at、blink 等系统行为；
4. lip sync：只控制声明的 mouth parameter；
5. manual preview：角色参数面板的临时检查值。

每个 source 至少包含 `sourceId`、parameter id、blend、weight、value 和有效时间。相同层级按稳定 source id 排序，禁止依赖对象插入顺序。`override` 替换前层结果，`add` 添加偏移，`multiply` 乘以系数；最终结果按模型参数范围 clamp。轨道结束时 `restore` 删除 source，让下层结果重新显现；`hold` 保留最后值直到后续语句替换或显式清除。

manual preview 不写入 scene，也不能污染导出。lip sync、blink 和用户曲线写同一参数时，UI 应显示通道冲突；用户若要覆盖 mouth 或 eye controller，必须显式禁用对应 behavior 或选择更高的 authoring policy，不能靠执行时序偶然获胜。

## Motion Files and Parameter Tracks Remain Distinct

不把外部 motion 文件自动反编译成 AeonStagery 参数轨道，也不把 expression 文件默认转换成普通参数 preset：

- Cubism motion/expression 保留其 runtime fade、queue、priority 和格式语义。
- 参数轨道强调可编辑、可组合和模板化，适合少量参数和程序化动作。
- 两者可以在同一个 `characterPerformance` 中叠加，由 parameter mixer 的 authored layer 决定最终覆盖或增量效果。

未来可以增加“导入 motion 为可编辑轨道”的显式工具，但那是内容转换功能，不是正常播放路径。

## Consequences

- 用户把 motion/expression 放入约定目录后即可通过短名使用，不需要修改模型 JSON。
- 同一角色的多个 outfit 可以共享角色级表演资源，并保留 outfit 专用覆盖。
- 外部资源加载需要为 Cubism 2、Cubism 3+ 和 WMDL 分别实现 adapter，不能只在当前主 runtime 上打补丁。
- 直接参数写入从内部口型机制升级为正式创作能力，但需要替换单值 `injectedParams` 并统一 preview、seek、bake 和 export。
- 简单点头、视线、呼吸和表情微调可以由模板 parameter-track preset 提供；复杂表演继续优先使用 Cubism motion 文件。
- runtime 兼容性和参数缺失会成为用户可见诊断，社区资源不再以“文件存在”作为可播放的唯一依据。
- external performance union 和 `parameterTracks` 遵守 KSM-0003 的 schema version gate；不会通过可选 `any` 字段偷偷改变 scene v3 的编译语义。

## Implementation Order

1. 决定下一 scene schema version，并在 `semantic-scene.ts`、codec、definition registry、compiler、factory、authoring intents/receipts、迁移 inventory 和 manifest compatibility 中原子加入 `PerformanceSelection` 与 `parameterTracks`；不放宽 legacy `ActionType`。
2. 把 external performance `file` 声明为 typed asset slot，扩展 `RuntimeAssetPreparer` / `PreparedSceneRuntimeAdapter`，用 golden tests 证明 compiler 不执行 I/O 且 prepared scene 不修改 source。
3. 扩展 `Live2DRuntimeAdapter` 的 parameter metadata、external motion/expression register 和 compatibility report 合同，先用 fake adapter 测试 registry 生命周期与诊断。
4. 实现 Cubism 3+ 外部 motion/expression 注册，复用现有 buffer loader 和 cache；同时接入 semantic preview、PreBakeDaemon 与 BakeEngine/export 测试。
5. 实现 `Live2DParameterMixer` 和确定性 `ParameterTrackEvaluator`，把 lip sync 与 manual slider 迁移为具名 source，暂不增加完整 UI。
6. 增加 semantic parameter tween UI、参数 metadata picker、manifest v2 preset 和冲突诊断；模板 payload 必须通过 versioned definition registry 生成合法 draft。
7. 实现 Cubism 2 动态 definitions/cache adapter；不得从 UI 直接依赖 `pixi-live2d-display` 私有字段。
8. 为 WMDL 实现按兼容子模型分发和 `targetSubmodels`，补齐跨角色、跨 outfit 和 mixed-runtime 测试。
9. 更新 KSM-0004、模板迁移 CLI、TODO 和中英文能力文档，再将外部 motion/expression 从“发现但不可用”切换为正式可选择资源。
