---
status: archived-historical-snapshot
last_reviewed: 2026-07-20
---

# Remaining Bridges and Known Gaps

ADR-0001 和 ADR-0002 已基本落地。本文档记录迁移完成后的遗留桥接和已知缺口。

最后更新：2026-07-09

## Current Scope Note

本 ADR 是 Adapter / Store 迁移后的历史快照，不再是当前活跃桥接清单。它仍然保留一个重要决策：`ScriptEngineOrchestrator` / TimelineRunner / SnapshotManager / StateReconstructor 拆分方案已经废弃，统一 `ScriptEngine` 继续作为播放与 seek 核心。

本文的具体 bridge 列表、测试数量和 UI 残留清单均已过时。当前代码已经切到 semantic source/read model，并且仍存在少量运行时诊断读取，例如 `src/App.tsx` 的 workspace snapshot 读取和 `src/ui/timeline/ActionInspectorTabs.tsx` 的诊断面板读取。因此，本文不能再被解读为 “所有活跃 UI 都已清空 engine singleton import”，也不能作为剩余 bridge 待办表。

当前 authoring、协作事务、资源准备和 source/runtime 边界的最新决策见 KSM-0003、ADR-0018、ADR-0019 和 ADR-0021。

## Completed (final state)

- **6 个 Adapter** 全部接线并运行：Document / Playback / Camera / Character / Stage / Timeline
- **4 个 Store** 全部创建：DocumentStore / PlaybackStore / EditorStore / SettingsStore（已有）
- **ScriptEngine 架构统一**：由于 Orchestrator 代理模式在 seek 快照恢复与渲染同步上面临严重的闪烁和状态冲突问题，**Orchestrator 方案已被彻底废弃**。原 `ScriptEngine` 被重构并保留为项目中唯一且统一的播放、GSAP Sequencer 与快照管理核心。
- **PlaybackAdapter 深度直连**：`PlaybackAdapter` 直接桥接至统一的 `ScriptEngine`，提供了完备的 `play`/`pause`/`seek`/`getDuration`/`setSilentMode`/`getBasePath`/`getMasterTimeline`/`setBasePath` 接口。
- **AutoSaveDaemon** 监听 DocumentStore，debounce 100ms
- **DocumentAdapter 完全接线**：updateAction/deleteAction/addAction/undo/redo 全部走 DocumentAdapter
- **EditorStore._listeners + _notify()**：copy buffer 和 selection 变更可被订阅
- **377 个测试**全部通过（原 391，删除 StateReconstructor 测试 20 个，新增 6 个）
- **App.tsx 深度重构完成**：移除了全部对 `scriptEngine` 实体类的播放状态查询、播放指令调用以及 BasePath 配置的直接操作，全部迁移至 `PlaybackAdapter` 和 `PlaybackStore`（仅保留极少的模块异步动态 import 及 fallback 降级调用）。

## 遗留的历史与架构回退说明（Orchestrator 方案的废弃）

我们曾尝试引入独立的 `ScriptEngineOrchestrator` 以及 TimelineRunner/SnapshotManager/StateReconstructor 拆分方案，但均遭遇失败：

1. **第一次尝试**：新 orchestrator 缺少 renderCallback 机制，导致 seek 时画面无法更新。
2. **第一次/第二次尝试**：虽然补充了快照采集与模拟前向，但导致了严重的角色渲染闪烁问题（每帧重置的代理值与 Live2D `updateAll` 发生冲突），且在 `pauseAllTweens` 后会出现模型消失的问题。
3. **根本局限**：新 orchestrator 作为独立的 GSAP 容器与旧引擎相比，缺少极其复杂的快照恢复机制和底层 WebGL 状态重置防护。

**最终决策**：**废弃 orchestrator 重构计划**。`ScriptEngine` 继续作为统一播放引擎运行，而 UI 层通过 `PlaybackAdapter` 隔离引擎单例。

## Remaining Bridges (minimal surface)

| 文件 | 残留 | 原因 |
|------|------|------|
| `storeHooks.ts` | 多个方法 | 设计桥接层（新 hooks 的过渡实现） |
| `StageOverlay.tsx` | `pushUndo`, `setData` | 深度耦合 ref 模式 of 拖拽回调——不能走 DocumentStore（160fps 触发 loadScene） |
| `TimelineEditor.tsx` | `loadFile`, `loadExample`, `setCurrentTime` | forceSave/getCurrentTime/getSelectedIndices 已迁移；loadFile 等深层耦合旧引擎 |

### 关于直接导入 `scriptEngine` 单例的清理状态

历史迁移曾基本消除了大部分 UI 对 `scriptEngine` 单例的直接 `import` 依赖，但该说法现在已经过时。当前仍需单独清理的活跃 UI 读取包括：

- `src/ui/timeline/ActionInspectorTabs.tsx`: 直接导入 `scriptEngine` 与 `cameraController`，用于读取 camera state 与 transformation proxy 诊断信息。

