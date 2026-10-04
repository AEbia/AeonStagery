---
status: partially-superseded
superseded_by:
  - ADR-0018
last_reviewed: 2026-07-20
---

# Live2D Bundles and Single-File Backgrounds for Collaborative Assets

第一阶段协作素材范围只覆盖 Live2D 角色素材与背景素材。背景按单文件图片进入共享素材存储；Live2D 角色素材按 bundle 进入共享素材存储，bundle 通常以 `.model.json` 为模型入口，并包含运行所需的模型、贴图、动作、表情、物理等关联文件。`.wmdl` 只作为可能存在的项目包装入口，不能被当作唯一 Live2D 入口。

## Current Scope Note

本文的 Live2D bundle 决策仍然有效：Live2D 不能按单文件处理，依赖发现、file fingerprint 与 bundle hash 必须是共享的纯规则。

本文的“第一阶段只覆盖 Live2D + 背景”已经由 ADR-0018 接管并扩展：当前协作素材范围正式接受 Live2D bundle、背景图片、音频文件、普通图片文件与动画文件。本文的第三个 rejected option 应按“不要一次性无策略扩张”理解，而不是禁止逐类受控扩展。

## Considered Options

1. **Live2D bundle plus single-file background**: 选用。它匹配作者实际感知的“一个角色模型”和“一个背景图”，并保证远端可以完整加载。
2. **Treat Live2D as one referenced file**: 拒绝。`.model.json` 或项目包装入口通常还依赖内部相对资源，只同步入口会导致远端模型缺失。
3. **Sync every resource kind immediately**: 拒绝。音频、模板、通用图片和导出产物会扩大第一阶段范围，推迟核心协作闭环。

## Consequences

- Live2D 导入需要解析并校验 bundle 文件列表，不能只记录 `.model.json` 或包装入口路径。
- Asset-backed scene commit 必须等待整个 Live2D bundle 可用。
- 背景素材可以先走更简单的单文件上传、hash 和缓存路径。
- 删除 scene 引用时不立即物理删除共享素材；素材清理留给显式 cleanup / compaction 流程。
