---
status: accepted
---

# Live2D Cubism Multi-Version Runtime Compatibility

当前项目必须在保留 Cubism 2.1 模型兼容的同时适配 Cubism 5。Cubism 5 不能被实现成现有 Cubism 2 私有字段补丁的又一个分支，因为现有 `Live2DManager`、`BakeEngine` 与 motion/parameter 修复大量依赖 `UtSystem`、`coreModel`、`motionManager` 和 Cubism 2 bundle 的内部形状。

## Decision

新增版本感知的 Live2D runtime seam。外部 authoring 使用 KSM-0003 的 semantic character families：`characterPresence`、`characterTransform` 与 `characterPerformance`，并保存 project-relative model path。`addCharacter`、`playMotion`、`setExpression` 只属于 compiler 生成的内部 runtime action，不是 scene JSON 或模板契约；seam 后面按 runtime family 选择 Adapter：

- Cubism 2.1 继续使用现有 `pixi-live2d-display/cubism2`、`live2d.min.js` 与 `.moc` / `.mtn` 行为修复。
- Cubism 3 / 4 / 5 归为 Cubism 3+ runtime family，Cubism 5 目标 Adapter 以官方 Cubism 5 Web SDK / Framework 为优先实现来源。
- Cubism 2 的 clock spoofing、mask isolation、default parameter table 与 snapshot hard reset 只能留在 Cubism 2 Adapter 内，不能成为所有 runtime 的公共 Interface。

Live2D model entry 识别必须集中在共享纯 Module。`model.json`、`*.model.json`、`*.model3.json` 与 `.wmdl` 仍是 Live2D bundle entry；普通 `.json` 不再因为后缀相同而自动进入 Live2D bundle。`.wmdl` 保持项目包装入口，它只声明一个或多个真实 model entry，不能成为唯一 runtime 入口。

ADR-0013 与 ADR-0018 的 bundle 决策继续有效：协作 scene 仍保存 project-relative asset reference，`Collaborative Asset Manifest` 继续记录 entrypoint、bundle file list、file fingerprints 与 bundle hash。Cubism 5 适配不得把 scene 引用隐式迁移成 `assetId` 或 content hash。

## Consequences

- `Live2DAssetBundle`、manifest builder、SceneAssetService 导入复制、ValidationDaemon 与 runtime loader 必须复用同一 entry/version 识别规则。
- Cubism 5 的 `.moc3`、`.motion3.json`、`.exp3.json`、`physics3.json`、`pose3.json`、`userdata3.json`、textures、motion sounds 与 display info 都属于同一个 Live2D bundle closure。
- `Live2DManager` 与 `BakeEngine` 后续应依赖 runtime Adapter Interface，而不是直接调用 `Live2DModel.from`、`internalModel.motionManager` 或 `coreModel.setParamFloat`。
- `getModelDataFromPath()` 的公开返回继续是 `{ motions, expressions }`，以保持 UI 与 script validation 兼容；runtime family 信息只作为内部选择 Adapter 的事实。
- 如果未来要改 scene schema、manifest schema 或 assetId 化，必须另开 ADR；本次只扩展 Live2D runtime 与 bundle 规则。

## Implementation Boundaries

截至 2026-10-14，已接受的 runtime behavior Interface 迁移完成，旧的公共 `Live2DRuntimeModelControls` 契约已删除；production audit 未发现外围代码读取 raw model/Core、sampler target、SDK strategy flags 或 SDK clock/replay sequencing。以下按职责记录当前实现和仍适用的约束，避免把迁移过程中的阶段状态误读为现状。

### Runtime selection and bound behavior

`Live2DModelEntry` 统一识别 bundle entry 与 runtime family；`Live2DRuntimeResolver` 选择 Adapter 并报告支持状态；`Live2DRuntimeAdapter` 初始化 runtime 并创建模型。Cubism 2 使用 `Cubism2PixiLive2DAdapter`，Cubism 3/4/5 使用 `CubismPixiLive2DAdapter`。

