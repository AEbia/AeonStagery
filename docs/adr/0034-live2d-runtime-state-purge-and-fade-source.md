# 0034 Live2D 运行时状态清理与淡入来源权威

- 状态：current, implemented
- 日期：2026-09-06
- 关联：ADR-0019（runtime seam）、ADR-0029（自定义 Motion 关键帧）、ADR-0033（资源 Motion 曲线缓存与 Seek 求值）
- 代码入口：`src/engine/live2d/characterStatePurge.ts`、`src/engine/Live2DMotionController.ts`、`src/engine/Live2DManager.ts`、`src/engine/coordinators/CharacterSynchronizer.ts`、`src/engine/ScriptEngine.ts`、`src/engine/live2d/customMotionRuntime.ts`

## 问题

Seek / 编辑后重放时，画面会继续播放上一个时间点的动作或表情——在**淡入窗口内最明显**。原因是多个持有姿态的通道各自独立地在 seek 后继续写入：

1. **SDK 动作队列没有被真正停止。** 重建 seek 时 `resetToIdle` 为了避开异步 `_hardReset` 的 T-pose 闪烁，只清了 `injectedParams` 就返回；`clearMotionState` 也只清 `motionManager.state` 记账字段，而 Cubism 2 的 `MotionQueueManager` 用自己的条目表继续写曲线。
2. **Seek 边界姿态被反复重放。** `entry.pendingSeekBoundarySnapshot` 在 handoff 窗口（`LIVE2D_MOTION_HANDOFF_OFFSET_SECONDS`）内每帧被重新 apply，而这个姿态属于上一次 seek。
3. **模型实例被带着脏姿态回收复用。** `removeCharacter` 把模型实例放回 `preloadedModels` 池，`addCharacter` 复用它时只重置 visible/alpha，而 `idleSnapshot` 是在旧姿态上启 idle 动作 16ms 后捕获的（Cubism 淡入权重≈0），于是「中性姿态」被污染成上一个动作。
4. **表情淡入源取自模型的存活状态。** `setExpressionForSeek` 把 `expressionManager.currentExpression` 当作常驻前代表情，而它属于上一次播放/seek 的位置，可能根本不在 seek 目标之前。
5. **轻 seek（场景编辑走的就是这条路）几乎不做清理。** `clearAllPendingMotions()` 只在重建分支调用，排队意图、`customMotion`、边界快照全部存活。
6. **淡入累积缓存对原地修改不敏感。** `fadeCacheByHandoff` 只按 motion 对象身份失效，原地改关键帧会在整个淡入窗口继续用旧曲线。
7. **「中性姿态」基线本身是脏的。** `resetCoreParams()` 优先走 `core.loadParam()`，但 `Cubism2InternalModel.update()` 每帧都在动作队列 update 之后调用 `coreModel.saveParam()`（帧末再 `loadParam()`），所以从第一帧起 SDK 的保存缓冲里装的是「上一帧的动作姿态」而不是 idle 姿态。`loadParam()` 于是把上一个动作（含它自带的表情）当成中性姿态还原——这正是「入场淡入从之后的某个动作 B 开始」的来源。
8. **Part opacity 不在任何重置原语覆盖范围内。** Cubism 2.1 的表情大量走 part 显隐，`.mtn` 也带 `PARTS_*` 曲线；而 `saveParam()`/`loadParam()` 只搬运 `paramFloatValues`，`resetCoreParams()` 完全不碰 part opacity。

## 决策

### 1. 单一清理原语 `purgeCharacterRuntimeState`

`src/engine/live2d/characterStatePurge.ts` 是「清脏」的唯一实现，所有入口必须走它，不再各自清一部分：

- 释放自定义动作所有权（`releaseCustomMotionOwnership`：注销 Motion-stage writer、恢复 SDK 眨眼、释放受控参数）；
- 丢弃排队意图并推进 `motionEpoch`（让在途的 `_executePlayMotion` 失效）；
- 清空动作记账：`motionStartTime` / `motionStartUtTime` / `lastOffset` / `pendingSeekBoundary*` / `lastSnapshot`；
- 清空 `injectedParams`（lip-sync 通道豁免，它自己按所有权释放）；
- 停止 SDK 动作队列（`stopAllMotions` + `clearMotionState`）；
- 清空表情通道（`setExpression(model, null)` + `expressionKey = null`）；
- 可选 `restoreNeutralPose`：回到 `idleSnapshot` 或 SDK 默认参数。

