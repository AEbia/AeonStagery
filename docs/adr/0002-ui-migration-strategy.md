---
status: archived-historical-plan
last_reviewed: 2026-07-20
---

# UI Migration Strategy for Adapter+Store Architecture

> Archived: this is the Adapter / Store migration execution plan. It is retained for context only and must not be used as the current implementation checklist.

从旧单例架构渐进迁移到 ADR-0001 的 Adapter+Store 架构。11 个 UI 文件逐一切换，每步保持应用可构建可运行。

## Decisions

1. **渐进迁移**（非大爆炸）。新旧代码在迁移期间共存，旧单例在全部 UI 切走后删除。

2. **React Context 注入**。单个 `<AppProvider value={{ adapters, stores }}>` 包裹根组件。细粒度 hooks（`useDocumentAdapter()` 等）是 `useApp()` 的便捷选择器。

3. **迁移顺序**（按依赖深度和风险，每步指定具体文件）：

   | 步骤 | 文件 | 说明 | 前置 |
   |------|------|------|------|
   | 1 | `StageOverlay.tsx` | 1 个引擎依赖（stageManager），叶子组件 | — |
   | 2 | `ActionInspector.tsx` | 仅 live2DManager，走 CharacterAdapter | — |
   | 3 | `ExportDialog.tsx` | 4 个引擎单例 + timelineState，走 StageAdapter + CameraAdapter | — |
   | **验证点** | — | 真实 GSAP+Live2D 跑 `subscribeTime` 60fps，验证回调稳定性 | 通过后进步骤 4 |
   | 4 | `PlaybackControls.tsx`, `PlayerView.tsx` | 高频 currentTime 通道，走 PlaybackAdapter.subscribeTime | 验证点通过 |
   | 5a | `TrackComponents.tsx`（展示层）, `TimelineListView.tsx` | 选中/高亮走 EditorStore，数据走 DocumentStore（只读） | — |
   | 5b | `TrackComponents.tsx`（拖拽层）, `TrackArea.tsx` | 拖拽/批量拖拽/复制粘贴走 DocumentAdapter；**引入 `TimelineDragContext` 替换 `window._timelineEditorCtx`** | 5a 完成 |
   | 6 | `InspectorArea.tsx`, `StatusBar.tsx`, `TimelineEditor.tsx` | 清除最后一批 TimelineState 直接引用；确认 `export const timelineState` 无外部引用后删除 | 5b 完成 |
   | 7 | `App.tsx` → `bootstrap()` | 删除手工 init + wireGlobalAPI，替换为 `<AppProvider>` | 6 完成 |

   步骤 6 的范围是 **纯 Adapter 接入**——将剩余 UI 文件的 `timelineState` 引用替换为对应 Adapter/Store。TimelineState 的逻辑拆解（UI 状态→EditorStore、场景数据→DocumentStore、auto-save→AutoSaveDaemon）已在步骤 2-5 中逐步完成。步骤 6 到达时，TimelineState 应只剩少量消费者，拆解自然结束。

4. **验证门禁**：

   | 门禁 | 触发时机 |
   |------|---------|
   | `tsc --noEmit` + `vitest run` | 每步必跑 |
   | `vite build` | 步骤 4 前、5 完成后、7 前 |
   | Electron 手动运行 | 步骤 4、5 完成后、7 后 |

5. **旧单例删除策略**：软迁移（C）为主干，延迟删除（A）为扫尾。
   - Adapter 创建时就把旧单例作为内部依赖封装，UI 层不再直接 import
   - 步骤 5b 后：逐一把 `export const` 改为 `const`，`tsc --noEmit` 找出所有外部引用并修复
   - 步骤 7 后：可选内联合并旧代码，但非必须

## Considered Alternatives

- **大爆炸迁移**：一次性切所有文件。风险高——App.tsx 初始化涉及 PixiJS + Live2D SDK 懒加载，一处断裂即白屏，排查范围是整个启动链。
- **Props drilling**：逐级传 adapters/stores。11 个文件分布在不同深度，改所有父组件成本高于一次 Context 包裹。

## Consequences

- 新增 `src/ui/context/AppContext.tsx` + hooks
- `App.tsx` 最终替换为 `bootstrap()` + `<AppProvider>`
- 旧单例（`scriptEngine`, `timelineState` 等）逐步降级为模块内变量
- 迁移期间 Context 和旧单例共存，新组件读 Context，旧组件不感知