绑定模型的 `Live2DModelHandle` 暴露完整行为、runtime-neutral 的参数与动作采样数据，以及类型明确的 Pixi display object。SDK 操作端口只存在于 runtime 内部实现；调用方不传递 transaction token、SDK start time 或采样目标。选择完整行为接口，是为了保留现有时间轴编排对角色意图的裁定，同时将 SDK 操作协议收回 runtime；改为每帧提交全部角色目标状态会改变编排状态模型，不属于本次重构。

- Stage 与 Bake 通过绑定 handle 请求初始化、资源绑定、runtime state reset、静止和销毁；mask isolation、预热、idle flush、模型 baseline 和组合模型 pristine neutral pose 留在 runtime。
- `inspectParameters` 返回独立的 parameter ID、索引、名称、值和范围；`editParameters` 在 runtime 内把旧工作区索引解析成 ID。批量编辑每个具体模型只提交一次几何。角色信息通过 `CharacterInfo` 返回 model path、配置、Adapter identity 和确定性能力。
- 参数面板仍显示前 20 个参数，播放时禁用编辑；模型不可用、reload 后恢复播放位置等既有 UI 行为保持不变。显示、动画和 transform target 只取得类型明确的 Pixi object，不暴露 Core getter。
- Runtime capability 只描述可执行行为与确定性保证。Adapter ID 用于 Adapter 选择、诊断和缓存 identity；编排层按 capability 选择行为，不按 runtime 身份新增分支。已加载 handle 的能力优先；无 handle 时使用 descriptor，缺少 descriptor 的旧 entry 保留 Cubism 2 默认兼容行为，`supported: false` 不声明执行能力。
- Cubism 2 的共享 SDK 时钟锁、idle flush、动作重放、mask isolation、默认参数表与 snapshot hard reset 留在 Cubism 2 runtime。Native motion offset 不可用时，以共享时钟按 50ms 固定步重放；重放期间关闭 Physics，且不声明完整 state replay。
- Cubism 3+ 使用原生动作 offset 和零步长姿态提交；Seek 避免暂停时重复执行 writer。这些能力不表示 Physics、Pose 或 LookAt 的完整状态重建。Bake frame batch 的共享时钟协调也封装在绑定 handle 内。
- 动作转换、缓存预热、Seek 与 Bake 使用 neutral motion sampling。Cubism 2 在 runtime 内隔离采样并合并组合模型曲线；Cubism 3+ 保留原曲线段。不支持的曲线或 runtime 返回 typed unsupported 结果，调用方继续原生动作路径。

Cubism 3+ 的 `CubismPixiModel` 在绘制前推进模拟，使 Seek、参数读取、快照和 Bake 不依赖下一次绘制，绘制本身不会重复推进模拟。Adapter 保留场景淡入覆盖与文件淡入恢复、动作结束姿势、命名空间动作组、表情异步取消、确定性 blink/breath、Core 更新前的参数注入，以及组合模型扩容后的内存视图刷新。

### Model resource ownership

`Live2DModelResources` 管理模型创建、runtime 识别、registry 查询、组合组装、借用与归还、池和纹理引用。Stage 与 Bake 各持有独立实例，但共享同一所有权实现；BakeEngine 负责隐藏容器、发布前准备、场景时间推进和快照采集，不负责模型创建或回收。获取接口同时接收 prepared source identity 与 resolved runtime URI。

- 同角色加载串行化。借用结果提供 `isCurrent()` 与 `release()`；归还关联实际所有权及创建 Adapter。舞台在异步预热后复核资源借用、舞台代次和角色代次，旧回调及重复归还不能回收已被其他角色借用的实例。
- `cancelLoads()` 使当前和排队获取失效，但保留已加载模型；不同 source/runtime 路径会替代同角色旧请求。`clear()` 推进资源代次、取消旧任务并清空池；`close()` 永久禁止获取并回收现有所有权。SDK 无法同步取消的迟到创建只能回收；未完成任务仍由 `waitForLoads()` 覆盖。
- 模型池每 URL 最多保留 10 个根实例。纹理引用按具体模型解析后的 URL 记录，覆盖创建、预加载、舞台借用和池内实例；取还不改变引用数，实际销毁才递减。组合容器不重复回收子模型，独立 Bake 共享的 SDK/浏览器纹理在 Stage 清空时继续保留。
- Bake 具体模型按实际 Adapter 回收：Cubism 2 遵守 soft-detach，其他 Adapter 销毁实例并保留共享纹理。主模型创建失败会终止组合模型；子模型创建失败可继续。部分组装、设置、取消或 Bake 发布准备失败时，已获取实例会被回收，不完整的 sync hook 不进入池。

