---
status: archived-draft
last_reviewed: 2026-07-20
---

# Template UI Entry Points Draft

> Archived: this draft captured the first template UI direction. The implemented contract is now documented in `docs/en/template-system.md`, `docs/cn/template-system.md`, and KSM-0001; deferred work lives in `TODO.md`.

KSMADR-0001 已经把统一模板包定义为长期边界，但第一轮实现只落到 manifest、loader、asset resolver 和 timeline combo 数据来源。模板系统还需要产品入口，才能让用户在创建项目、导入角色和编排 timeline 时实际使用模板。

本 ADR 是短草案，不作为最终 UI 决策。后续需要结合真实模板包内容、角色资产 projectize 行为和协作资源规则继续讨论。

截至 KSM-0003 验收，项目已实现模板包发现、启用排序、默认值解析、项目创建时角色播种、打开项目后导入模板角色、timeline combo 来源展示，以及三种 semantic payload 的插入预览。镜头与光照 preset 进入 semantic source authoring；compiled runtime action 不再是模板契约。环境、文字、音频、导出 preset 的其他应用仍按本 ADR 保留为后续逐项决策；显式 template companion 之外的自动对白镜头生成暂不作为隐式行为实现。

## Product Direction

模板系统的目标不应只是“复制一个项目骨架”，而是让用户在创建项目和后续创作过程中快速建立一组可复用的创作基线。创建项目页本身不应承载所有模板 capability 的细项配置；它应只承担轻量入口职责：

- 项目名称和项目位置。
- 启用哪些模板包。
- 模板包顺序，也就是同一 scope 内的优先级。
- 进入“模板能力配置”的入口。

模板能力配置应是一个可复用页面或面板，而不是只服务创建项目的一段表单。创建项目时可以用它配置项目初始化 baseline；项目进行中也可以从同一个入口管理模板能力、导入角色或应用模板资产。这个边界避免创建页随着 capability 增加而变成大而全的配置页。

模板能力配置可以逐步支持：

- 项目默认光照、后期、色调与角色融合基线。
- 项目默认 dialogue style，例如文本框 renderer、字号、颜色、说话人样式和默认参数。
- 初始角色集合。角色模板应支持一个角色绑定多个模型或变体，而不是把“角色”简化成单个 Live2D 模型；标准做法应鼓励多个 Live2D 模型共用同一个 scene character identity，并通过 variants / model entries 表示服装、表情套、姿态或版本差异。
- 镜头模板与常用镜头语言，例如 push、pull、shake、follow、Hitchcock、路径运动等。
- 可被项目使用的模板资产，例如角色模型、背景、字体、贴图、音频、效果文件和 UI 资源。

这种设计允许用户从项目一开始就拥有可用的视觉风格、角色库、对白表现、镜头语言和素材来源，后续仍可继续从模板包中导入角色、combo、visual recipe 或 scene blueprint。模板应用后的结果必须进入项目自己的可编辑数据和资源系统；项目不应在运行时依赖远程 registry 或未声明的 template-relative path。

## Candidate Entry Points

第一优先级是“创建项目时选择模板包和进入模板能力配置”。`ProjectHome` 的主创建表单只显示模板包、启用状态和顺序；角色、默认对白样式、scene blueprint、镜头/光照 preset 和模板资产索引等细项进入 Template Capability Config。`ProjectOpenWorkflow` 在创建默认项目后、加载默认 scene 前应用这些选择，并通过资源系统处理模板资产。

Template Capability Config 必须被设计成可复用入口。创建项目时，它表达“项目初始化配置”；项目进行中，它表达“模板管理 / 从模板导入 / 应用模板能力”。第一版可以只承载角色选择，后续再逐项加入 dialogue style、scene blueprint、模板资产、镜头、光照、环境、文字、音频或导出配置。

第二优先级是“从模板导入角色”。角色预设是模板包的一等 capability，用户价值清晰，也能验证模板资产解析、角色 metadata 转换和 `ProjectResourceService` 的 copy/mount 边界。入口可以放在角色目录的添加动作旁边，也可以放在 `addCharacter` inspector 的模型选择附近。应用后应生成项目可编辑的 scene character metadata、variants 和必要 timeline params，而不是保存远程 registry 依赖。角色预设必须支持多个模型共用一个角色 id，例如同一个角色的常服、舞台服、近景模型、轻量模型或不同 Live2D runtime 版本。

当前实现采用一个较小的第一阶段入口：项目打开后，顶部工作区提供“模板”按钮，打开同一个 Template Capability Config。用户可以保存当前项目的模板包启用顺序和角色 preset 选择，也可以执行“保存并导入角色”。导入角色时，模板角色会转换成当前 scene 的 `meta.characters`，保留 variants，模型资产通过现有资源系统 copy 进项目，写入通过角色目录服务完成，因此可撤销，并且会跳过当前场景中已有的同 ID 角色。自动生成 `addCharacter` 暂不实现；如果后续需要，应重新讨论其时间轴位置、重复导入和验证规则。角色目录旁、`addCharacter` inspector 旁的更细入口仍可后续补充。

默认配置采用三层解析：软件内置默认值、模板建议默认值、用户显式覆盖值。模板可以通过 manifest 的 `defaults` 建议默认 dialogue style、光照、镜头等 selector；同一配置项有多个模板建议时，按模板优先级取最高者。用户一旦在 Template Capability Config 中手动选择某项，该值保存为项目 metadata 中的 override，后续新增或调整模板不会静默覆盖它。UI 必须展示来源，并允许用户重置回模板默认值。