已完成的清理包括：

- **[PlayerView.tsx](file:///d:/AeonStagery/src/ui/PlayerView.tsx)**: **已重构**，完全改走 React `useDocumentAdapter` 钩子，不含任何 `scriptEngine` 依赖。
- **[ExportDialog.tsx](file:///d:/AeonStagery/src/ui/ExportDialog.tsx)**: **已重构**，全面使用 `PlaybackAdapter` 进行音视频渲染同步及 Canvas 离屏帧捕获。
- **[App.tsx](file:///d:/AeonStagery/src/App.tsx)**: **仅作为整个应用的最外层引导节点**，保留了对 `ScriptEngine` 的类型导入（`import type`）和初始化时的延迟异步动态加载 `import()`，以便将其传递给 `bootstrap()` 初始化。除此外，其核心的播放控制、基准路径、全局 `window.AeonStagery.scene` 注入已完全通过 `PlaybackAdapter` 隔离。

## Known Gaps

### 1. seek 时 playMotion 重启 bug
**状态**：`seek(time, true)` 的基础修复已应用，但 Live2D Cubism 2.1 运行时仍存在两个无法通过当前公开调用面稳定消除的可见问题。

当前仍未修复的问题：

- **拖拽 seek 到动作开头后约 0.1s 仍可能进入 Tpose**：热拖拽到动作语句开头附近时，角色会短暂或持续暴露默认 Tpose，然后再进入目标动作。
- **暂停 seek 仍会出现可见步进过渡**：定点或暂停状态下 seek 到动作语句开头附近时，画面仍可能从上一动作逐帧步进到下一动作开头，暂停感表现为未完全冻结。

已尝试的缓解包括：冻结 seek 期间的可见 motion、跳过 seek 前向模拟、零时间 flush 不推进 `model.update()`、保留 Cubism2 motion handoff snapshot、过滤被污染的默认姿态快照、以及 seek 重启时保留当前姿态。上述改动降低了部分路径的回退和队列冲突，但没有完全消除 Cubism 2.1 在拖拽/暂停 seek 边界处的可见 Tpose 与步进过渡。

初步判断：问题更接近 Cubism2 / `pixi-live2d-display` motion manager、全局 `UtSystem` 时间推进、GSAP seek 回调顺序和私有 SDK motion 状态之间的边界问题。当前代码只能通过公开接口和局部状态回放进行补偿，尚不能稳定控制 Cubism2 内部在 motion 开头帧的默认姿态回落。

### 2. 旧引擎全量重载
编辑后 `scriptEngine.loadScene(clone)` 仅在非播放时触发（播放守卫）。播放中的编辑在暂停后同步。
**注意**：`loadScene` 调用 `initMasterTimeline()` 两次（一次直接，一次 via `seek`），每次重建 GSAP timeline。拖拽操作不能触发此路径（160fps → GSAP 泄漏）。

### 3. PreBake 调度
快照采集需打通 Live2DManager.captureSnapshot → SnapshotManager。BakeEngine 对快照烘焙具有 400ms debounce。

### 4. `window._timelineEditorCtx`
`TimelineDragProvider` 已就位，替换需配合拖拽逻辑重构。

### 5. DocumentStore 拖拽写入风险
`StageOverlay` 的 `setSceneData` 使用 `timelineState.setData()`（不触发 DocumentStore 通知）。如果改为 `documentStore._setScene()`，显示同步桥会以 160fps 触发 `scriptEngine.loadScene()` → `initMasterTimeline()` x2 → GSAP 对象泄漏。**CLAUDE.md 已记录此约束。**

## Architecture Diagram

```
AppProvider context ← bootstrap()
  ├── DocumentStore ← DocumentAdapter → EngineFacade → ScriptEngine
  │     ↑                                             │
  │   _notify()                                    Unified GSAP Timeline
  │     ↓                                          Snapshot History
  │   AutoSaveDaemon → forceSave → disk            BakeEngine
  │     ↓
  │   Display Sync → scriptEngine.loadScene(clone)  [仅非播放时]
  │
  ├── PlaybackStore ← PlaybackAdapter ───────────────→ ScriptEngine
  ├── EditorStore ← TimelineAdapter
  ├── CameraAdapter → cameraController (old singleton)
  ├── CharacterAdapter → live2DManager (old singleton)
  └── StageAdapter → stageManager (old singleton)
```

## Future PRs

1. **删除显示同步桥**：当数据同步完全合并至 Store/Adapter 后，移除过时的加载监听。
2. **删除 `export const timelineState`**：所有消费者迁走后移除。
3. **ExportDialog 迁移**：**已完成**，现已全面使用 `PlaybackAdapter`。
4. **App.tsx 播放核心迁移**：**已完成**，`handlePlayPause`、快捷键、以及全局 `window.AeonStagery.scene` 已全面使用 `PlaybackAdapter` 和 `PlaybackStore`。
