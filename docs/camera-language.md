# 镜头与投影词汇表

行为决策以 [ADR-0038：统一摄像机求值](adr/0038-unified-camera-evaluation.md) 为准；本页是术语入口，不另设求值规则。

| 术语 | 当前含义与边界 |
| --- | --- |
| 镜头位姿 / camera pose | 基础位置、画面缩放 `zoom` 与镜头平面旋转 `rotation`；不含画面抖动。位置使用归一化场景坐标，旋转使用角度。 |
| 属性通道 / property channel | x、y、zoom、rotation 的独立写入轨道。实际写入集合由编译后的属性轨道决定，完整位置写入两轴。 |
| 构图聚焦 / framing focus | 在动作起点捕获指定角色部位或构图点，完成一次固定目标移动；source 的 `focus` 不表示光学对焦。 |
| 跟随 / follow | 持续平滑追赶角色世界锚点加编排偏移，由 stop、reset 或位置接管释放，不接受跟随时长；位置不受可见区域或舞台边界钳制，缩放不改变追赶目标；完整历史重建需要按场景时间查询的只读锚点轨迹。 |
| 角色锚点 / character anchor | 角色原点或部位在指定场景时间的归一化位置；轨迹有效区间、事件左右侧和版本属于求值输入。 |
| 跟随平滑度 / follow smoothing | 0–1 映射为 0–2 秒追近静止目标距离的 90%；0 立即跟随，数值越大追赶越缓，1 仍持续追赶。默认 0.85，响应与帧率无关。 |
| 画面缩放 / zoom | 画面的缩放倍率；不等同于空间推近或焦距。 |
| 镜头平面旋转 / camera-plane rotation | 画面围绕中心的二维旋转；求值与实际投影接入是不同职责。 |
| 路径 / camera path | 各属性独立的关键帧运动；关键帧时间决定节奏，`durationSeconds` 补充编排占用范围。 |
| 画面抖动 / screen shake | 投影后的二维画面偏移，以合成创作单位计量；不进入基础位置，不再受镜头深度、缩放或旋转影响。 |
| 世界 / 局部坐标 | 场景中的位置及相对角色或图层的位置，区别于投影后的画面坐标。 |
| 合成参考尺寸 / logical reference size | 遵循 [ADR-0037](adr/0037-project-video-format-and-native-resolution-export.md) 的创作单位尺寸；编辑器视口与输出像素换算在其后发生。 |
| 艺术化投影 / artistic projection | 当前 `z` 影响视差的既有模型；该深度不是物理透视距离，绘制排序也不是空间深度。 |
| 临时预览 / standalone preview | `focusOn()`、`shake()`、`executeMotion()` 等独立调用，不保存到正式场景；统一求值与清理生命周期仍待后续实现。 |

## 实现对齐与剩余差异

- 不依赖角色锚点的正式场景，通过 [`CameraCoordinator`](../src/engine/coordinators/CameraCoordinator.ts) 在播放和 seek 中消费 [`evaluateCameraChannels`](../src/engine/CameraChannelEvaluator.ts)。[`cameraActions`](../src/engine/actions/cameraActions.ts) 保留场景时长与播放 hook，不为这些正式通道创建 GSAP 镜头属性 tween。GSAP 缓动函数继续用于纯求值。
- 正式场景中的角色 focus/follow 与基础通道由统一摄像机求值消费；历史查询使用隔离的按时间锚点轨迹。播放、seek 和 export 已接入同一套求值规则。Bake 只产出 Live2D 快照，不准备镜头轨迹或写入镜头状态；历史几何由独立采样器准备。Hitchcock source 已退役，但 parser、compiler、resolver 与 runtime 的残留清理仍待后续完成。
- 角色、环境和图像显示对象消费旋转投影，屏幕空间 UI 保持在独立容器；逻辑参考尺寸在输出像素换算前保持一致。独立临时预览（`focusOn()`、`shake()`、`executeMotion()`）的统一求值与清理生命周期仍待后续实现。
- 正式加载与最终位姿验收见 [`ScriptEngineCameraChannels.test.ts`](../src/__tests__/ScriptEngineCameraChannels.test.ts)，通道生命周期与确定性矩阵见 [`CameraPlaybackChannels.test.ts`](../src/__tests__/CameraPlaybackChannels.test.ts)。
