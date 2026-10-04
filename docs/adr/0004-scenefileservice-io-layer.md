---
status: superseded
superseded_by: KSM-0003
---

# SceneFileService — 场景文件的 I/O 安检层

> 本 ADR 的 I/O seam 仍有效，但 source/compile/load 细节已由 KSM-0003 替代。以下文字保留为历史背景，不再描述当前产品契约。

## Current Contract

`SceneFileService` 读取和保存版本化 `SceneDocumentV3`，通过 strict codec 与 `SemanticDocumentCoordinator` 完成验证、编译、资源准备和投影。它依赖 `DocumentFilePathPort`，不再依赖 `DocumentAdapter`。root statement 与 companion ID 是 source 中必须持久化的稳定事实；compiler 不生成随机 ID，也不从 compiled action 反推 source。

当前 `storeHooks.ts`（325 行 React hooks 文件）内含 ~150 行文件 I/O、SceneCompiler.compile、SceneValidator 和 ID 补全逻辑。同一套 compile→validate→assign-IDs→loadScene 管线在 `storeHooks.ts`（`loadExample`、`loadFile`）和 `App.tsx`（`window.AeonStagery.scene.load`）中重复三次。此外，`Bootstrapper.ts` 的 `engineFacade.forceSave` 把序列化+写盘逻辑嵌入引导层，与 load 管线完全分离。

确定引入 `SceneFileService` —— 一个应用服务模块，统一负载 Load（脏数据进→洗净出）和 Save（干净数据出→序列化→写盘）两条方向相反的 I/O 管线。

## Decisions

1. **一步到位式装载（历史）**：原设计通过 `DocumentAdapter` 完成 compile→validate→loadScene；当前实现由 KSM-0003 的 strict codec 与 semantic coordinator 取代。

2. **依赖注入 FileAccess 接口**：按"资源获取策略"划分，不是按业务场景：
   - `readAsset(relativePath)` — 内部资产（`start.json`），平台负责解析资源根目录
   - `readFile(path)` — 文件系统任意路径
   - `showOpenDialog()` — 弹出系统对话框，用户选择
   - `writeFile(path, data)` — 写盘，`data` 为 string（`TextEncoder` 细节封装在实现内）

3. **三个 Load 入口**：`loadExample()`（读 start.json） / `loadFile()`（弹对话框） / `loadFromPath(path)`（给定路径）。内部共享同一 `FileAccess.readFile` / `FileAccess.readAsset` / `FileAccess.showOpenDialog`。

4. **ID 补全（已被替代）**：compiler 不得随机补 ID。缺失或重复 statement/companion ID 的 source 由 normal loader 拒绝；历史文件只能通过显式离线 migration 生成稳定 v2 source。

5. **验证 issues 由调用方处理**：SceneFileService 返回 `LoadResult`（含 `issues: ValidationIssue[]`），不直接发射 EventBus 事件。调用方根据 issues 决定何时 `eventBus.emit('scene:validation', …)`。

6. **斩断 App.tsx `scene.load` 的 scriptEngine 降级路径**：catch 后直接抛出错误，不走 `scriptEngine.loadScene(path)` 兜底。

7. **显式 `ReadonlyDocumentStore` 接口**：用 `interface`（非 `Pick`），`DocumentStore` 实现它。SceneFileService 的构造器只接收 `ReadonlyDocumentStore`，类型系统防止 Save 管线意外修改 Store。

8. **`WriteFile` 接受 string**：`TextEncoder → ArrayBuffer` 是 Electron IPC 实现细节，封装在 `ElectronFileAccess` 内。

9. **`SceneFileService` 位于 `src/services/io/`**：与 `engine/`、`api/`、`ui/` 同级。

## Key Interfaces

```typescript
// src/services/io/IFileAccess.ts
interface IFileAccess {
  readAsset(relativePath: string): Promise<{ data: string; path: string }>;
  readFile(path: string): Promise<{ data: string; path: string }>;
  showOpenDialog(): Promise<{ data: string; path: string }>;
  writeFile(path: string, data: string): Promise<void>;
}

// Load
type LoadResult =
  | { success: true; path: string; issues: ValidationIssue[] }
  | { success: false; path: string; error: string };

// Save
type SaveResult =
  | { success: true; path: string }
  | { success: false; path: string; error: string };

class SceneFileService {
  constructor(
    fileAccess: IFileAccess,
    documentStore: ReadonlyDocumentStore,
    coordinator: SemanticDocumentCoordinator,
    filePathPort: DocumentFilePathPort,
  ) {}

  async loadExample(): Promise<LoadResult>;
  async loadFile(): Promise<LoadResult>;
  async loadFromPath(path: string): Promise<LoadResult>;
  async save(): Promise<SaveResult>;     // 覆盖写；无 filePath 时走 saveAs
  async saveAs(): Promise<SaveResult>;   // 弹对话框选路径
}
```

## Considered Alternatives

- **保留 storeHooks 内的 I/O 逻辑**：拒绝 —— 同一管线在 3 个位置重复，且 React hooks 文件不应承担文件 I/O 和场景编译职责。
- **纯转换模式（SceneLoader 返回 SceneScript，调用方调 loadScene）**：拒绝 —— 调用方需要记得传 `immediate=true`，容易出错。
- **验证 issues 在 SceneFileService 内发 EventBus**：拒绝 —— 让模块同时依赖文件系统和事件总线是关注点混合；issues 是数据，调用方决定怎么处理。
- **用 `Pick<DocumentStore, …>` 定义 readonly 接口**：拒绝 —— 当 Store 新增 getter 时，Pick 不报错，调用方拿到 `undefined`。显式 interface 在编译期暴露遗漏。
- **App.tsx `scene.load` 保留 scriptEngine 降级**：拒绝 —— 绕过整个编译→验证→adapter 路径，隐藏错误。

## Consequences

- 新增 `src/services/io/` 目录，含 `IFileAccess.ts`、`SceneFileService.ts`、`ElectronFileAccess.ts`、`BrowserFileAccess.ts`
- `storeHooks.ts` 删除 `loadExample`/`loadFile` 实现（~120 行），`useEditorState` 不再返回这两个函数
- `App.tsx` 删除 `scene.load` 实现（~20 行），改为通过 `SceneFileService.loadFromPath`
- `Bootstrapper.ts` 删除 `engineFacade.forceSave`，替换为 `SceneFileService.save`
- compiler 只做 deterministic one-way lowering，不补随机 ID
- `DocumentStore` 保存 `SceneDocumentV3` / compiled / prepared snapshots
- 新增 `FileAccess` 的 `writeFile` 方法（当前接口不存在）
- `TimelineEditor.tsx` 和 `InspectorArea.tsx` 的 props 接口改为接收 `loadExample`/`loadFile`/`save` 回调
