# 0033 Live2D 资源 Motion 曲线缓存与 Seek 求值统一

- 状态：current, accepted
- 日期：2026-08-26（本工作区实现）
- 关联：ADR-0019（runtime seam）、ADR-0029（自定义 Motion 关键帧）、ADR-0032（日志/诊断）
- 代码入口：`src/engine/live2d/motionCurveCache.ts`、`src/engine/SeekProfiler.ts`、`src/engine/coordinators/CharacterSynchronizer.ts`、`src/engine/Live2DManager.ts`、`src/engine/BakeEngine.ts`

## 问题

场景中的普通资源 Motion（`kind: 'resource'`）在 Seek 时依赖 SDK 快照-快进：

- Cubism 2.1 在 `Live2DMotionController._executePlayMotion` 里以 50ms 步进拨动 `UtSystem`，随后 `CharacterSynchronizer.simulateForward` 再以 16ms 步进逐帧 `updateAll`。
- 时间线越长、角色越多，Seek 的阻塞耗时越高；Bake/Export 还会逐帧重复这一成本。

项目已有「把资源 Motion 转换成语义完整的关键帧自定义 Motion」（ADR-0029），但那是**作者态显式转换并持久化到场景文档**，不适合无侵入地覆盖全部普通 Motion。

## 决策

新增一个**隐藏运行时曲线缓存服务**，把场景中引用的每个普通 Motion 在项目/场景加载时转换为**逐帧密度的内存关键帧**，仅供运行期求值，绝不写入 `SceneDocumentV4/V5`（纯派生数据）。

### 核心决策

1. **缓存是派生数据，不是文档数据**。
   - 场景仍保存 `kind: 'resource'` 的普通 Motion；缓存只存在于内存。
   - 同一采样构件（`cubism2MotionSampler` + `buildCustomMotionTracks`）与作者态转换共享，但缓存使用 `density: 'perFrame'` 且是 best-effort：失败只回退，不阻断场景加载。

2. **逐帧密度，保留 pre-clamp 绝对目标值，不烘焙淡入**。
   - 缓存的曲线是「关闭源 fade、采样纯 Motion 目标值」的逐帧线性关键帧；源的 `fade_in/fade_out` 只作为 `derivedFrom` 元数据。
   - Seek/Play/Bake 阶段的淡入由现有 `evaluateCustomMotionRuntime` 从 handoff 姿态做 Cubism 状态化重建（60Hz），与 ADR-0029 的自定义 Motion 语义一致。

3. **Seek 缓存优先，保留 SDK 回退**。
   - `Live2DManager.playMotion` 在命中缓存时转调 `playCustomMotion`（同一求值器）；未命中/采样失败/非 Cubism2/gate 关闭时保持原 SDK Motion Queue 路径。
   - `CharacterSynchronizer.syncTo` 对缓存覆盖的 legacy Cubism 2 角色跳过 snapshot motion 预填与 `simulateForward`，直接 Phase 3 由派生曲线求值。
   - official-cubism-web（Cubism 3+）的 native offset seek 已是 O(1)，本轮 Seek 切换不强制启用缓存命中；缓存服务和 Play/Bake 复用不受此限制。

4. **埋点验证前提**。
   - `SeekProfiler` 记录 `_doSeek` 的 model-load / snapshot-restore / forward-sim / motion-step / native-restore / state-sync 耗时并上报 `engine:seek:report`（dev 构建默认开启，生产默认关闭，`window.__AEON_SEEK_PROFILER = true|false` 可实时覆盖；报告以 DEBUG 级别输出，dev 控制台默认可见）。

5. **Parity 通过后统一求值器**。
   - Play 经 `playMotion` 拦截复用同一 `evaluateCustomMotionRuntime`；
   - Bake 经 `applyBakeMotionState` 把命中缓存的资源 Motion 视作合成 custom motion；
   - Export 经 `FrameCaptureEngine` 逐帧 `seek` 自动继承缓存收益；
   - 任何 parity 不达标的分支保留 SDK 回退，按 adapter/按 motionKey 细分 gate。

### 范围与边界

- 本轮 Seek 缓存优先的启用范围：`pixi-live2d-display-cubism2` runtime（快进成本主体）。
- 缓存采样对缺失目标参数使用 `skipMissingParameters: true`（与作者态转换的“失败必须原子”不同）；无参数曲线、非有限采样、复合模型曲线冲突 → 该 key miss → SDK 回退。
- 缓存为**内存预算驱逐**：条目权重 = 关键帧数 × 48B + 轨道数 × 128B（`estimateCachedMotionBytes`，按 V8 真实占用口径校准，预算≈真实 RSS 而非低估），总预算 **512MB**（`RESOURCE_MOTION_CACHE_BUDGET_BYTES`）；超预算驱逐最旧条目，单条超预算仍保留（下限 1 条）。`ScriptEngine.cleanup(true)` / 项目关闭清空。
- 并行 `ensure` 以 in-flight promise 去重，避免重复采样；加载期预暖为后台任务，不阻塞首帧。
- 控制台诊断：`window.__AEON_MOTION_CURVE_CACHE.stats()`（单例已由 main.tsx 挂载）返回条目数、总逐帧关键帧数、占用/预算字节与逐条明细。

