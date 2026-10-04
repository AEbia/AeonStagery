---
status: accepted
narrowed_by:
  - ADR-0021
last_reviewed: 2026-07-20
---

# Keep Project-Relative Asset References in Collaborative Scenes

协作第一阶段不把 `SceneScript` 中的素材引用改成 `assetId` 或内容 hash。场景动作继续使用项目相对路径引用 Live2D 入口与背景图片；协作素材 manifest 负责把这些路径关联到素材身份、内容指纹、bundle 文件列表与共享可用性。

## Considered Options

1. **Keep project-relative references with a collaborative manifest**: 选用。它保留现有保存格式、运行时加载路径和 `SceneAssetService` / `ProjectResourceService` 语义。
2. **Replace scene refs with assetId**: 拒绝作为第一阶段方案。它会迫使运行时、保存格式、旧场景迁移和 UI 展示一起重构。
3. **Use content hash directly in scene refs**: 拒绝。hash 适合完整性和去重，不适合作为作者可理解的场景语言。

## Consequences

- Asset-backed commit 必须校验 scene 引用的项目相对路径已存在对应 manifest entry。
- 本地缓存需要能把项目相对路径解析到协作素材存储拉取下来的文件。
- 后续如需 assetId 化，应作为显式 schema migration，而不是协作接入的隐式副作用。
