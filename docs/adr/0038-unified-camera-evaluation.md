---
status: accepted
---

# 统一摄像机求值

正式场景的播放、seek 与逐帧导出需要对同一时间线产生一致的镜头通道状态。镜头位置又依赖角色可见部位，不能把角色姿态历史当作可免费读取的数据。本 ADR 定义场景镜头的通道语义、角色锚点边界与投影顺序。

## Decision

### 通道与时间线

- 摄像机位姿由归一化场景位置 `x`、`y`、缩放 `zoom` 和画面旋转 `rotation` 组成。四个属性独立接管；显式完整位置同时写入 `x`、`y`。
- 同一时刻按 source statement order 求值。每个动作从开始时该属性的实际值接管，结束值保持；被后续动作接管的旧动作不恢复。首个写入前使用默认位姿：位置 `(0.5, 0.5)`、缩放 `1`、旋转 `0`。
- `focus` 在动作开始时捕获角色部位或显式构图点，执行一次定点构图移动；它不表示光学对焦。目标在动作起点不可用时跳过位置移动、返回诊断，并在本段保持缺失，不改用原点或稍后补捕获。缩放和旋转仍可独立生效。
- `cameraPath` 按属性分别插值关键帧。非零时间的首帧从动作起点实际值过渡，零时刻首帧立即生效。关键帧时间决定运动节奏，`durationSeconds` 只决定时间线占用范围，不拉伸或截断路径。`loop` 优先于 `repeat`，`repeat: -1` 表示无限循环；有限重复计入动作时长，无限循环不延长场景范围。`yoyo` 让交替轮次反向播放。
- `cameraFollow` 与 `cameraUnfollow` 是瞬时事件，不带跟随时长，也不延长场景。跟随持有位置通道，直到 stop、reset、另一个跟随事件或写入位置的运镜释放它；只写缩放或旋转的动作保留跟随。
- 跟随追赶角色世界锚点加编排偏移，不受舞台边界或缩放钳制。平滑度 `smoothing` 限定在 0–1，默认 `0.85`，映射为 0–2 秒内追近静止目标距离的 90%；0 表示立即跟随，数值越大追赶越缓，1 仍持续追赶。响应按秒计算，与帧率无关。
- `cameraShake` 是按场景时间求值的有限画面偏移；多个震动可叠加，持续时间结束后归零。`cameraReset` 释放跟随和此前震动，并将位置、缩放、旋转恢复到默认值。
- `zoom` 使用 `{ kind: 'absolute' | 'delta', value: number }`，明确区分目标倍率与倍率变化。退役的 `cameraHitchcock` 不参与正式摄像机求值，并返回退役通道诊断。

### 角色锚点与运行时边界

- 基础属性通道、路径、震动和无角色目标的聚焦由 `evaluateCameraChannels` 按场景时间纯求值。正式时间线通过 `CameraCoordinator` 在播放、seek 与导出时同步解析结果；GSAP 保留场景时钟、事件和缓动职责，不竞争写入这些通道。
- 角色聚焦和跟随读取活动舞台上的模型部位几何，并叠加该场景时刻的角色编排位置。播放期间跟随控制器通过 ticker 保留实际追赶位置；暂停和渲染读取不重新吸附。seek 与导出按目标时刻重建相机，使用当时的编排位置和可见模型部位偏移，不模拟完整的历史角色姿态。因此，含角色运镜的 seek 落点不承诺复现此前播放路径的精确跟随历史。
- 角色部位锚点在目标时刻不可用时返回缺失值，不回退到角色原点、画面原点或其他时刻的模型。跟随在锚点暂时缺失时保持最后有效位置；目标重新可用后继续追赶。
- 单独调用 `focusOn()`、`shake()`、`executeMotion()` 等 API 属于临时预览，不写入场景时间线。场景重载、seek 和正式导出会清除临时镜头动画、震动与跟随状态。
- Bake 只生成 Live2D 姿态快照，不生成摄像机轨迹或镜头状态。导出等待场景加载完成，再按逐帧目标时间 seek 和捕获。

### 坐标与投影

- 镜头位置、角色锚点与编排偏移使用归一化场景坐标；舞台逻辑尺寸沿用 [ADR-0037](0037-project-video-format-and-native-resolution-export.md) 的约定，短边为 1080 个创作单位。编辑器视口和输出像素换算在逻辑场景投影之后处理。
- `zoom` 表示画面缩放，不表示空间推近或改变焦距。当前 `z` 影响艺术化视差，不代表物理透视距离；绘制排序与空间深度分别处理。
- 镜头旋转作用于角色、环境层与图片的画面投影；字幕等屏幕空间 UI 保持独立。画面震动在投影后、视口或输出像素换算前叠加，不改变基础镜头位置。
- `getPoint()` 返回角色世界锚点；`getScreenPoint()` 返回经过当前镜头投影的画面坐标。两者分别用于镜头构图与屏幕交互。

## Consequences

- 纯时间线通道的播放、seek 与导出共享相同的场景时间求值规则。
- 角色跟随的连续播放保留实际 ticker 位置；seek 与导出按目标时刻的可用几何重建落点，不承诺完整历史姿态确定性。
- 场景编排、镜头求值与角色模型模拟保持分离。新增投影或光学效果按其坐标语义扩展求值或渲染接口，不复用含义不同的现有字段。

## Implementation alignment

- 通道求值与诊断：[`CameraChannelEvaluator.ts`](../../src/engine/CameraChannelEvaluator.ts)、[`CameraStateResolver.ts`](../../src/engine/CameraStateResolver.ts)
- 时间线同步、聚焦锚点与跟随交接：[`CameraCoordinator.ts`](../../src/engine/coordinators/CameraCoordinator.ts)、[`ScriptEngine.ts`](../../src/engine/ScriptEngine.ts)
- 跟随平滑与画面震动：[`CameraFollowSmoothing.ts`](../../src/engine/CameraFollowSmoothing.ts)、[`CameraShake.ts`](../../src/engine/CameraShake.ts)
- 角色舞台锚点：[`cameraAnchorResolver.ts`](../../src/engine/cameraAnchorResolver.ts)
- 投影与舞台逻辑尺寸：[`Projection.ts`](../../src/engine/Projection.ts)、[`StageDimensions.ts`](../../src/engine/StageDimensions.ts)
