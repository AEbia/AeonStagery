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

## Implementation Notes

当前实现已经建立三层边界：

- `Live2DModelEntry` 负责共享 entrypoint 与 runtime family 识别。
- `Live2DRuntimeResolver` 负责把 runtime family 映射到 adapter id 与支持状态。
- `Live2DRuntimeAdapter` 负责 runtime 初始化与模型实例创建。

Cubism 2 当前由 `Cubism2PixiLive2DAdapter` 包住 `untitled-pixi-live2d-engine/cubism-legacy` 路径，保留现有兼容修复。Cubism 3/4/5 由 `CubismPixiLive2DAdapter` 使用 `untitled-pixi-live2d-engine/cubism`，只需要用户提供 `live2dcubismcore.min.js`。`Live2DEngineBridge` 集中加载两个入口，并注册能够识别两个入口模型实例的共享原生 Pixi 绘制管线。

### 2026-10-05: Cubism 3/4/5 implementation replacement

- 原 `official-cubism-web` adapter、`@cubism/*` generated SDK alias、独立画布和外部 Shader 链路移除。运行时描述与临时快照使用 `untitled-pixi-live2d-engine-cubism` adapter ID。
- `CubismPixiModel` 在现有 controls interface 后适配新引擎：提前执行模拟使 Seek、参数读取、快照和 Bake 不依赖下一次绘制；渲染不重复推进模拟。
- 保留场景淡入覆盖与文件淡入恢复、动作结束姿势、命名空间动作组、表情清理与异步取消、确定性 blink/breath、Core 更新前的参数注入以及多模型扩容后的内存视图刷新。
- 使用引擎内置的原生 Pixi 渲染，预览质量随舞台 renderer resolution 生效；Bake 通过 Pixi v8 RenderTexture contract 绘制。
- Cubism 2.1 的 core、动作与私有 controls 不变。3/4/5 的 Core 缺失时仍只在对应模型加载处报告明确错误。
- 当前锁定的 npm 引擎尚不支持离屏部件合成及扩展颜色/透明度混合模式；含这些效果的模型继续允许加载，但渲染结果可能缺失相应效果。普通 drawable 遮罩及兼容的正常、加算、乘算混合继续使用原渲染器。高版本运行时只使用一个用户提供的 Core，不新增官方 Framework 包。

Implementation: `src/engine/CubismPixiSdk.ts`, `src/engine/CubismPixiModel.ts`, `src/engine/Live2DEngineBridge.ts`, `src/engine/Live2DRuntimeAdapter.ts`.
Upstream: <https://github.com/Untitled-Story/untitled-pixi-live2d-engine>.

### 2026-10-10: Model resource ownership

`Live2DModelResources` 收拢原 `Live2DModelLoader` 的读取/缓存能力，以及原 `Live2DManager` 的加载取消、模型池取还、组合模型组装和纹理引用计数。模型池、加载任务和所有权记录全部私有；`Live2DManager` 通过 `loadCharacter` 借用实例，通过借用结果的 `release()` 归还，保留舞台编排、角色运行时清脏及积压指令处理。

- 同角色加载串行化。取消后的迟到实例和组合模型的部分加载结果由资源 Module 回收；舞台异步预热后必须检查 `isCurrent()` 才能展示。回收还校验实例当前所有者，避免旧回调误收已经归还并被另一角色借用的实例。
- 纹理引用按具体模型的解析 URL 记录，覆盖创建中、预加载、舞台借用及池内实例；取还不改变引用数，实际销毁才递减。组合容器自身不持有纹理引用，具体模型分别使用自己的 Adapter 销毁，避免重复销毁。
- `clear()` 推进资源代次，取消旧加载及旧排队请求，销毁池内实例；旧异步结果不能重新填池，也不能删除新代次的任务。未完成任务仍纳入 `waitForLoads()`。
- 模型池每 URL 最多保留 10 个根实例。容量溢出时，只允许最后一个具体模型引用释放对应纹理；整场清空继续保留与独立 Bake 模型共享的 SDK/浏览器纹理。

Implementation: `src/engine/Live2DModelResources.ts`, `src/engine/Live2DManager.ts`.
Verification: `src/__tests__/Live2DModelResourceLifecycle.test.ts`, `src/__tests__/Live2DModelResources.test.ts`, `src/__tests__/SeekStaleStatePurge.test.ts`.

### 2026-10-12: Stage orchestration modules

`Live2DManager` 保留调用接口和角色登场/移除顺序，把下列实现集中到内部 Module：

- `Live2DCustomMotionRuntime`：自定义动作接管、handoff 身份缓存、未覆盖参数的中立姿态恢复、Motion-stage writer 安装及场景时间选择。退出仍使用共享 `releaseCustomMotionOwnership`。
- `Live2DCharacterGeometry`：传统 transform、相机投影、AlphaFilter 透明度保护、组合模型语义锚点及稳定采样范围。
- `Live2DRimLightController`：轮廓光配置/补间、登场后的积压命令恢复、绝对时间 Seek 重建和移除时的 tween 清理。

