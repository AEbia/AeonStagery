---
status: partially-superseded
superseded_by:
  - ADR-0018
  - KSM-0003
last_reviewed: 2026-07-20
---

# Adapter + Store Architecture (UI-Engine Seam)

UI 层不再直接导入引擎单例（`scriptEngine`, `live2DManager`, `cameraController` 等）。改为通过领域 Adapter 访问引擎，通过只读 Store 读取状态。副作用（Auto-Save、Pre-Bake）以 Daemon 形态监听 Store 变化触发。

## Current Scope Note

本 ADR 是 Adapter / Store 迁移的历史起点，不再作为所有 UI 写入 seam 的最新约束。

- 仍然有效：UI 不直接触碰引擎单例；Store 是读模型；写入必须经过受控 seam；副作用通过明确 Module 集中处理。
- 已被后续决策替换：`ScriptEngine` 拆成独立 Orchestrator 的方案已由 ADR-0003 废弃。
- 已被后续决策深化：结构性 timeline authoring 已由 ADR-0005 收敛到 `TimelineAuthoringService.author(intent)`，普通 timeline action edit 的 UI seam 由 ADR-0018 接管。
- 因此，本文中 “DocumentAdapter 是 UI 唯一写入入口” 只应按迁移期语境理解；当前架构中 `DocumentAdapter` 更偏内部执行 Adapter，不能阻止更深的 authoring Module 成为 UI seam。

**Why**: 当前 11 个 UI 文件直接导入 5+ 引擎单例，修改任一引擎接口波及 6+ UI 文件。引擎内部（ScriptEngine）是 756 行的 god class，与 UI 层的 `settingsManager` 存在反向依赖。需要一条清晰的缝线让两侧独立演进。

## Decisions

1. **6 个领域 Adapter** — Document / Playback / Camera / Character / Stage / Timeline — 封装引擎单例，暴露面向 UI 意图的语义化方法。Adapter 不互引用，通过 Store 解耦。

2. **4 个只读 Store** — DocumentStore（场景数据）、PlaybackStore（播放状态，仅低频字段；高频 currentTime 走细粒度订阅 `subscribeTime`）、EditorStore（选中/剪贴板/undo 状态）、SettingsStore（已有，保持不变）。

3. **依赖方向**: Store → Engine → Adapter → Daemon → UI。单向，构造器注入，无全局 `export const` 单例。

4. **Daemon 模式**: AutoSaveDaemon 只监听 DocumentStore 的版本变化并触发延迟写盘；`dirty` 由写入口标记，`saving / idle / error` 由保存服务管理。PreBakeDaemon 监听 PlaybackStore 空闲 + DocumentStore 稳定，以可抢占+时间分片方式后台预计算 Live2D 模型参数快照——快照是 seek 的实现机制（通过快照恢复 + 前向模拟到目标时间），不是性能优化。

5. **Undo/Redo 基于 Patch 而非全量快照**: 每次 mutation 生成 inverse patch 入栈，Ctrl+Z 等价于 `applyActionPatches(inversePatches)`。

6. **ScriptEngine 拆分为 4 个模块**: TimelineRunner（GSAP 时间线 + ActionId→Tween 映射）、SnapshotManager（Live2D 参数快照采集/截断/查询）、StateReconstructor（seek 时的全状态对齐）、AudioCoordinator（音频元素生命周期）。原 ScriptEngine 保留为薄 Orchestrator，组合上述 4 个模块并暴露 `applyActionPatches` / `loadScene` / `play` / `pause` / `seek`。

## Key Interfaces

这些类型是架构契约——Adapter、Store、Engine 模块的边界由它们定义。

### Patch（增量变更单元）

```typescript
// 对一个 action 的单次修改。所有字段可选——只传变更的。
interface ActionPatch {
  _id: string;                        // 必须匹配现有 action._id
  action?: ActionType;                // 类型变更（如 playMotion → cameraMove）
  time?: number;                      // 时间变更
  params?: Record<string, any>;       // 合并到现有 params（非替换；传 null 删除 key）
  paramsDelete?: string[];            // 显式删除的 param key
}

// applyActionPatches 的返回——包含失效窗口信息
interface PatchResult {
  applied: string[];                  // 成功应用的 _id
  rejected: { _id: string; reason: string }[];
  tMin: number | null;                // 受影响的最早时间点，用于 snapshot 截断
}
```

### Store（只读给外部，写入给 Adapter）