### 2. 调用点

| 入口 | 语义 |
| --- | --- |
| `ScriptEngine._doSeek` 两个分支（重建 / 轻 seek） | 在 `syncAllStates` 之前对所有已加载角色清理；轻 seek 是场景编辑走的路径，必须同样清理 |
| `Live2DMotionController.resetToIdle` | 重建期也要同步停止队列（只保留「不做异步硬重置」这条例外，避免 T-pose 闪烁） |
| `Live2DManager.removeCharacter` | 带 `restoreNeutralPose` 清理后再把实例放回预加载池 |
| `Live2DManager.addCharacter` 复用池内实例时 | 先 `resetModelToNeutralPose` 再捕获 `idleSnapshot`，保证中性基线干净 |

### 3. `clearMotionState` 必须真的停止播放

两个 runtime 的 `clearMotionState` 都先 `stopAllMotions` 再清记账字段。调用方（`clearAllPendingMotions`、`_hardReset`、BakeEngine）本来就把它当「没有动作状态」用。

### 4. 淡入来源必须由场景裁定，不能读模型存活状态

- 表情：`ScriptEngine.resolveExpressionPredecessors` 从 `computeStateAtTime(startTime - ε)` 解析目标表情的前代表情，经 `CharacterSynchronizer` → `setExpressionForSeek(..., previousKey)` 传入 adapter。adapter 在 `previousKnown` 时**只**用解析结果；没有前代就传 `null`（不从默认/存活状态猜）。`undefined` 仅用于未接入场景解析的旧调用方。
- 自定义动作：淡入累积缓存额外记录内容签名（`motionFadeSignature`），原地改关键帧会让签名变化并重建累积帧。

### 5. 中性基线必须随模型实例捕获，不能靠 SDK 的 `saveParam`/`loadParam`

针对问题 7 / 8：

- `captureModelNeutralPoseOnce(model)` 在每个 `internalModel` 上以 `__aeonstageryNeutralPose` 记录**第一次**看到的姿态（参数 + part opacity）。捕获点是 `Live2DModelLoader` 建实例之后、以及 `resetModelToNeutralPose` 的开头——都必须早于该实例的第一次 `model.update()`，否则捕获到的已经是动作姿态。实例进预加载池后标记仍在，所以复用时仍能还原自己的 pristine 姿态。
- `restoreNeutralModelPose` / `resetModelToNeutralPose` 还原时优先用这份捕获（参数 **和** part opacity），其次 `entry.idleSnapshot`，最后才退回 `resetCoreParams()`。后者只写参数，且 `loadParam()` 在模型已经跑过一帧后拿到的是上一帧动作姿态，因此只能当兜底。

## 后果

- Seek / 编辑后重放的第一帧不再残留上一个时间点的动作或表情；淡入窗口从「正确的起始姿态」开始混合。
- 场景编辑走轻 seek 也付一次清理成本（同步、无 await），换来与重建 seek 一致的语义。
- 回收复用的模型实例不再继承上一个角色的姿态/表情；`idleSnapshot` 是真正的中性基线。
- 排队意图在 seek 后不再落地，代价是 seek 后必然重新决策是否重启动作（`lastOffset` 被清空）。

## 回归测试

`src/__tests__/SeekStaleStatePurge.test.ts`：重建 seek 停止队列并回到中性姿态、边界姿态与排队意图被丢弃、回收实例为中性、原地编辑在淡入窗口内生效、表情淡入源使用前代表情而非模型存活表情、轻 seek 会清理。

`src/__tests__/Live2D21MotionSwitchResidue.test.ts`：按真实 Cubism 2 runtime 的双打（每帧 `saveParam()`）——回收复用的实例被还原成模型自己的 idle 姿态，而不是上一个/之后播放过的动作姿态。