## 后果

### 正面

- Cubism 2 长距离 Seek 不再需要逐 16ms/50ms 步进 SDK；逐帧缓存查找 + Motion-stage 注入是 O(关键帧数) 量级。
- Seek / Play / Bake / Export 收敛到同一个 `evaluateCustomMotionRuntime`，消除多套 Motion 求值语义（ADR-0029 的 Preview/Seek/Bake/Export 同语义要求被扩展到资源 Motion）。
- 场景文档与协作 schema 完全不变；缓存是运行时可重建的派生数据，无迁移成本。

### 负面 / 注意

- 内存：逐帧曲线占用按 V8 口径公式估算（10s×20 参数 @60fps ≈ 12000 关键帧 → 约 578KB/条；512MB 预算 ≈ 880 条同规格；33 轨稀疏源动作 3000 帧 → 派生后 19800 帧 ≈ 0.95MB/条 ≈ 540 条），预算按字节驱逐而非条数计数。
- 淡入窗口 parity 存在步长离散差（SDK 50ms/16ms vs 60Hz 重建）；以容差契约测试兜底，不匹配时继续走 SDK。
- 缓存采样是运行时 CPU/IO 成本；重复 load 场景会造成重复采样，由 key + in-flight + cleanup 控制。
- 状态化淡入依赖 handoff 快照；Seek 到 motion 起始帧且无前序快照时可能回退 SDK，确保不产生错误姿态。

## 实现清单（本 ADR 覆盖）

- `SeekProfiler`（埋点、事件、测试、`cacheMissKeys` 报告）。
- `motionCurveCache.ts` / `motionCurveCacheBuilder`（缓存服务与采样装配）。
- `cubism2MotionSampler` 增加 `zeroSourceFades` / `skipMissingParameters` 选项、`motionHasNonParameterCurves` 探针与 `Cubism2MotionMeta.hasNonParameterCurves`。
- `Live2DManager.playMotion` 缓存拦截 + gate + handoff 透传。
- `CharacterSynchronizer` 缓存覆盖预判、跳过 legacy prefill/forward、handoff 快照。
- `BakeEngine.applyBakeMotionState` 缓存资源 Motion 路由。
- `ScriptEngine.prewarmMotionCurves` 加载期后台预暖（**置于初始 seek 之后**，避开空角色表空转）。
- 测试：埋点、缓存、预暖、Seek parity、Bake parity、gate/回退。

### 后续加固（第二工作区）

1. **负面缓存**：采样/转换失败 key 登记 `rejected`（上限 96），`ensure` 命中直接 miss，不再每次重采；`invalidate`/`clear` 重置。miss 原因以 code 暴露给 seek 报告。
2. **parts/layout parity 防护**：源动作含 `VISIBLE:`/`LAYOUT:` 曲线时 `hasNonParameterCurves: true` → 归类永久 miss（`parts-layout-curves`）→ 走 SDK，杜绝纯求值静默丢失部件动画。
3. **Seek 内 ensure**：`CharacterSynchronizer.syncTo` 对未缓存且未被拒绝的可转换动作并行 `ensure` 一次，随后 Phase 3 走统一纯求值器；永久 miss 立即回退 SDK 且不重复采样。
4. **前向模拟移除**：`simulateForward`、快照 motion 预填、`updateAll(16)` 冲刷与 `freezeVisibleMotionDuringSeek` 参数删除（生产两处调用点本已冻结）。
5. **seek 报告**：`SeekPhaseReport.cacheMissKeys` 列出本次仍走 SDK 的动作与原因，解释非零 `motionStep`。

## 运行期验证（dev 控制台）

- 每次 seek/scrub 输出一行 `[SeekProfiler] seek report ... forward=... motionStep=...`：缓存全覆盖时 `forward`/`motionStep` 接近 0（不再走 SDK 步进）。
- 加载场景后输出 `[ScriptEngine] Resource motion curve cache pre-warm complete: N entries cached`；`[Live2DManager] ... hit -> custom evaluator` 表示命中缓存求值，`miss -> SDK motion queue` 表示回退。
- 控制台可查 `window.__AEON_MOTION_CURVE_CACHE`（size/keys）并用 `window.__AEON_SEEK_PROFILER = false|true` 开关报告。