积压命令容器仍由 `Live2DStageRuntime` 持有并统一清空；模型借用/归还仍由 `Live2DModelResources` 持有。新 Module 通过已有 runtime Adapter 操作模型，不增加 runtime family 分支或新的 Adapter seam。

Implementation: `src/engine/live2d/Live2DCustomMotionRuntime.ts`, `src/engine/Live2DCharacterGeometry.ts`, `src/engine/Live2DRimLightController.ts`.
Verification: `src/__tests__/CharacterEntranceCustomMotion.test.ts`, `src/__tests__/CustomMotionLipSyncMouthProtection.test.ts`, `src/__tests__/Live2DManagerGetPoint.test.ts`, `src/__tests__/Live2DFadeAlphaFilter.test.ts`, `src/__tests__/Live2DRimLight.test.ts`, `src/__tests__/SeekStaleStatePurge.test.ts`.


### 2026-10-11: Bake resource ownership

Stage 与 Bake 各持有独立的 `Live2DModelResources`，共享同一所有权实现。用途在构造时固定；模型创建、runtime 识别、registry 查询、组合组装、池与回收策略都留在资源 Module。BakeEngine 只负责隐藏容器、发布前模型准备、场景时间推进与快照采集；prepared source identity 与 resolved runtime URI 一起进入获取接口。

- `loadCharacter` 交付带 `isCurrent()` 与 `release()` 的借用结果。归还绑定实际所有权记录，旧回调和重复归还不会回收已经被其他角色借用的实例；实际创建 adapter 同样记录在所有权上。
- `cancelLoads()` 使当前任务及其排队获取失效，但保留已加载模型，迟到创建归入该 Module 的池。获取同角色的不同 source/runtime 路径会替代旧获取；替代结果与被明确 `discard` 的借用不再进入池。
- `close()` 永久禁止获取，同步使旧交付失效并回收全部现有所有权。SDK 请求无法同步终止时，迟到结果只能回收；`waitForLoads()` 继续覆盖请求和交付准备，BakeEngine 在同步关闭时移除隐藏容器并暴露相同等待接口。
- Bake 具体模型按实际 adapter 回收：Cubism 2 保留 soft-detach 约束；其他 adapter 销毁实例并保留共享纹理。组合容器不重复回收子模型。Stage 的池上限、具体 URL 纹理引用与 clear 语义沿用现有实现。
- 组合主模型失败终止，子模型创建失败继续；设置失败和取消回收已获取实例，部分组装失败后丢弃已安装 sync hook 的子模型。Bake 发布准备失败时丢弃未交付实例，避免残缺 hook 进入池。归池及关闭先静止 SDK 通道并清除旧借用者引用，Cubism 2 参数 hook 只读取当前绑定。

Implementation: `src/engine/Live2DModelResources.ts`, `src/engine/BakeEngine.ts`, `src/engine/Live2DManager.ts`.
Verification: `src/__tests__/Live2DModelResourceLifecycle.test.ts`, `src/__tests__/BakeResourceIntegration.test.ts`, `src/__tests__/BakeEngine.test.ts`.


### 2026-10-12: Runtime capability consumption

Stage、Motion、Seek 和 Bake 编排优先读取 `runtimeHandle.capabilities`；资源加载前的能力分类与 descriptor-only entry 的兼容路径统一使用 `Live2DRuntimeControlModule`。Adapter ID 仍用于 Adapter 选择、诊断和曲线缓存 identity，行为选择使用能力声明，覆盖共享 SDK 时钟、零步长姿态求值、动作 handoff、快照、组合模型和加载失败占位模型。

- Cubism 2 的 `supportsNativeMotionOffset` 为 false，`supportsMotionOffsetReplay` 为 true，tier 为 `offset-replay-deterministic`。目标 offset 依赖共享 SDK 时钟的 50ms 固定步重放；没有时钟不能完成重放，Physics 在重放期间被禁用，`supportsStateReplay` 仍为 false。
- Cubism 3+ 的 `supportsNativeMotionOffset` 为 true，`supportsMotionOffsetReplay` 为 false。Seek 使用直接队列 offset，强制零步长帧提交姿态，暂停时避免重复执行 writer；这不声明完整 Physics/Pose/LookAt 状态重建。
- 已加载 handle 的能力优先于 descriptor；没有 handle 的旧 entry 才使用 descriptor 分类，没有 descriptor 的旧 entry 保留 Cubism 2 默认行为。`supported: false` 的 descriptor 不声明执行能力。

