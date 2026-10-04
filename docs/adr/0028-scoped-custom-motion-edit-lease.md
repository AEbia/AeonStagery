---
status: accepted
extends: ADR-0012
last_updated: 2026-09-04
implementation_status: decision-updated; implementation-pending
---

# Scoped Lease for Collaborative Custom Motion Editing

## 2026-09-04 编辑会话生命周期修订

租约生命周期采用 KISS 规则：展开关键帧编辑器即申请，关闭、折叠或切换目标即释放。
这会让只想在编辑器内查看曲线的协作者也暂时占用整个角色表演实体的编辑权，但避免了
首次写入手势与异步授权之间的竞态，也让编辑器可见状态、租约续期和释放时机保持一一
对应。需要无租约查看时仍可选中 Motion、移动播放头或使用不展开编辑器的预览。

普通场景编辑继续采用 ADR-0012 的乐观协作，但内联自定义 Motion 创作是范围化例外：
客户端在展开自定义 Motion 关键帧编辑器、进入编辑会话时即申请由服务端裁定、可续租
的独占编辑权，并在取得后持续持有到编辑器关闭、折叠或切换目标。租约覆盖承载该
Motion 的整个 `characterPerformance` 源实体。顶层实体以 `statement.id` 标识，对话
companion 以父 statement ID 与 companion ID 的组合标识；Presence 只展示持有者，
不能代替服务端授权。仅选择 Motion、移动播放头以及不展开编辑器的预览不申请租约。

申请尚未完成时可以显示仅存在于当前客户端的临时预览，但任何场景写入必须等待租约
成功取得；申请被拒绝、超时或目标失效时丢弃临时预览。申请被拒绝的编辑器保持只读，
不得以 Presence 或本地状态代替服务端授权。

该授权同样覆盖把普通 Motion 转换为内联自定义 Motion，以及从 `derivedFrom` 重新
生成自定义内容的确认提交；采样、密度切换和转换预览保持只读，不提前占用租约。
确认后若直接展开转换结果的关键帧编辑器，已取得的租约转交给该编辑会话并持续持有；
未进入编辑会话、转换失败或取消时立即释放。

选择实体级租约是因为当前协作按完整 statement / companion 发布，自定义 Motion 的
轨道与关键帧也没有可独立合并的稳定身份；只锁 `params.motion` 或仅显示软提示仍可能
让同实体的 Expression、LookAt 或 Blink 写入覆盖整份 Motion。其他源实体继续并行
编辑，首版不引入逐 Parameter、逐轨道或逐关键帧的合并协议，也不改变协作无共享
Undo/Redo 的规则。

## 最终架构决策（2026-09-04）

租约生命周期由应用级深模块 `CustomMotionEditing` 统一管理。`TrackArea`、
`ActionInspector`、右键菜单和关键帧编辑器不再自行解析 locator、订阅租约状态、
计算帧时间或调用租约 API；它们只消费模块快照并发送编辑意图。这样删除该模块时，
租约竞态、临时预览回滚、目标复核和原子提交会同时散落回多个调用方，模块本身具有
足够的 leverage 和 locality。

对外接口保持最小且稳定：

```ts
interface CustomMotionEditing {
  open(target: CustomMotionEditTarget): CustomMotionEditSession;
  getSnapshot(): CustomMotionEditSessionSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

interface CustomMotionEditSession {
  readonly ready: Promise<CustomMotionOpenOutcome>;
  preview(intent: CustomMotionEditIntent | null): CustomMotionPreviewOutcome;
  commit(): Promise<CustomMotionCommitOutcome>;
  close(reason: CustomMotionCloseReason): Promise<void>;
}
```

`open` 同步返回带代际身份的不透明会话句柄，并立即进入 `pending`；`ready` 只报告
申请结果。旧句柄的 `close`、`preview` 或 `commit` 不能影响后来打开的新会话。一个
应用作用域内最多存在一个活动会话、一个临时候选和一个租约；不引入 pending 编辑
队列。一次拖动或连续输入先反复 `preview`，松手后只调用一次 `commit`，形成一条
authoring transaction 和一条 Undo 记录；pending 时最多挂起当前这一条提交，授权
失败则整条候选丢弃。`close` / 切换会先禁止新的提交；若已有提交已进入
authoring transaction，则等待该事务完成后再 release，尚未进入事务的 pending 提交
直接标记为 dropped。