### Stage publication and orchestration

`Live2DManager` 保持调用接口。私有 `Live2DStageRuntime` 持有角色、容器、代次和命令状态，并负责登场、发布校验、积压意图消费、失败回滚和撤场；`Live2DModelResources` 仍独立负责模型所有权。自定义动作、Geometry 与 Rim Light 通过 Stage Runtime 共享舞台状态，不增加 runtime family 分支或新的 Adapter seam。

发布前先对齐代理视觉状态，再恢复表情、视线、blink、轮廓光、资源动作、自定义动作和 transform。积压意图按顺序消费，以保留资源动作之后的自定义动作及 handoff。重放期间撤场会停止剩余意图消费并取消登场通知；准备或重放失败先撤销舞台状态，再归还模型。撤场恢复中立姿态并清除未登场角色的积压状态；销毁容器前先移出借用模型，整场清空也销毁只为变换创建的容器。

职责模块：`Live2DCustomMotionRuntime` 管理自定义动作接管、handoff、neutral pose 恢复和场景时间选择；`Live2DCharacterGeometry` 管理 transform、相机投影、透明度保护和组合模型锚点；`Live2DRimLightController` 管理轮廓光、补间、积压命令及 Seek 重建。

### Cubism 2 expression lifecycle

`Cubism2ExpressionLifecycle` 在 runtime 内管理普通表情播放、请求代次、队列清理和 Seek 前代表情淡入重建。异步加载后及提交前都会校验模型和代次；清空、idle 重置、quiesce 与 dispose 会使旧请求失效。清理停止真实表情队列并释放 reservation，不调用会重新入队默认表情的 SDK `resetExpression()`。Seek 通过前代表情与目标表情两阶段重建时钟，并延迟几何提交；组合角色逐个具体模型处理。

### Cubism 3+ renderer limitation

Cubism 3/4/5 使用 `untitled-pixi-live2d-engine` 的 `cubism` 入口，Cubism 2 使用其 `cubism-legacy` 入口；`Live2DEngineBridge` 加载入口并注册共享原生 Pixi 绘制管线。预览质量跟随舞台 renderer resolution，Bake 通过 Pixi v8 RenderTexture 绘制。高版本 runtime 只要求用户提供 `live2dcubismcore.min.js`，不引入官方 Framework 包。

当前锁定的上游引擎不支持离屏部件合成及扩展颜色/透明度混合；含这些效果的模型仍可加载，但相应效果可能缺失。普通 drawable 遮罩及兼容的正常、加算、乘算混合继续由原渲染器支持。

## Implementation References

- Runtime boundary: `src/engine/runtime/Live2DRuntimeContracts.ts`, `src/engine/Live2DRuntimeAdapter.ts`, `src/engine/live2d/runtime/`.
- Resource ownership: `src/engine/Live2DModelResources.ts`, `src/engine/BakeEngine.ts`.
- Stage orchestration: `src/engine/Live2DStageRuntime.ts`, `src/engine/Live2DManager.ts`, `src/engine/live2d/Live2DCustomMotionRuntime.ts`, `src/engine/Live2DCharacterGeometry.ts`, `src/engine/Live2DRimLightController.ts`.
- Cubism 2 expression lifecycle: `src/engine/live2d/runtime/Cubism2ExpressionLifecycle.ts`, `src/engine/runtime/Cubism2PixiLive2DModelControls.ts`.
- Verification: `npm run check`; focused coverage in `src/__tests__/Live2DRuntimeAdapter.test.ts`, `src/__tests__/Live2DModelResourceLifecycle.test.ts`, `src/__tests__/Live2DStageRuntime.test.ts`, `src/__tests__/Cubism2ExpressionLifecycle.test.ts` and related runtime integration tests.