现有 timeline “组合母板” UI 已消费 enabled template catalog 的 `manifest.v2.json` semantic combos，并展示 builtin/user/project 来源与模板包名称。完整冲突 diff 可视化仍可延期。

第四优先级是 dialogue style 选择。模板包可以声明 `dialogueStyles`，但第一阶段只能引用内置 renderer 并覆盖可序列化参数。UI 可以在 Template Capability Config 中把 style 作为更友好的选项展示，也可以在项目创建时保存默认 dialogue style，但不能引入外部 renderer 代码执行。

第五优先级是模板资产浏览与应用。模板包的 `assets/` 应作为只读来源在 UI 中可见；用户可以从模板资产中导入角色模型、背景、字体、音频、图片或效果文件。应用到 scene 或 project metadata 时，路径必须通过 `ProjectResourceService` 转成 project-relative 或已登记 mount reference，协作前仍必须经过 readiness gate。

第六优先级是视觉、光照和镜头 preset。AES 的视觉能力比 WebGAL 的 UI 皮肤更深，应把镜头语言、光照、后期、lens recipe、composite recipe 和环境层布局作为模板系统的重要能力。它们可以作为项目默认基线、scene blueprint 的一部分，也可以作为后续 timeline combo 或 visual recipe 单独应用。

第七优先级是复数模板启用与排序。项目创建和项目设置中应允许同时启用多个模板包，例如同时启用 `mygo`、`mujica`、通用镜头包和通用对白样式包。跨 scope 仍按 `project > user > builtin` 生效；同一 scope 内应由用户可见的 enabled template list 决定优先级，并采用“列表中越靠后越优先”的规则。当前创建页通过启用列表中的序号和上下移动按钮表达优先级；完整冲突可视化暂不作为第一阶段要求。

第八优先级是环境布景模板。环境层、背景、前景、叠加层、tile 参数、默认 transition 和常用布局可以作为可应用的 scene dressing。它们既可以在创建项目时成为默认舞台，也可以在创作中作为“布景模板”导入到当前 scene。

第九优先级是文字图层和标题卡模板。AES 已有 `addTextLayer`、`transformTextLayer` 和文本样式参数，适合模板化章节标题、片头片尾、注释条、字幕式信息层、直播/节目包装文本等。它们不应和 dialogue renderer 混为一类；dialogue style 解决对白框，text layer style 解决画面中的独立文字对象。

第十优先级是音频与音画联动模板。BGM、voice、音效、fade、loop、音量基线和冲击音效加镜头/后期组合都可以模板化。简单音频 preset 可以是参数集合，复杂音画联动应作为 `authoringCombos` 或 scene blueprint 的一部分。

第十一优先级是导出和平台 preset。分辨率、fps、码率、导出后端、目标平台或视频平台规范可以共享模板包/registry 的分发模型，但它们属于项目工作流配置，不应和 scene authoring capability 混在同一个 application service 中。第一版可以只作为后续讨论项保留。

## Open Questions

- `TemplatePackageLoader` 应由哪个 app-level service 持有，并如何通知 UI project/user/builtin 模板源变化？
- enabled template list 应保存在哪里：project metadata、用户设置，还是二者都支持并在项目打开时合并？
- 同一 scope 内模板排序 UI 已进入创建项目页；后续项目设置和模板管理页应复用同一选择组件，还是只复用底层 view model？
- 角色模板应用的第一阶段默认策略已经选择 copy 资产进项目。后续仍可讨论是否为大资产增加显式 mount/projectize 模式。
- 多模型角色预设在 manifest 中应如何表达：直接内联 `variants`，还是引用更完整的 `presets/*.json` 定义文件？
- 创建项目 blueprint 应直接生成默认 scene，还是先生成可预览的 Template Capability Config 摘要？
- 项目默认 dialogue style、光照、镜头 preset 的第一阶段方向是保存为 project-level selector；只有用户覆盖值进入 project metadata，模板建议值运行时解析。是否把某些默认值展开进 scene / timeline 仍需按 capability 单独决定。
- 模板资产在 UI 中应显示为独立“模板资产”来源，还是并入现有资源浏览器并用 source badge 区分？
- 模板资产冲突是否需要第一阶段 UI 呈现？当前判断是暂缓，只通过模板顺序表达优先级。
- 环境布景、视觉配方、镜头 preset 和音频 preset 应作为独立 capability 展示，还是统一放进 scene blueprint / authoring combo 内部？
- 文字图层模板是否需要单独的 preview surface，还是复用现有 stage preview 即可？
- 导出 preset 暂时搁置。它是否属于 template package 的 capability，还是应另开 export profile / workflow preset ADR，后续单独决定。
- 用户临时保存一组 timeline 语句时，应进入轻量 snippet/blueprint，而不是 template package；这个入口是否和模板 UI 放在同一个面板？

## Non-Goals For First UI Pass

- 不支持外部 JavaScript、PIXI renderer 或任意脚本执行。
- 不接社区 registry 安装流程。
- 不把 scene schema 改成 template-relative asset reference。
- 不把临时 timeline 片段保存进 `manifest.v2.json`；只有正式 `timelineFragment` preset 属于模板包。
- 不在第一版实现完整图形化模板编辑器；先实现选择、导入、应用和 source metadata 展示。
- 不把所有模板 capability 堆在项目创建页主表单；创建页只做模板包选择和进入能力配置。
- 不在第一版实现镜头、灯光、环境、文字、音频和导出 preset 的完整应用 UI；这些能力后续逐项决策。