```typescript
// DocumentStore — 场景数据，变化频率极低（用户编辑时）
interface IDocumentStore {
  readonly sceneData: SceneScript | null;
  readonly filePath: string | null;
  readonly version: number;           // 每次 mutation 递增，Daemon 和 React 用它感知变化
  // 内部方法（仅 DocumentAdapter 调用）:
  //   _applyPatch(p: ActionPatch): void
  //   _applyPatches(ps: ActionPatch[]): void
  //   _setScene(data: SceneScript, path?: string): void
}

// PlaybackStore — 仅低频字段；high-frequency currentTime 走 subscribeTime
interface IPlaybackStore {
  readonly playing: boolean;
  readonly duration: number;
  readonly engineStatus: string;
  // 内部方法（仅 PlaybackAdapter 调用）:
  //   _setPlaying(v: boolean): void
  //   _setDuration(d: number): void
  //   _setEngineStatus(s: string): void
}

// EditorStore — 纯 UI 瞬态状态
interface IEditorStore {
  readonly selectedActionIndices: number[];
  readonly copyBuffer: SceneAction[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  // 内部方法:
  //   _setSelectedIndices(indices: number[]): void
  //   _setCopyBuffer(actions: SceneAction[]): void
  //   _setUndoState(canUndo: boolean, canRedo: boolean): void
}
```

### Adapter（UI 唯一的写入入口）

```typescript
interface IDocumentAdapter {
  loadScene(pathOrData: string | SceneScript): Promise<void>;
  updateAction(index: number, changes: Partial<SceneAction>): void;
  addAction(track: string, action: SceneAction): void;
  deleteAction(index: number): void;
  pasteActions(actions: SceneAction[], time: number): void;
  undo(): void;
  redo(): void;
  pushUndo(): void;                   // 在一组 mutation 开始前调用
  forceSave(): Promise<void>;
}

interface IPlaybackAdapter {
  play(): void;
  pause(): void;
  seek(time: number): Promise<void>;
  setLoop(start: number, end: number): void;
  setLoopEnabled(v: boolean): void;
  setSpeed(s: number): void;
  /** 细粒度高频订阅——回调在 rAF 内执行，不触发 React 渲染 */
  subscribeTime(callback: (time: number) => void): () => void;
}
```

### Engine（分解为 4 个模块）

```typescript
// TimelineRunner — GSAP 主时间线 + ActionId→Tween 映射
interface ITimelineRunner {
  init(script: SceneScript, proxies: Map<string, TransformationProxy>, bgProxy: TransformationProxy): void;
  applyPatches(patches: ActionPatch[]): PatchResult;  // kill old tween → schedule new
  play(): void;
  pause(): void;
  seek(time: number): void;           // 纯 GSAP seek，不做重建
  getCurrentTime(): number;
  getDuration(): number;
  setSpeed(s: number): void;
  setLoop(start: number, end: number): void;
  setLoopEnabled(v: boolean): void;
  destroy(): void;
}

// SnapshotManager — Live2D 模型参数快照的采集/截断/查询
interface ISnapshotManager {
  takeSnapshot(time: number): void;
  truncate(fromTime: number): void;   // 丢弃 t >= fromTime 的所有快照
  findBest(time: number): { time: number; models: Map<string, ModelSnapshot> } | null;
  readonly count: number;
  clear(): void;
}

// StateReconstructor — seek 时的状态对齐（角色/motion/表情/相机/音频）
interface IStateReconstructor {
  syncAllStates(time: number, skipHardReset: boolean): Promise<void>;
  /** 计算指定时间点的期望状态（纯函数委托给 SceneCompiler） */
  computeStateAtTime(time: number): SceneStateAtTime;
}

// AudioCoordinator — 音频元素生命周期
interface IAudioCoordinator {
  setupBGM(bgm: SceneBGMAction, timeline: gsap.core.Timeline): void;
  syncAudio(time: number, playing: boolean): void;
  cleanup(): void;
}
```

### Daemon（响应式副作用）

```typescript
// Daemon 是挂载在 Store 上的 reaction，不是被调用的方法
interface IAutoSaveDaemon {
  /** 启动监听；返回 dispose 函数 */
  attach(documentStore: IDocumentStore, documentAdapter: IDocumentAdapter): () => void;
}

interface IPreBakeDaemon {
  /** 启动监听；返回 dispose 函数 */
  attach(
    playbackStore: IPlaybackStore,
    documentStore: IDocumentStore,
    snapshotManager: ISnapshotManager,
    bakeEngineFactory: () => BakeEngine,
  ): () => void;
}
```

### Bootstrapper（初始化顺序）

```typescript
// 严格顺序：Store → Engine → Adapter → Daemon → React mount
async function bootstrap(canvasElement: HTMLElement): Promise<BootstrapContext> {
  // 1. Store（纯数据，无依赖）
  // 2. Engine 模块（依赖 Store 类型，不依赖实例）
  // 3. ScriptEngine orchestrator（组合 4 个 Engine 模块）
  // 4. Adapter（接收 Engine + Store 引用）
  // 5. Daemon.attach()（监听 Store，调用 Adapter/Engine）
  // 6. 返回 { adapters, stores } 给 React
}

interface BootstrapContext {
  adapters: { document: IDocumentAdapter; playback: IPlaybackAdapter; /* ... */ };
  stores: { document: IDocumentStore; playback: IPlaybackStore; editor: IEditorStore };
  dispose: () => void;  // 完整 teardown
}
```

