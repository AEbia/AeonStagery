# TODO / 待办

## Template System Deferred Work

Semantic preset preview is complete for `statementPreset`, `dialoguePreset`, and `timelineFragment`. Dialogue preset previews include companions, and confirmation submits the same materialized drafts shown in the preview.

These items are intentionally outside the first template-system version:

- Scene/project blueprints.
- Environment preset application UI.
- Text layer style application UI.
- Audio preset application UI.
- Export preset application UI.
- Automatic dialogue camera statement generation beyond explicit template companions.
- Full conflict visualization for overlapping template records and assets.
- Template package editor.
- Community registry installation/update flow.
- Automatic timeline action generation when importing characters.

Notes:

- `image-dialogue-v1` materializes textbox/namebox images and fonts automatically when that style becomes the project default. Enabled template resource entrypoints are also available in the shared file browser and are materialized when selected or dropped; model dependencies remain hidden from that list.
- Template presets author semantic statements; compiled camera/lighting actions are runtime implementation details.
- Automatic dialogue camera behavior beyond explicit, previewed companions should be designed separately because silent statement insertion can surprise users.

## 模板系统延期内容

`statementPreset`、`dialoguePreset` 和 `timelineFragment` 的语义 preset 预览已经完成。对白 preset 会展开显示 companions，确认时提交的就是预览所用的同一份物化 drafts。

以下内容有意不放入模板系统第一版：

- 场景/项目蓝图。
- 环境 preset 应用 UI。
- 文字图层样式应用 UI。
- 音频 preset 应用 UI。
- 导出 preset 应用 UI。
- 显式模板 companion 之外的自动对白镜头语句生成。
- 模板记录和资产重名时的完整冲突可视化。
- 模板包编辑器。
- 社区 registry 安装/更新流程。
- 导入角色时自动生成时间轴动作。

说明：

- `image-dialogue-v1` 成为项目默认样式时，对话框图、人名框图和字体会自动物化。当前项目启用模板的资源入口也已接入共享文件浏览器，在选取或拖入时物化；模型依赖不独立列出。
- 模板 preset 生成 semantic statements；compiled camera/lighting actions 只属于 runtime 实现。
- 显式、可预览 companion 之外的自动对白镜头行为仍需单独设计，因为静默插入语句容易让用户意外。
## KSM-0004 Contextual Short Resource Names

First-version completed scope:

- [x] Define `ResourceKind`, structured `ResourceKey`, `[namespace@][owner:]name` parser, explicit-path detection, and structured diagnostics.
- [x] Build deterministic project/template indexes for the first project-root slice, manifest v2 `assets.index`, aliases, and validated package-local `resourceConventions`.
- [x] Enforce package-root/path traversal safety and deterministic precedence/ambiguity handling.
- [x] Resolve enabled namespaces, owner context, explicit outfit scope, and active outfit projected from canonical `characterPresence` facts at statement time.
- [x] Materialize template resources and projectize explicit project/registered-library paths before storing scene schema v4 references.
- [x] Record provenance/materialization receipts and atomically apply resource selection with semantic statement or character mutations.
- [x] Declare typed source/compiled asset slots in `SceneStatementDefinitionRegistry` and consume them in `RuntimeAssetPreparer`.
- [x] Connect the first picker slice for character models/variants, backgrounds/images, BGM/SFX, voice, and custom animation; file mode remains the fallback where project convention indexing is not yet available.
- [x] Apply contextual display rules: local owner uses `name`, cross-owner uses `owner:name`, namespace appears only for real conflicts.
- [x] Provide current/other-owner grouping, namespace filtering, metadata search, refresh, and cross-owner confirmation.
- [x] Keep convention-discovered external Live2D motion/expression unavailable until KSM-0005 supplies runtime registration and compatibility validation.
- [x] Add parser, resolver, convention, materialization, context projection, semantic integration, picker, and typed-slot regression tests.

First-version hardening and follow-up:

- [ ] Extend project convention indexing to SFX and HTML custom animations after defining their canonical project roots; add icon, font, LUT, and mask when their consuming systems are ready.
- [ ] Replace manual/full index refresh with project/template file watching, deletion/rename invalidation, and incremental rebuilding where useful.
- [ ] Add large community-package scan benchmarks and a visible indexing/error state for slow or invalid packages.
- [ ] Add dedicated outfit, owner, format, and compatibility filter controls; optionally support advanced queries such as `owner:soyo namespace:mygo idle`.
- [ ] Replace the temporary cross-owner confirmation dialog with an in-picker confirmation/detail region using character display names.
- [ ] Restore contextual short display and full-identity tooltip for already-materialized Inspector values instead of showing only the stored project path.
- [ ] Add richer image/model/audio previews and a dedicated ambiguity-resolution view.
- [ ] Audit collaboration manifests, save/export collection, missing-asset validation, and rename migration so every consumer uses registry asset-slot metadata.
- [ ] Connect compact short-name input to Raw Script/template authoring diagnostics, copy/paste, and candidate confirmation.
- [ ] Extend the template migration CLI to generate/validate `resourceConventions`, aliases, and precedence conflicts.
- [ ] Publish Chinese/English template-author documentation and representative large-package/conflict examples.
- [ ] Implement resource rename/move migration that rewrites stable source references.
- [ ] Complete external Live2D motion/expression registry, runtime-family adapters, parameter compatibility reports, and cross-character reuse under KSM-0005.

## KSM-0004 上下文短资源名

第一版已完成：

- [x] 定义 `ResourceKind`、结构化 `ResourceKey`、`[namespace@][owner:]name` parser、显式路径识别和结构化诊断。
- [x] 从第一批项目 asset roots、manifest v2 `assets.index`、alias 和受校验的 package-local `resourceConventions` 建立确定性统一索引。
- [x] 实现模板包根目录/路径逃逸保护，以及确定性的优先级和歧义处理。
- [x] 解析启用 namespace、owner、显式 outfit，并按语句时间从 canonical `characterPresence` facts 投影活动 outfit。
- [x] 模板资产物化和显式项目/已注册外部库路径 projectize 后，才把稳定项目引用写入 scene schema v4。
- [x] 记录来源/物化 receipt，并将资源选择与 semantic statement 或角色修改原子提交。
- [x] 在 `SceneStatementDefinitionRegistry` 声明 typed source/compiled asset slots，并由 `RuntimeAssetPreparer` 消费。
- [x] 第一批 picker 已覆盖角色主/副模型、背景/图片、BGM/SFX、voice 和 custom animation；项目约定索引未覆盖的类型仍可使用文件视图。
- [x] 实现上下文显示规则：本 owner 显示 `name`，跨 owner 显示 `owner:name`，仅实际冲突时显示 namespace。
- [x] 实现当前/其他 owner 分组、namespace 筛选、metadata 搜索、刷新和跨 owner 确认。
- [x] KSM-0005 提供 runtime 注册和兼容校验前，不把 convention 发现的外部 Live2D motion/expression 标记为可用。
- [x] 增加 parser、resolver、convention、物化、上下文投影、semantic 集成、picker 和 typed-slot 回归测试。

第一版加固及后续：

- [ ] 定义规范项目根目录后，把 SFX 和 HTML custom animation 加入项目约定索引；待对应消费系统就绪后再加入 icon、font、LUT 和 mask。
- [ ] 用项目/模板文件监听、删除/重命名失效和适当的增量重建替代手动/全量索引刷新。
- [ ] 增加大型社区资源包扫描 benchmark，以及慢速或无效模板包的可见索引/错误状态。
- [ ] 增加独立 outfit、owner、格式和兼容性筛选控件；可选支持 `owner:soyo namespace:mygo idle` 高级查询。
- [ ] 用 picker 内确认/详情区域替换临时跨 owner 确认框，并使用角色显示名。
- [ ] 已物化的 Inspector 值恢复上下文短显示和完整 identity tooltip，而不是只显示持久化项目路径。
- [ ] 增加更完整的图片/模型/音频预览和专用歧义消解界面。
- [ ] 审计协作 manifest、保存/导出收集、缺失资产验证和重命名迁移，确保所有消费者统一使用 registry asset-slot metadata。
- [ ] 将紧凑短名输入接入 Raw Script/模板创作诊断、复制粘贴和候选确认。
- [ ] 扩展模板迁移 CLI，使其能生成/校验 `resourceConventions`、alias 和优先级冲突。
- [ ] 发布中英文模板作者文档，以及大型资源包和冲突示例。
- [ ] 实现资源重命名/移动迁移，同步改写稳定 source references。
- [ ] 按 KSM-0005 完成外部 Live2D motion/expression registry、runtime family adapter、参数兼容报告和跨角色复用。