Implementation: `src/engine/live2d/runtime/Live2DRuntimeControlModule.ts`, `src/engine/Live2DStageRuntime.ts`, `src/engine/Live2DModelResources.ts`, `src/engine/Live2DMotionController.ts`, `src/engine/Live2DManager.ts`, `src/engine/coordinators/CharacterSynchronizer.ts`, `src/engine/BakeEngine.ts`.
Verification: `src/__tests__/Live2DRuntimeControlModule.test.ts`, `src/__tests__/Live2DStageRuntime.test.ts`, `src/__tests__/CharacterSynchronizer.test.ts`.

后续 runtime 能力扩展优先填充对应 Adapter 的 init/create/model control 与能力声明，而不是继续在编排层新增 runtime 身份或私有字段分支。

### 2026-10-12: Accepted runtime behavior Interface migration (planned)

`Live2DRuntimeModelControls` 当前把两个 SDK 的内部结构及操作协议铺成了公共 Interface；`Live2DModelHandle` 的分组转发尚未收回调用方对 Core、子模型、focus controller 和共享时钟的知识。这是本 ADR 要求 SDK 私有操作留在 Adapter 内的 implementation gap。

仓库内所有调用方迁移到绑定模型、表达完整行为的 Interface，最终删除公共 `getControls()`、raw model/Core/子模型/focus controller/采样目标 getter。初始化、动作交接、帧提交与 Seek 恢复各自封装运行时操作顺序；动作采样向调用方交付 runtime-neutral 数据。显示对象只提供类型明确的 Pixi 显示能力。时间轴选择仍由编排 Module 负责，模型池、借用取消及纹理所有权仍由资源 Module 负责。

这是行为保持的重构：保留 Cubism 2 组合模型同步、动作交接、隔离采样、soft-detach，以及 Cubism 3+ 原生 offset 和零步长姿态提交的既有承诺。共享 SDK 时钟锁由运行时实现统一管理，覆盖预览、Seek、采样和 Bake，避免外围批次与模型内部操作重复取锁。参数 UI 与工作区工具改用中立参数描述和值；动作转换、缓存预热、Seek 与 Bake 均通过采样行为取得数据。

选择完整行为方法，是为了让现有时间轴编排继续决定角色意图，同时由运行时 Module 收回 SDK 协议。每帧提交全部角色目标状态的声明式重写会同时改变编排状态模型，本次没有采用。迁移过程中允许旧形式暂时存在以保持验证可运行；最终删除旧公共契约是交付条件。

本节记录已接受的目标，尚不声明实现完成。实施规格、完成条件与迁移切片在本地 issue tracker 的 19 号条目维护；该 tracker 按仓库约定仅用于本地流程。

### 2026-10-12: Bound initialization and neutral character inspection (implemented slices)

初始化与重置切片已经完成：Stage 和 Bake 通过绑定 handle 的 `initialize`、`bindRuntimeSource`、`resetRuntimeState`、`quiesce` 与 `dispose` 请求完整操作。遮罩隔离、预热、idle flush、主模型 baseline 与组合模型 pristine neutral pose 留在 runtime implementation；资源 Module 继续持有借用、池与纹理所有权。

参数与角色检查切片通过 `inspectParameters` 返回独立的参数 ID、索引、显示名称、当前值及可用范围，通过 `editParameters` 在 runtime 内将旧工作区索引解析为 ID。每个具体模型在批量写入后只提交一次几何，组合模型的参数传播留在实现内。参数面板与工作区保留前 20 个参数、播放中禁用编辑、模型不可用的处理及 reload 后恢复播放位置的行为。

`CharacterInfo` 返回独立的 model path、配置、adapter identity 与确定性能力描述，供 reload、资源缓存 identity 与 Seek 行为选择使用。Stage/CharacterAdapter 的 `getModel`、`getCoreModel`、`getAllCharacters` 及绑定 handle 的 Core getter 已删除；动画与 transform target 只取得类型明确的 Pixi `Container`。

剩余 implementation gaps：中立动作采样、完整 performance/Seek/frame 行为、统一 SDK 时钟与 Bake transaction 协调尚未迁移。旧 controls contract、raw model fields、sampler target getters 及相关公共 re-exports 暂时保留，最终删除仍是完整迁移的交付条件。

Implementation: `src/engine/live2d/runtime/BoundModelInitialization.ts`, `src/engine/live2d/runtime/BoundModelParameters.ts`, `src/engine/Live2DManager.ts`, `src/api/adapters/CharacterAdapter.ts`, `src/engine/coordinators/CharacterSynchronizer.ts`.
Verification: `src/__tests__/Live2DBoundInitialization.test.ts`, `src/__tests__/Live2DBoundParameters.test.ts`, `src/__tests__/CharacterInspection.test.ts`, `src/__tests__/CharacterDirectoryParameters.test.tsx`, `src/__tests__/useWorkspaceToolsBridge.test.tsx`, existing animation/Seek/resource integrations and `npm run check`.

Combined verification for these slices: `npm run check` passed 514 files, 5625 tests and TypeScript on 2026-10-12.
