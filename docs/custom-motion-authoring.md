# Custom Motion Authoring Reference

自定义 Motion 已作为 scene schema v5（当前 schema epoch，支持自 v3/v4 自动迁移）的能力实现。用户从已有 Cubism 2.1 资源 Motion 发起显式转换，得到场景内联、自包含的 Parameter 关键帧副本；源 `.mtn` 不被修改，也不再是该副本播放时的依赖。

权威产品与数据契约见 [ADR-0029](adr/0029-live2d-custom-motion-keyframe-authoring.md)，协作编辑权与并发租约见 [ADR-0028](adr/0028-scoped-custom-motion-edit-lease.md)，演进兼容与 scene v5 迁移见 [ADR-0031](adr/0031-evolution-compatibility-policy.md) 与 [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md)。本页只提供实现入口和维护检查，不复制完整需求。

## 用户流程

1. 在时间线上选中已有资源 Motion，通过 Inspector 或片段菜单选择“转为自定义动作”。
2. 选择稀疏、标准、精细或逐帧密度。转换命令读取已加载的 Cubism 2.1 模型并原子生成关键帧；失败时不修改场景。
3. 在时间轴展开编辑器，使用轨道、曲线或列表视图修改关键帧时间、数值与分段，并调整 Motion 时长或淡入。支持多关键帧框选/多选与成组移动（Group Move），并在多端协作时维护并发编辑租约。
4. 需要重新采样时选择“重新转换”。该操作从 `derivedFrom` 指向的源动作整体重建轨道，会替换已有关键帧、逐轨道淡入与裁剪结果。

首版不能从空白创建自定义 Motion，不烘焙呼吸、眨眼、口型、physics 或 Parts 曲线，也不修改原始 Motion 文件。Cubism 3/4/5 共用数据抽象，但当前转换入口只支持已加载的 Cubism 2.1 模型。

## 运行时曲线缓存（区别于作者态转换）

除了用户显式“转为自定义动作”，加载场景时还会为**全部普通资源 Motion** 生成一个隐藏的逐帧曲线缓存（ADR-0033）。它不写入 scene 文档，也不产生 `derivedFrom` 持久化依赖；只用于运行期 Seek / Play / Bake / Export 的曲线求值。缓存采样使用与作者态转换相同的 `cubism2MotionSampler`，但关闭源淡入烘焙、跳过缺失参数，并把淡入由运行时 `customMotionRuntime` 从 handoff 姿态重建。

- 作者态转换 = 用户可见、原子写入、可编辑的关键帧副本。
- 运行时缓存 = 系统派生的只读求值数据，失败时静默回退 SDK Motion Queue。

新增实现入口：`src/engine/live2d/motionCurveCache.ts`、`src/engine/SeekProfiler.ts`。

## 持久化与迁移

`characterPerformance.params.motion` 使用严格判别联合：

```ts
type CharacterMotionOutput =
  | { kind: 'resource'; key: string; fadeInSeconds?: number }
  | {
      kind: 'custom';
      durationSeconds: number;
      fadeInSeconds: number;
      derivedFrom: { key: string; fadeInSeconds?: number; fadeOutSeconds?: number };
      tracks: CustomMotionTrack[];
    };
```

新保存的 scene 固定为 `schemaVersion: 5`（`SceneDocumentV5` 为当前激活的 schema epoch；开发期 v3 与历史 v4 scene 在加载时由兼容性迁移链路自动升级为规范 v5）。生产 v2 action scene 仍通过 `migrate:scene-v2` 离线迁移。

## 实现入口

| 模块 | 职责 |
| --- | --- |
| `src/api/types/semantic-scene.ts` | Motion 判别联合、轨道、关键帧与分段类型 |
| `src/services/semantic-scene/SceneStatementDefinitionRegistry.ts` | 严格 codec 与 F0、时间、分段、轨道唯一性校验 |
| `src/engine/live2d/customMotion.ts` | 四种分段的纯求值器 |
| `src/engine/live2d/cubism2MotionSampler.ts` | Cubism 2.1 曲线采样与组合模型合并 |
| `src/engine/live2d/customMotionConversion.ts` | 密度档位、自适应拟合与转换结果组装 |
| `src/engine/live2d/customMotionRuntime.ts` | 运行时求值、淡入混合与 Parameter 应用 |
| `src/services/timeline-authoring/CustomMotionConversionCommand.ts` | 校验、采样、租约与原子转换提交 |
| `src/services/timeline-authoring/CustomMotionKeyframeEditCommand.ts` | 关键帧编辑、租约门控与单条 Undo 记录 |
| `src/ui/timeline/CustomMotionEditor.tsx` | 轨道、曲线和列表编辑界面 |
| `src/ui/timeline/customMotionSelection.ts` | 多关键帧选择状态管理与成组移动碰撞规避 |
| `server/collaboration/lease.ts` | acquire、renew、release、expire 与并发租约裁决 |

## 维护约束

- 所有写入必须经过 semantic authoring transaction 和严格 codec；不能在加载时排序、合并或钳制非法关键帧。
- 新资源 Motion 或 `stopAllMotions` 必须释放旧自定义 Motion 的 Parameter 控制权；preview、seek、bake 与 export 应保持同一求值语义。
- 协作租约覆盖整个 `characterPerformance` statement 或 dialogue companion，不只覆盖 `params.motion`；首版不做逐 Parameter、逐轨道或逐关键帧合并。
- `derivedFrom` 只记录重新转换来源，不是运行时资源依赖。重新转换必须原子替换全部派生内容。

相关回归测试集中在 `CustomMotionConversion*`、`CustomMotionKeyframe*`、`CustomMotionRuntime`、`Cubism2MotionSampler`、`CollaborationLease*` 与 `TrackAreaCustomMotionEditor` 测试文件。修改后至少运行 TypeScript、相关 Vitest 测试和生产构建；浏览器检查只按仓库规则通过 e2e 执行。
