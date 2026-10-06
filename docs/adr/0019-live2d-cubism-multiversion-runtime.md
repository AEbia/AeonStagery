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


下一阶段接入 Cubism 5 时，优先填充 `OfficialCubismWebLive2DAdapter` 的 init/create/model control 能力，而不是继续在 `Live2DManager`、`Live2DMotionController` 或 `BakeEngine` 中新增 Cubism 5 私有字段分支。