`open` 会先从当前文档解析并确认目标是有效的 `characterPerformance` 自定义 Motion；
解析失败只产生 `invalid-target` 结果，不发送租约请求。

会话快照至少区分 `pending`、`held`、`readonly` 和 `closed`。`pending` 可以显示仅
存在于本地的候选 Motion，但绝不写入 DocumentStore、Undo 或协作状态；`held` 才
允许提交；`denied`、超时、租约丢失、目标删除或 Motion 版本变化会清空候选并进入
只读或结束状态，不自动 rebase、不静默重试。场景切换、关闭场景、退出协作和卸载
都走幂等 `close` / `dispose`，释放恰好一次。目标仍存在但 Motion 版本变化时保留
最新规范 Motion 的只读快照并标记 `readonly`；实体删除或场景替换时直接进入
`closed`，不再渲染失效目标。

编辑意图使用会话内有效的不透明关键帧引用和整数场景帧；模块在内部把新建或主动
移动的帧换算为 `scene.meta.fps ?? 60` 的秒数。已有 Cubism 3/4/5 子帧点保留精确
秒值，主动移动时才重新吸附；fps 改变只取消当前候选并刷新显示，不改写已保存秒值。
现有 `CustomMotionKeyframeEdit`、F0/Bezier/时长校验和纯求值算法作为实现细节，
不再成为 UI 的公开契约。

租约使用真实的内部 seam：

```ts
interface CustomMotionEditAuthorityPort {
  acquire(target: CustomMotionEditTarget, signal: AbortSignal): Promise<LeaseDecision>;
  release(lease: HeldCustomMotionLease): Promise<void>;
  onLoss(lease: HeldCustomMotionLease, listener: (reason: string) => void): () => void;
}
```

生产 Adapter 封装现有 Collaboration Client 的 requestId、续租、超时、断连和服务端
撤销；确定性的内存 Adapter 用于单机和契约测试。单机模式也注入立即授权的 Adapter，
不在模块接口上保留可选租约分支。`SemanticAuthoringApplicationService`、
`DocumentStore` 和纯编辑算法属于 in-process dependency，直接留在模块实现内，
不再为它们增加无收益的 port。

切换目标的顺序固定为：使旧代际失效、丢弃旧候选、等待旧租约释放请求完成，再申请
新目标。旧请求的晚到授权必须立即释放；同一客户端任何时刻都不能同时持有两个实体
租约。这里的“释放请求完成”指 Adapter 已将 release 排入传输队列或发出，不等待
协议没有提供的服务端确认；提交前和 authoring transaction 内都重新核对 `sceneId`、locator、目标仍为
自定义 Motion 以及 Motion 结构版本；不满足即不写入。

普通 Motion 转换或重新生成仍是独立的确认式短事务。确认时临时取得同一 authority
port 的租约；成功且紧接着打开关键帧编辑器时把不透明 lease ownership handoff 给
会话，失败、取消或不打开编辑器则立即释放，绝不让 UI 看到 lease token，也不进行
第二次 acquire。

### 实施顺序

1. 新建会话模块、内存 authority Adapter 和接口契约测试；把现有纯编辑实现作为内部
   helper 接入。
2. 将 `CustomMotionEditLeaseGate` 改造成生产 authority Adapter，覆盖续租、晚到
   响应、失权和幂等 release；移除每批编辑的 acquire/finally-release。
3. 在 composition root 创建单一应用级会话，接入场景关闭、协作退出和 unmount 的
   `dispose`；提供 `useSyncExternalStore` 薄桥接。
4. 让 `TrackArea` 只负责布局，`ActionInspector`/菜单只调用 `open`，删除
   `EditorStore.customMotionEditorActionId` 和散落的 lease wiring。
5. 将 `CustomMotionEditor` 的本地 preview、`0.05s` 时间常量和 raw edit callback
   改为会话快照与 frame-based intent；接入 stage 的临时预览投影。
6. 接入转换后的 lease handoff；移除关键帧 command 的租约入口和 UI facade，保留
   转换命令作为独立的确认式转换模块；用会话接口测试替换逐调用方租约测试。

接口契约测试覆盖：pending 无写入、授权后单次 Undo、拒绝/超时/失权回滚、A→B
release-before-acquire、晚到授权、目标删除和 Motion 版本冲突、24/30/60/默认 fps、
子帧保真、fps 变化、关闭与提交竞态，以及转换不重复申请。React 只保留打开、快照
渲染和关闭三类薄集成测试。