## Contracts & Invariants

以下约束是硬性契约——违反就会产生数据损坏、视觉跳动、或不可逆的 undo 栈污染。

### 1. ActionPatch.params 深合并（禁止浅拷贝覆盖）

`params` 与现有 `action.params` 合并时**必须深合并**，不能 `Object.assign` 或 spread。

```typescript
// 错误：浅合并会丢失嵌套结构
const merged = { ...oldParams, ...patchParams };
// oldParams.focus = { character: 'char-d', part: 'head' }
// patchParams.focus = { part: 'chest' }
// → merged.focus = { part: 'chest' }  —— character 丢了！

// 正确：深合并到任意深度
// patchParams.focus = { part: 'chest' }
// → merged.focus = { character: 'char-d', part: 'chest' }
```

契约：
- 合并深度无上限（CameraMotionConfig 嵌套可达 3 层）
- `paramsDelete` 列表中的 key 从合并结果中移除（在合并后执行删除，保证原子性）
- 合并过程不修改原 `patch.params` 对象或原 `action.params`（不可变语义）
- `params: null` 表示“清空所有参数”（等同于全部 key 入 `paramsDelete`）

### 2. Undo Stack 私有化确权

Undo/Redo 栈是 **DocumentAdapter 的私有实现细节**，不暴露给任何外部模块。

```typescript
class DocumentAdapter implements IDocumentAdapter {
  // 私有——外部不可见、不可触、不可读
  private undoStack: ActionPatch[][] = [];
  private redoStack: ActionPatch[][] = [];

  // EditorStore 只暴露布尔标志
  private syncUndoFlags(): void {
    this.editorStore._setUndoState(
      this.undoStack.length > 0,
      this.redoStack.length > 0,
    );
  }

  // public undo() 等价于 applyPatches(inverse)——
  // 走和正常 mutation 完全相同的代码路径
}
```

契约：
- EditorStore 只有 `canUndo: boolean` 和 `canRedo: boolean`——没有 stack 访问权
- 只有 DocumentAdapter 可以 push/pop 栈
- `undo()` 内部调用 `this.engine.timelineRunner.applyPatches(inversePatches)`，与正向 mutation 走相同路径
- 任何新的 mutation（非 undo/redo）立即清空 `redoStack`

### 3. StateReconstructor 异步重入防护

`syncAllStates(time)` 是 async 的——它 await `stageManager.setBackground()` 和 `live2DManager.playMotion()` 的 motion 加载。在 await 间隙，另一个 `syncAllStates(time2)` 可能被调用。

```typescript
class StateReconstructor implements IStateReconstructor {
  private epoch = 0;  // 每次 syncAllStates 调用递增
  private active = false;  // 重入检测

  async syncAllStates(time: number, skipHardReset: boolean): Promise<void> {
    if (this.active) {
      // 调用者必须在外部保证不会并发调用。
      // 作为最后防线，抛出而非静默重叠。
      throw new Error('[StateReconstructor] Re-entrant syncAllStates detected');
    }
    this.active = true;
    const myEpoch = ++this.epoch;
    try {
      // ... await 可能在这里 ...
      // 每个 await 之后检查 epoch:
      if (this.epoch !== myEpoch) return; // 已被更新的调用取代
      await this.restoreBackground(time);
      if (this.epoch !== myEpoch) return;
      await this.restoreMotions(time, skipHardReset);
      // ...
    } finally {
      this.active = false;
    }
  }
}
```

契约：
- **外部门控**: ScriptEngine.seek() 设置 `isReconstructing = true`，阻止 onUpdate 和 Daemon 触发新的 syncAllStates
- **内部 epoch**: 每次调用递增 epoch；每个 `await` 后检查 epoch 是否仍是自己的——若被取代则静默返回
- **内部重入检测**: `active` 标志作为断言——检测到重入时抛出（说明外部门控失效）
- **调用方负责门控**，StateReconstructor 只负责 epoch 取消 + 重入检测

## Considered Alternatives

- **保持现状，只拆分 ScriptEngine**: 不改 UI 的导入链。但这样 ScriptEngine 拆分后接口变化仍需逐一更新 11 个 UI 文件，缝线不存在。
- **单一 EditorFacade 而非多 Adapter**: 一个粗粒度 facade 会演变成新的 god class。按领域拆分使每个 Adapter 的接口保持在 5-10 个方法。

## Consequences

- 新增 `src/ui/store/`、`src/api/adapters/`、`src/engine/daemons/` 三个目录
- `TimelineState.ts`（428 行）解体，逻辑分散到 Store / Adapter / Daemon
- 所有 UI 组件需改造为从 Adapter + Store 读写，而非直接操作 `timelineState` 和引擎单例
- 需要一个 Bootstrapper 控制初始化顺序
