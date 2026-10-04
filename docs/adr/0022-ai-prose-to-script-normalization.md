---
status: proposed
---

# AI Prose-to-Script Normalization Boundary

AeonStagery 的 **AI 铺戏**只把用户提供的完整正文无损地结构化为适合视频编排的语义脚本，不根据梗概续写、补写、压缩、润色或改写剧情与对白。输入正文可以混合叙述和直接引语；输出是可预览的只读 semantic statements，再由确定性时间编排生成时间与时长。草稿正文语句不可编辑；用户可以调整主要人物名单，并在同名角色存在歧义时选择绑定目标，正文结果的修正统一在原子应用后的正式时间线中完成。

## Decision

- **源正文**是用户已经写成的叙事内容，不是故事梗概、写作要求或待扩写的大纲。
- **正文语句流**是规范化的主要结果：一个保持原文顺序的有序序列，其中每个文本块必须且只能分类为**角色对白**或**旁白**。
- 正文规范化 LLM 对叙述输出空字符串 `speaker`；非 AI 编译器写入正式 `dialogue` statement 时同时省略 `speaker` 与 `speakerId`，在产品语言中称为**旁白语句**。
- 正文中的直接引语生成带 `speaker` 显示名的 `dialogue` statement，在产品语言中称为**角色对白语句**。LLM 识别出的显示名必须保留；稳定的 `speakerId` 不属于 LLM 输出，由非 AI 绑定器自动填写。
- 未能匹配项目角色的 `speaker` 仍然表示合法角色对白，不降级为旁白，也不阻止草稿预览或应用。对白署名与项目角色资源是两个层级：只有 AI 提取的主要人物名字才由非 AI 绑定器复用或创建稳定 `speakerId`，并在原子应用时进入 `SceneMeta.characters`。
- 店员、路人、广播声等名单外临时说话人仍保留 `speaker` 名字，但不生成 `speakerId`，也不进入角色管理面板。旁白同时省略 `speaker` 与 `speakerId`。
- AI 生成的主要人物身份信息只有 `name`。不生成额外的 `characterKey`、正文称呼或别名字段；`model`、`color`、`voiceProfileId`、`variants` 等资源或表现字段同样不能由 AI 猜测，未配置时保持空缺。
- 规范化模型必须利用目标故事段内部的语境判断每句角色对白的说话人；“未知角色”、空 `speaker` 或“说话人待确认”不是合法角色对白输出。缺少 `speaker` 必须按响应校验失败处理，不能把识别责任转交给用户。
- **无损结构化**只允许识别说话人、区分叙述与直接引语、按原文顺序分段，以及移除不属于发言内容的引号等句法包装；不得删减、合并、换序或改写作者的词句。
- 插在同一角色两段引语之间的叙述或引语标签仍生成独立旁白语句，不能因已被用于识别说话人而删除。
- 角色资源绑定、进退场、停顿、marker、镜头和其他演出安排不是第三种正文文本分类；它们不能阻止正文先形成完整的两类语句流。
- 单个角色对白或旁白块以 90 个可见字符为目标容量；超过目标的连续文本由非 LLM 后处理器拆成多个同类语句块，不通过缩小字体、截断文本或压缩 duration 塞入一个块。因为拆分只能发生在原文标点后，90 字不是可以通过句中硬拆保证的绝对上限。

每条新 AI 铺戏产生、并在绑定后具有稳定 `speakerId` 的角色对白都必须恰好携带一个角色表演占位 companion：`anchor: "start"`、`offset: 0`、`type: "characterPerformance"`、`params: { target: "$speaker", motion: "" }`。旁白和只有 speaker 显示名、没有 speakerId 的临时说话人不生成。重试、checkpoint 恢复或重复确定性编排必须按 dialogue 去重，不能重复追加。

角色表演占位是新 AI 铺戏的独立确定性基线，不依赖表演指导或电影感大师。结果应用后，它作为普通 characterPerformance companion 供用户直接手动填写 motion、expression、lookAt、blink；表演指导只是可选自动补全消费者。scene schema v4 已删除 characterPerformance 的 duration、loop、priority 字段，motion 使用空字符串占位或 `{"kind":"resource","key":...}` 对象。最小 source 不额外写入 `expression: ""` 等字段，undefined 本身表示可填写。空占位不能被 compiler 或清理逻辑当作无效 source 删除。

角色表演占位不是 scene schema/data migration。项目打开、codec 迁移、普通加载或保存不能自动为既有 dialogue 回填；既有 scene 只能由用户显式运行表演指导或项目 Agent 补全。source parser 只对 `characterPerformance.motion` 特许精确的空字符串 `""`，纯空白 motion 仍然非法且不能被自动 trim 为占位，其他原本要求非空的字符串字段不放宽。compiler 保存该 source，但 motion 为空时不生成 runtime `playMotion`，同一 performance statement 中其他非空 expression/lookAt/blink 仍可正常编译。

## Pipeline Boundary

AI 铺戏采用分阶段管线，避免让单次 LLM 调用同时承担长文分段、正文理解、时间计算和演出设计：

1. **语义分段规划**：系统按 `x = max(1, round(正文可见字符数 / targetBatchSize))` 计算目标段数；一个专用 LLM 通读正文并按故事结构选择分界点，使程序切出约 `x - 1` 到 `x + 1` 个处理段。
2. **主要人物提取与确认**：另一个单一职责 LLM 通读完整正文，只返回去重后的人物名字数组，例如 `{ "mainCharacters": ["林夏", "周衡"] }`。它不返回故事总结、角色描述、别名、正文或 `speakerId`，并与语义分段规划并行执行。正文规范化开始前，用户可以对这份名字列表添加人物、删除人物或改名。
3. **正文规范化**：LLM 分别把每个处理段转换成正文语句流，并参考用户确认后的全篇主要人物名字列表；每块统一包含 `speaker` 与 `text`。角色对白直接把人物名字写入非空 `speaker`，也允许填写名单外的临时说话人名字；旁白使用空字符串 `speaker`。LLM 响应不得包含 `kind`、`speakerId` 或额外角色键。
4. **确定性基线编排**：非 LLM 编排器只根据合并后的语句文本与确定性配置计算 duration 和连续串行的最早开始时间，不读取语音文件时长；即使后续 LLM 阶段不可用，也能生成合法时间线。
5. **语义节奏规划**：按故事处理段分别调用单一职责的 LLM，只为段内相邻语句边界输出 `gapSeconds` 正浮点数，不修改文本、分类、说话人、顺序或 duration。
6. **节奏应用**：非 LLM 编排器验证 `gapSeconds` 并重算开始时间。
7. **非写入角色绑定计划与确定性角色表演占位**：可选增强开始前，宿主根据用户确认的主要人物和当前 scene 角色生成并随 AI 铺戏会话保存 `CharacterBindingPlan`。该计划复用唯一同名角色，为缺失角色预分配稳定 `speakerId`，但不修改正式 `SceneMeta.characters`；宿主据此生成草稿 semantic scene 投影，并为每条可稳定绑定的角色对白生成一枚最小 characterPerformance companion。该结果本身即可应用并由用户手动填写，不依赖任何可选 AI 增强。同名角色存在多个且没有用户选择时，流程暂停在角色消歧步骤，不能猜测绑定。
8. **可选表演指导**：表演指导处理器消费已经带有角色表演占位的 semantic statement 草稿，为对白及相关角色反应生成 typed performance patch。通用处理器可以消费可选 `PerformanceProfileProvider` 返回的专用表演资料，但角色、模型、motion 与 expression 的实际可用信息必须来自当前项目资源，不能依赖旧 prompt 的固定 ID 或固定动作表。
9. **可选电影感增强**：电影感处理器消费已经完成表演增强的 semantic 草稿，为有叙事动机的节点生成 typed camera、lighting 和 visual patch。表演指导与电影感大师启用时按此顺序自动执行，中间不要求用户确认；任一增强阶段不可用都不影响正文规范化、确定性时间编排与角色表演占位独立成立。

旧 `src/api/agentPrompts.ts` 的四阶段 `AGENT_PIPELINE` 不是兼容接口，只作为迁移时可参考的提示词素材。实现不保留输出完整 `meta + timeline action JSON` 的编剧阶段、不保留无功能的技术美术占位，也不为旧 action JSON 增加兼容层；编剧职责由本 ADR 的 AI 铺戏管线承担，表演指导与电影感提示迁入各自的 semantic patch 处理器。旧 prompt 中硬编码的角色 ID 与固定动作表不进入通用处理器，专用资料只通过可选 `PerformanceProfileProvider` 注入。

表演指导还可以脱离 AI 铺戏草稿，对当前 active scene 单独运行。正式 scene 增强只提供叙事分段与表演指导，处理一个 active scene snapshot，不批量遍历项目内全部 scenes；表演指导输出 typed semantic patch，并通过 semantic authoring seam 应用。电影感处理器保留为 AI 铺戏草稿中的可选增强，不在正式 scene 增强入口提供。正式 scene 增强与项目 Agent 独立，项目 Agent 不调用或编排表演指导处理器。

AI 铺戏模式中的增强结果继续属于草稿，最终随完整草稿一次原子应用，其中可以包含表演指导与电影感 patch。正式 scene 增强运行只生成表演指导 patch 预览，不自动修改 scene；用户必须明确点击应用。项目 Agent 的自动提交授权不延伸到表演指导处理器或电影感处理器。

正式 scene 的表演指导 patch 只用于构建内存 candidate，不写入 DocumentStore。用户应用时，宿主先物化并完整校验最终 candidate，再根据表演阶段执行时保存的内部 locator 生成 authoring plan，通过一次 semantic authoring transaction 原子提交并只创建一条 history/undo 记录。最终 source schema、semantic、compiler 或资源 gate 任一失败都不产生正式 scene 变更，也不向模型开放 transaction-local 临时行号。

表演指导处理器与电影感处理器都使用不暴露宿主内部 UUID identity 的扁平 semantic scene 视图：root statement 与 companion 通过连续 line 展示，companion 使用 parentLine 表达归属。两个处理器的 typed patch 也只接受 line-based locator；宿主在该次处理固定的输入 snapshot 内转换为 statement/companion locator。表演指导处理器可以更新对白后的角色表演占位 companion，电影感处理器可以围绕现有行插入或更新 camera、lighting 与 visual statements。LLM 输入、prompt 和响应都不能出现 statementId 或 companionId，但 params 中的角色号、layerId、recipeId、motion key 和资源引用等领域语义键继续保留。

表演指导、电影感大师与项目 Agent 复用中立的版本化 `SemanticScenePatchV1 { version: 1, operations: SemanticSceneOperationV1[] }` operation algebra，而不使用暗示从属于项目 Agent 的 `AgentSceneOperation` 命名。V1 固定为 `insertStatement`、`insertCompanion`、`updateStatement`、`updateCompanion`、`deleteLine`、`moveLine` 和 `reorderCompanions` 七种结构操作；`deleteLine` 与 `moveLine` 根据固定 snapshot 的行映射解析 root statement 或 companion。批量行为通过 `operations` 数组组合，不增加 family-specific 或 bulk operation；现有 `duplicate-statements`、`insert-script-segment` 等便捷 intent 由读取后插入或多个 primitive operations 表达。

statement family 的完整 payload、partial patch 和阶段 JSON Schema 必须由 `SceneStatementDefinitionRegistry` 的权威 family 定义与数据化 stage policy 派生。新增 family 只扩展 registry，不得新增 family-specific command、复制 schema 或维护平行 validator。每个入口由 policy 收窄 allowed operations、families 和 patch paths，因此复用只发生在 patch 表达与本地执行基础设施，不共享权限、自动应用授权或任务生命周期。空 `operations` 是合法的“无需修改”结果；响应不能包含整份 scene、宿主内部 UUID identity 或解释性 prose。

`insertStatement` operation 必须显式提供非负有限 `time`，并提供不含 statement UUID 或内嵌 `time` 的完整 `type + params` statement draft。只有 dialogue draft 可以同时携带完整 companions，每个 companion 必须包含 `anchor + offset + type + params` 且不含 companion UUID，从而可以在一个 operation 中原子创建尚无行号的父子结构。params 中合法的领域语义 `id`/key 不受此限制。可选 `beforeLine` 只能指向固定 snapshot 中与新 statement 时间完全相同的 root statement，用来确定同时间语句的 source 顺序；省略时插在该时间点所有现有 root statements 之后。V1 不提供 `afterLine`，也不允许利用不同时间的 `beforeLine` 制造 source order 与时间顺序不一致。

`insertCompanion` operation 必须提供一个 dialogue root `parentLine` 和不含 companion UUID 的完整 `anchor + offset + type + params` companion draft。可选 `beforeLine` 只能指向同一 parent 在 transaction 初始行视图中已经存在的 companion；省略时追加到末尾。宿主可以在同一 candidate application 内把该 operation 转换为现有 insert companion intent，并在需要时紧接现有 reorder companion intent。新 companion 的内部 UUID 只供宿主完成该 operation，不返回模型，也不能被同一显式 transaction 的其他 operation 引用，因此不会引入 transaction-local alias。

UUID 隐藏必须按 registry/schema 标记的技术身份字段执行，不能扫描并删除所有名为 `id` 的字段，也不能按字符串形状猜测 UUID。sceneId、statementId、companionId、task/correlation/transaction ID 等宿主身份不进入模型；speakerId、角色号、layerId、recipeId、instanceId、graphic/lighting object id、motion/expression key 和资源引用等 authoring 语义值继续原样进入 params 并接受 schema 校验。

同 family 的 `updateStatement` 和 `updateCompanion` 参数更新采用由 registry schema 派生的递归 JSON Merge Patch。字段省略表示保持原值，对象按叶字段递归合并，数组整体原子替换，`null` 表示删除可选字段；当前 scene params 不接受业务 `null`，因此删除语义无歧义。删除必填字段、产生不合法 discriminated union 或提交空 patch 都会失败，真正无需修改时应返回空 operations。

`updateStatement` patch 不接受 ID、time 或 companions，绝对时间由 `moveLine` 单独修改；`updateCompanion` 不接受 ID 或 parent 变更，但可以修改 anchor、offset 和 params。update 中出现与当前 family 不同的 `type` 时表示 atomic family replacement，必须同时提供新 family 的完整 params，不能按旧 family partial merge。root replacement 保留 root 行号并删除与新 family 不兼容的 companions；依赖替换后类型或新结构的修改不能在同一显式 transaction 中借助 operation 顺序完成，必须在下一轮重新读取后继续。`moveLine` 与 update 若写入同一有效时间字段则属于 `conflicting_operations`。

`deleteLine` 根据固定行映射删除一个 root statement 或一个 companion；删除 root 同时删除其全部 companions。`moveLine` 接受非负有限的绝对 scene time：root move 只修改 time 而不重排 source statement 数组，因此属于保留行号的内容变更；companion move 根据最终 parent time 与当前 anchor 计算 offset。同一 transaction 同时移动 parent 与其 companion 时先确定全部 root 最终时间，再计算 companion offset，不依赖 operation 数组顺序；若同一 companion 还通过 update 修改 anchor 或 offset，则返回 `conflicting_operations`。

`reorderCompanions` 必须提供 dialogue `parentLine`，其 `orderedLines` 必须恰好包含 transaction 初始 snapshot 中该 parent 的全部 companion lines 各一次。reorder 不得与同一 parent 的 companion insert 或 delete 出现在同一 transaction；新 companion 的位置应由 `insertCompanion.beforeLine` 直接表达。delete 与 reorder 都是结构变更，并使受影响位置及其后的行映射失效。

`SemanticScenePatchV1` 的边界只包含全部 statement families 与 dialogue companions，不包含 marker、scene meta 或 character directory mutation。表演指导和电影感大师按各自 policy 使用其中子集；项目 Agent 可以使用全部 statement families，但对其他 scene/project authoring 域在 V1 中只读。未来若开放 marker、meta 或角色目录写入，应建立相应的专用 authoring facade，而不是扩大共享表演/电影感 patch 的权限。

每个表演窗口或电影感故事段的响应都必须依次通过 JSON parse、版本化 schema、阶段 family 白名单和 semantic validation。首次失败时宿主最多向模型发起一次带结构化错误的纠正请求；纠正结果再次失败后，当前处理单元进入可重试失败，并遵循其既有 checkpoint 与下游失效规则。

正式 scene 增强预览与生成时的精确 DocumentStore version 绑定。表演指导判断消费完整 scene 语境，因此只要 version 变化，整份未应用预览就失效；应用时不做字段级三方合并，用户必须基于最新 scene 重新运行表演指导。AI 铺戏草稿继续使用其既有下游失效规则。项目 Agent 可以重新读取与重新规划的并发语义不适用于这些一次性增强预览。

正式 scene 增强运行状态只保存在 renderer service 内存中，并绑定 `{ sceneSessionEpoch, documentVersion }`。用户关闭增强面板但应用仍运行时可以继续保留；切换 active scene、任何 scene authoring、renderer 刷新或崩溃、应用退出或重启都会使状态失效并丢弃。正式 scene 增强 checkpoint 和未应用 patch 不写入项目或本机恢复日志，也不能仅凭 scene 路径或内容哈希跨进程恢复。

通用表演指导处理器只定义表演决策原则与 typed patch 契约，并提供可选 `PerformanceProfileProvider` 注入 seam。专用表演资料由启用的模板域提供，模板 manifest 声明 profile，较大的 profile 可以由模板包内的版本化 JSON 文件加载；同一 `profile.id` 遵循现有启用模板优先级，由更高优先级模板覆盖。资料包含角色 alias、身份匹配和专用动作语义；它不进入通用 prompt，也不改变通用处理器在缺少资料时采用的通用策略。无论 provider 如何实现，其返回的 motion/expression 都必须先与当前模型实际能力求交集，并继续通过统一 source、resource 与 stage policy gate；外部资料不能授权不存在的 key 或绕过硬校验。

profile 中的 motion 候选表示当前模型使用的本地模型动作键，例如 `char-b/angry01`，并沿用现有 `characterPerformance.motion` 与 runtime `playMotion` 的 source 语义；模板 namespace 只标识 profile 的资料来源，不把 scene motion 改写成模板或外部资源引用。provider 返回的候选仍必须与当前模型实际声明的 motion keys 求交集，未命中的 key 只能被丢弃或作为能力诊断，不能进入 patch。

profile 声明的动作键是按参考模型整理的语义，不是对任意同名角色模型的能力授权。当前模型实际存在同名 key 时才附加 profile 描述；缺少 profile key 时记录 `profile_motion_unavailable` warning，模型新增但 profile 未收录的 key 仍可作为无专用描述的通用能力。模型已经配置但无法读取或解析仍属于严格资源错误，不因 profile 命中而降级。

profile 是声明式能力目录，只包含角色 canonical name、alias、模型动作键/表情键及其短描述；通用表演决策原则仍由处理器 prompt 和 stage policy 负责。profile 不携带 system prompt、可执行规则、强制覆盖策略或固定覆盖率要求；表达资料只有在 profile 声明且当前模型实际提供时才进入目录。

profile 只提高匹配动作的语义准确性，不提高固定动作覆盖率；表演指导仍只在有叙事动机时生成动作或听者反应。旧 prompt 中针对固定角色 ID 的“全额控制”和“拒绝罚站”不迁移为 profile 的专用 policy。

专用 profile 以可安装、可启用的 profile-only 模板包交付，不默认注册，也不携带或隐式物化 Live2D 模型资产；模型能力由当前项目/已启用资源提供。未启用该模板包时，通用表演指导仍可正常运行。

模板 manifest 以 `performanceProfiles: [{ id, name, schemaVersion: 1, file? }]` 声明 profile；较完整的 profile 可以放在模板包内的版本化 JSON 文件中，由 `file` 指向。profile 可以直接在声明中提供 `characters`，也可以通过 `file` 提供完整内容，但二者不能同时出现，避免半覆盖合并。

profile 缺失或当前角色没有匹配资料时，处理器使用通用策略并保留正常的能力降级诊断；profile 文件缺失、JSON/schema 无效或 profile schema 版本不支持则使所属模板包加载失败，由模板 discovery 返回结构化 issue，不得把损坏资料静默当作无 provider。

`PerformanceProfileProvider` 只负责从已加载模板 profile 解析角色资料，不读取模型文件、不访问舞台、不探测 Live2D；宿主按入口提供当前模型的实际 motions/expressions，能力目录 builder 再做交集。renderer 使用现有模型数据读取 seam，项目 Agent 使用受控资源工具结果，两者不能被 profile provider 混成一个文件或运行时读取器。

表演资料按单个 scene character 独立解析，先使用模板 `characterPreset.id` 与当前 scene character `id` 的稳定匹配，再对 canonical name 与 alias 做 Unicode 规范化后的精确后备匹配；model、outfit 和资源路径不构成身份。只有同一个 scene character 命中多个同等候选时才返回 `ambiguous_identity` 并暂停当前表演单元；同一 scene 中同时出现多个各自可匹配的角色不构成歧义。解析不使用模糊包含匹配，组合名称必须作为显式 alias 声明。任何歧义都不能静默改写 `CharacterBindingPlan`、`SceneMeta.characters` 或正式 scene 角色集合；alias 只能用于给用户显示解析建议，不能替代 AI 铺戏的用户确认绑定。

宿主为每个表演处理单元生成只读 `PerformanceCapabilityCatalogV1`，包含当前角色号与名称、在场范围、可用的 lookAt/同步反应目标、实际解析成功的 motion/expression keys、仅支持 lookAt/blink/characterTransform 时的字段级降级能力，以及与实际 keys 求交集后的可选 profile 资料。目录由当前 candidate scene、Live2D 资源解析和 `PerformanceProfileProvider` 共同构造并进入处理单元输入 fingerprint；通用 prompt 不携带固定角色 ID 或完整专用动作表，处理器仍不注册读取工具。

每个表演处理单元的模型请求只组合四部分：包含表演原则、阶段职责和 writable/read-only 使用规则的 system prompt；当前完整故事段文本；用于寻址与表达现有约束的精简扁平 scene 行视图；以及本单元一份按角色号去重的 `PerformanceCapabilityCatalogV1`。AI 铺戏使用已保存的原始故事段文本，正式 scene 使用从该段 speaker/text 投影并带 `[Line:<n>]` 行标签的故事文本；精简行视图不承担完整叙事表达，可以省略已经在故事文本中出现的长正文，但必须保留 line、parentLine、time、type、access 和完成合法 patch 所需的当前 params。自定义 Motion 的逐参数 keyframes 是编辑器/租约产出的技术负载，模型既不需要也不应手写；行视图把每条 track 表达为 `{ parameterId, keyframeCount, fadeInSeconds? }` 元信息，避免数千级关键帧数组占用模型上下文。能力目录按处理单元发送一次，不得在每条 statement 上重复，也不得包含无关的全项目角色或动作表。阶段 JSON Schema 作为 response format 提供，不在 prompt 中再次展开；已有字段约束直接来自行视图并由宿主单调补全 gate 强制，不另发重复的“硬约束”列表。

正式 scene 的故事文本标签采用固定 `[Line:<n>]` 格式，例如 `[Line:12]`，并与精简 JSON 行视图中的 `line: 12` 指向同一 root statement。标签不是物理文本行号、字符 offset 或新 identity；文本换行保留在同一个标签块内，相同文本仍由不同 Line 标签区分。companions 不重复投影进故事正文，只出现在精简行视图并以 `parentLine` 表示归属。模型返回 patch 时仍只能使用 schema 中的 `line`/`parentLine` locator，不能提交标签字符串。AI 铺戏保存的原始故事段不添加 Line 标签。

模型输入不包含独立 `WritableSceneRange` payload。system prompt 规定只能修改标记为 writable 的核心行、只能在当前故事段内插入，行视图以 access 标记区分核心与只读语境；宿主仍在模型之外根据处理单元的内部 group 范围执行不可跳过的 stage scope gate，不能因 prompt 已声明范围而省略硬校验。

stage scope gate 对 line-based operation 要求目标属于当前核心 writable groups；`insertCompanion` 的 parent 必须是核心 writable dialogue，`insertStatement.time` 必须落在核心 groups 的内部时间区间。电影感 `moveLine` 的来源行与最终时间都必须留在同一核心区间，不能跨叙事段或技术切分单元；边界处已有同 time group 时，只有拥有该完整 group 的单元可以插入或移入该时间。任何越界都返回 `stage_scope_violation` 并进入既定纠错路径，宿主不能把时间自动吸附到附近边界。

核心时间区间按 statement 的开始时间定义。除最后一个处理单元外，每个单元使用半开区间 `[当前单元首个 group.time, 下一单元首个 group.time)`；最后一个单元从自身首个 `group.time` 延伸到当前 candidate scene 的确定性 scene end，并包含该末端。scene end 必须通过 statement registry 的 temporal extent 规则从 candidate scene 计算，不能由模型提供或猜测。该 gate 只限制新增或移动 statement 的开始时间，statement duration 可以跨越处理单元边界；跨段状态由后续电影感单元从已经合并的 candidate scene 继续解析，不能据此改变 statement 的开始时间所有权。

未配置 Live2D 模型的角色采用字段级降级，而不是使整个表演阶段失败：其空 motion 占位继续保留，处理器不能生成 expression，但仍可以补全通过 source/semantic gate 的 lookAt、blink 和 characterTransform。宿主为该角色记录 `performance_capabilities_unavailable` warning，并继续处理其他角色及后续电影感阶段。角色已经配置模型 reference、但资源不存在、无法解析或能力检查失败时则属于严格资源错误，当前表演单元进入可重试失败，不能伪装为合法的空能力集合。motion/expression 永远只能从成功解析的实际 keys 中选择；用户后来配置模型后，可以对正式 scene 再次运行表演指导补全仍为空的字段。

表演指导处理器只执行“补全表演”。它可以插入缺失的 characterPerformance root/companion 与 characterTransform statements，并只给已有 statement 中当前为空或未定义的表演字段补值；空字符串 motion 属于可填写的表演占位。已有非空 motion、expression、lookAt、blink 或 characterTransform 参数都是约束，不能被覆盖，已有表演语句也不能删除。角色站位与其他 characterTransform 参数仍是正常可补全项，不额外限制为微调。表演指导处理器不能修改 dialogue 文案或 duration、角色进退场、camera、lighting、visual、背景资源、audio、graphic layer 或 custom animation。

发言者表演优先补全其 dialogue 已有的 `$speaker` characterPerformance 占位。由该句对白触发的非发言者同步反应作为同一 dialogue 的额外 characterPerformance companion 插入，并用明确角色号作为 `target`；只有没有明确对白归属的独立动作才使用 root characterPerformance statement。提示中的“拒绝罚站”只要求模型关注有表演动机的听者反应，不构成给每句对白或每个在场角色机械添加动作的覆盖率要求。

表演 stage policy 只开放四种能力：insert/update characterPerformance root、insert/update characterPerformance dialogue companion，以及 insert/update characterTransform root。characterTransform 不在 registry 的 dialogue attachable families 中，因此不能作为 companion。该阶段禁止 deleteLine、moveLine、reorderCompanions 和所有 family replacement；已有 performance target 与 transform character id 也不能改变。

表演更新必须由宿主对 base 与 candidate 做单调补全比较。缺失字段或空字符串可以变为非空值，已有非空标量、对象叶字段和数组不能被覆盖、清除或替换；`motion: ""` 与其他空字符串一致视为可补。lookAt/blink 按叶字段比较，因此可以保留已有 target 并补 intensity。characterTransform 的 position、scale、rotation、opacity、z、durationSeconds、ease 都是普通可补字段；characterPerformance 的可补字段只有空 motion/expression/lookAt/blink 叶字段，durationSeconds、loop、priority 不在 scene schema v4 契约中。该约束属于 stage authoring gate 的硬规则，不能只依赖 prompt。

长 scene 的表演指导由宿主按本次运行已经解析的故事段组织，不要求单个模型容纳完整 scene。AI 铺戏模式复用正文规范化已经保存的故事处理段；正式 active scene 优先采用用户为本次运行主动给出的分段，没有用户分段时复用现有语义分段处理器。用户分段只是 renderer 内本次运行的临时配置，不写入 scene marker，也不修改正式 scene。语义分段处理器只读取 speaker/text 和宿主提供的候选边界，返回 boundary IDs 而不修改 scene 内容；用户可以直接接受或调整其结果。

正式 scene 分段不引入新的领域 adapter。宿主只用一个内部纯输入构造函数，把有序 statement groups 按自动非文本前置归属投影为供模型理解的 speaker/text 语义单元，并只在投影后的语义单元之间生成不含内部 UUID 的临时候选边界 ID；不可见的非文本 groups 之间不产生模型无法区分的候选。源正文仍由独立的正文输入构造逻辑保留换行、字符 offset 与行内候选。两种输入构造逻辑共同调用只消费有序语义单元、候选边界 ID 与目标段数的语义边界规划核心；该核心只返回 `{ boundaryIds }`，不感知 `SceneDocument`、statement locator、正文字符 offset 或最终切片方式。宿主在核心之外把返回值确定性映射回正文范围或正式 scene statement group 范围。正式 scene 先按 `requestedTarget = max(1, round(speaker/text 可见字符数 / targetBatchSize))` 计算期望叙事段数，再以 `effectiveTarget = min(requestedTarget, candidateBoundaries.length + 1)` 限制为原子组实际可形成的段数；模型接收并校验 effectiveTarget，UI 可以同时展示字符期望值与原子组限制。非文本 statements 不计入字符数，只随相邻组归段，其实际请求容量由后续模型安全预算与技术切分处理。正式 scene、表演指导和电影感处理器都复用全局 AI 设置中的同一个 `targetBatchSize`（默认 4000 个可见字符），不增加按入口或处理器区分的叙事段大小配置；各模型的容量差异只影响安全请求预算与技术切分。

正式 scene 的 `targetSegmentCount === 1` 或全 scene 没有 speaker/text 时，宿主直接确定单一叙事段，不调用语义分段模型。其余情况下，如果语义分段响应在一次纠错后仍未通过校验，增强运行暂停在可重试的分段失败状态；用户可以重试、更换模型或主动提供分段。宿主不能用按容量生成的确定性技术切分冒充语义分段成功，也不能因此修改正式 scene。

真正没有任何 root statement 的空 scene 是正式 scene 增强的成功 `no_changes` 快路径：宿主不调用语义分段或表演模型，不生成空 patch 预览，不允许执行无效果应用，也不创建 history/undo 记录。只有非文本 statements、但没有 speaker/text 的 scene 仍按单一叙事段继续处理。

用户主动分段直接输入时间点，不接触模型 boundary ID 或内部 statement locator。宿主把每个时间点 `t` 确定性解析到第一个 `group.time >= t` 的完整 statement group 之前：更早开始的 groups 属于前段，该 group 及与其相同 time 的全部 roots 属于下一段；root 与 companions 仍不可拆。用户时间点可以选择任意合法 statement group 边界，包括位于连续非文本 groups 之间的边界，并优先于自动分段的非文本归属规则。时间点必须严格递增；多个时间点映射到同一 group 边界、无法解析到后续 group，或产生首尾空段时，分段校验失败且不能开始模型调用。UI 必须显示解析后的实际段起点，不能暗示运行时会在用户输入的秒数上截断 statement。

正式 scene 增强在 renderer 内存中保存一份绑定 `{ sceneSessionEpoch, documentVersion }` 的 `ResolvedEnhancementSegmentationV1`，记录本次由用户时间点或语义分段处理器确定并解析到 statement groups 的叙事边界。表演指导使用这份已解析分段，并可以依据模型的安全请求预算派生技术切分，但技术切分不能改写叙事边界。处理开始后，如果用户调整叙事分段，既有表演结果失效，必须基于新分段重新运行。

正式 scene 的分段边界只能位于 root statement group 之间。一个 root statement 与其全部 companions 始终是不可拆分的原子组，具有相同 time 的 root statements 必须保留在同一 group。自动语义分段的 text-only 投影对没有 speaker/text 的非文本 groups 采用确定性的前置归属：两个含文本 group 之间的非文本 groups 归入后一个含文本 group 所在的故事段，scene 开头的非文本 groups 归入第一段，scene 结尾且后面没有文本的残余 groups 归入最后一段；整个 scene 都没有 speaker/text 时只形成一个叙事段。该自动归属不覆盖用户明确输入并解析成功的时间点。只有解析后的单个故事段超过所选模型的安全请求预算时，宿主才在合法 group 边界上进行确定性技术切分，并把它标记为容量切分而非新的叙事分段。每个表演处理单元可以携带前后少量只读行作为语境，但 typed patch 只能指向该单元的核心可写行；各单元可以有限并发，结果仍按 scene 顺序合并并统一执行 source schema、semantic validation 和 motion/expression 可用性检查。表演指导处理器不自行重新分段。

如果单个不可拆 statement group 本身已经超过所选模型的安全请求预算，宿主必须在模型调用前返回非重试型 `processing_unit_too_large` 并暂停当前增强阶段。已经成功的处理单元可以保留，但任何部分结果都不能应用到正式 scene；宿主不能对相同输入机械重试，也不能拆开 root、companions 或同 time group。正式 scene 增强只能在用户换用更大上下文模型或编辑 scene 后重新运行；AI 铺戏草稿可以换模型重跑该可选增强，也可以跳过增强并继续应用其确定性基线。

电影感处理器的 typed patch 使用 family 白名单，只能插入、更新或删除 camera、lighting、visualStyle、filterAdd、filterChange 和 filterReset statements。它可以把表演结果作为叙事判断上下文，但不能修改表演 patch，也不能修改 dialogue 文案或 duration、角色表演、角色进退场、背景资源、audio、graphic layer 或 custom animation。背景资源绑定属于人工收尾或独立项目 Agent，不属于电影感大师。

电影感 stage policy 对六个白名单 family 的 root statements 开放 insertStatement、updateStatement、deleteLine 和 moveLine。dialogue companion 只开放 registry 实际支持的 camera 与 visualStyle insert/update/delete/move；lighting 与 filter families 不能成为 companion。电影感可以覆盖、清除、删除或改变已有电影感字段与发生时间，不采用表演阶段的单调补全约束。

电影感阶段禁止 family replacement 和 reorderCompanions。不同电影感 family 之间的替换必须明确使用 delete 加 insert；reorder 会要求重排 dialogue 的全部 companions，可能间接改变 characterPerformance 或 audio，因此不授权。每个 operation 的初始目标和最终 family 都必须在白名单内，不能通过临时越界后再恢复的方式绕过 policy。最终候选必须通过完整 lifecycle、compiler 和 semantic validation，不能留下错误配对或不合法的 camera/filter/lighting 状态。

电影感处理器不通过静态 prompt 猜测可用 target、preset 或 recipe。宿主为每个处理单元生成只读 `CinematicCapabilityCatalogV1`，至少包含当前 candidate scene 中可寻址的角色与视觉对象 targets、lighting presets、按 slot/category 分类的 built-in 与 scene recipe IDs、camera/lighting/filter 枚举能力，以及该段开始时已有的 camera、lighting、visualStyle、filter 和相关 object/recipe 状态。目录由 statement registry、当前 candidate scene 与资源解析结果生成，进入处理单元输入 fingerprint，但不注册搜索工具；段首电影感状态不再作为目录之外的重复 payload，模型返回仍必须通过完整 authoring gate。

电影感请求采用与表演处理器相同的精简分层：system prompt 规定电影感原则、writable/read-only 和段内写入规则；user payload 只包含一份完整故事段文本、一份只保留 camera/lighting/visual/filter 寻址与合法修改所需字段的精简行视图，以及本单元一份 `CinematicCapabilityCatalogV1`；阶段 JSON Schema 作为 response format 提供。电影感处理器不接收表演阶段的完整 patch，只读取已经合并进当前 candidate scene 后、对本段叙事与状态判断必要的表演结果。宿主继续根据内部 group 范围执行 stage scope gate。

长 scene 的电影感增强复用本次运行已经解析的同一组故事段，直接按段生成语句，不增加 cinematic beat candidate 或全局二次筛选阶段。电影感处理器按需直接返回 typed patch。故事段及必要的技术切分单元必须按 scene 顺序串行处理，每段 patch 先合并进内存候选 scene，再由宿主确定下一段的 capability catalog 与输入状态。全部故事段完成前不修改正式 scene，从而避免相邻段重复运镜、重复启用效果或遗漏 reset。

增强阶段按处理单元保存 checkpoint。表演窗口之间只有只读语境重叠，单个窗口失败时只重试该窗口，其他成功结果继续保留。电影感段依赖前序内存候选状态：第 N 段失败时保留 1..N-1 并从 N 继续；如果重跑 N 得到不同结果，旧的 N+1 及之后结果全部失效并按顺序重跑。AI 铺戏的 `CharacterBindingPlan`、表演窗口 patch 和电影感分段 patch 都扩展进入既有 `AiProseDraftPersistence` 会话 checkpoint，关闭应用后可以恢复；checkpoint 保存版本化基线指纹、处理单元输入指纹、状态与 typed patch，不为每一步复制完整 candidate scene。恢复时宿主从确定性 semantic 基线按稳定顺序重放已通过校验的 patch，并重新执行当前版本的完整 gate；无法匹配基线或 schema 的旧 checkpoint 按下游失效规则处理，不能直接授权应用。任何部分增强结果都只存在于 AI 铺戏草稿或正式 scene patch 预览，不产生部分正式 scene 提交。

持久状态使用版本化 `AiProseEnhancementStateV1`，包含 base fingerprint、`CharacterBindingPlan`、acting checkpoint state 与 cinematic checkpoint state。每个处理单元只保存稳定 key、输入 fingerprint、processor/policy 版本、`idle | running | succeeded | retryableFailed` 状态、已通过本地契约校验的 `SemanticScenePatchV1`、结构化 diagnostics、attempt count、token usage，以及仅供信息展示的生成 model 名称。完整 prompt、原始 LLM/provider response、每一步完整 candidate scene、statement/companion UUID 和持久 line map 都不能进入 checkpoint。

加载 checkpoint 时，遗留 `running` 单元归一化为 `retryableFailed` 且原因为 interrupted；宿主从确定性基线重建当前行视图，按稳定顺序重放 patch，并重新执行当前版本的完整 gate。processor、stage policy、registry schema，或本次生成实际使用的表演资料提供器版本变化，会使受影响单元及其依赖下游失效。仅更换默认/override model 不静默删除已经成功且仍通过 gate 的结果；用户明确重跑对应单元时才使用新 model，并记录新的 producer metadata。

表演窗口使用现有全局 `maxConcurrentAiRequests` 信号量进行有限并发，并携带稳定窗口序号；结果无论完成顺序如何都按 scene 顺序合并。只读重叠行不能成为 patch 目标，因此并发窗口不会争写。电影感段保持严格串行，但每次模型请求同样占用全局 AI 并发额度。表演与电影感都不创建独立并发池。

语义分段不是按排版机械切分。自然段不是最小处理单位，目标段也不要求与原文自然段一一对应；段界由分段 LLM 根据故事结构决定。分段 LLM 只返回有序分界点，不回传分段后的正文；非 LLM 代码持有唯一源正文，并根据分界点确定性切片。这避免分段阶段重复输出或意外改写长正文。

分界点选择默认采用**行优先、长行降级**策略：

1. 程序保留所有原始换行，给每一行添加仅供提示使用的稳定行号，并把类似 `Get-Content` 后逐行编号的视图交给分段 LLM。
2. 一般输入中，分段 LLM 只返回行间分界点；行号和任何辅助标记都不进入源正文。
3. 当原文的行间候选分界点少于 `x - 1`，或任一原始行的可见字符数超过 `1.5 * targetBatchSize` 时，程序才启用长行降级，在长行内部的句末标点后增加候选分界点，再让 LLM 从扩展候选中选择。

因此，行是默认的分段寻址方式，但行数不用于替代正文字符量或 token 估算来计算目标段数。应用层只配置 `targetBatchSize`，默认值为 4000 个可见字符，并允许在全局 AI 设置中调整。它是语义分段的目标处理量而非硬上限；不另设 `maxBatchSize`。模型上下文窗口属于所选 LLM/API 的能力校验，不进入产品分段领域模型。

`1.5 * targetBatchSize` 只是决定是否向分段 LLM 暴露句内候选的确定性内部容差，不是处理段校验上限，也不新增用户可配置的批量参数。启用降级后，LLM 仍可基于故事结构选择超过该长度的处理段。

程序在发送请求前为每个允许的候选边界生成稳定 ID：行后边界使用类似 `L0042` 的 ID，长行内句末边界使用类似 `L0042-S0003` 的 ID。分段 LLM 的完整响应只包含 `boundaryIds` 数组，例如：

```json
{ "boundaryIds": ["L0042", "L0087-S0003"] }
```

本地程序要求 ID 来自当前候选集合、按源正文位置严格递增且不重复，再将其映射为内部源文本位置。LLM 不返回正文、字符 offset、自定义行号或候选集合之外的位置。

正文规范化阶段使用统一的最小 JSON 契约：

```json
{
  "statements": [
    { "speaker": "A", "text": "xxx" },
    { "speaker": "B", "text": "xxx" },
    { "speaker": "", "text": "xxx" }
  ]
}
```

它在概念上等价于依次输出 `A:xxx`、`B:xxx`、`:xxx`，但传输层保持 JSON，避免正文自身的冒号或换行造成歧义。`speaker` 与 `text` 都必须是字符串，`text` 必须非空；空 `speaker` 表示旁白，非空 `speaker` 表示角色对白。数组顺序就是原文顺序，响应不能携带时间、duration、gap、source offset 或演出字段。

## Batch Execution

语义分段产生的处理段采用有限并发执行正文规范化，不逐段串行等待，也不无上限地同时请求。并发预算由全局 AI service 的单一共享信号量管理，默认 `maxConcurrentAiRequests = 2`，并允许在全局 AI 设置中调整。所有草稿以及 `segmentation`、`characterExtraction`、`normalization`、`rhythm`、`acting` 和 `cinematic` 阶段共同占用该预算，不能为每个草稿或阶段分别创建一份并发额度。每个处理段携带稳定序号；完成结果必须按原段序拼接，不能按请求返回顺序拼接。

每个规范化请求只携带自己的目标故事段，不传入前一段、后一段或整篇故事总结作为上下文。语义分段 LLM 已通读完整正文，因此它选择分界点时必须优先保持每段的局部语义完整，避免把直接引语与说话人提示、代词与必要指代上下文等强依赖内容拆到边界两侧。规范化阶段不再通过扩大输入修复不合理的分段边界。

单段失败只重试该段，已经成功的结果保留在本次本地 preview session 中。只有全部处理段都成功并通过后处理与时间编排后，整次 AI 铺戏结果才可以原子应用到正式时间线；部分成功不能产生部分 scene mutation。

语义节奏规划同样以故事处理段为请求和检查点单位，不使用一次覆盖完整语句流的节奏请求。它消费的是经过 90 字确定性拆分后的最终语句块；每段节奏结果按原段序合并，只包含段内边界。跨故事段边界不交给 LLM，由非 LLM 编排器统一写入固定 `storySegmentGapSeconds = 0.5s`。

活跃草稿的源正文一旦被修改，当前分段计划、所有逐段规范化结果和节奏结果整体失效。下一次生成从整篇正文重新执行语义分段并重新请求全部处理段，不按文本 hash 复用旧段结果。单段失败重试只适用于源正文未变化时的请求失败。

## Draft Ownership

应用前的源正文、分段计划、主要人物名单、逐段结果、节奏结果和时间预览都属于本地 AI 铺戏草稿会话。草稿会话不得修改 `SceneDocumentV4`、协作共享状态或 runtime projection。

AI 提取的主要人物名单是正文规范化之前的可编辑草稿建议，不是不可覆盖的模型判断。用户可以添加 AI 遗漏的人物、删除误判人物或直接改名；规范化阶段只接收用户确认后的最终名字列表。名单调整在提交前不得修改 scene 或角色管理面板。

主要人物名单是正文规范化的显式前置门槛：用户确认名单后，系统才开始请求各故事段。规范化开始后名单锁定；若用户返回该步骤并修改名单，系统保留源正文、分段候选和已完成的分段计划，但作废全部逐段规范化、90 字拆分、duration、节奏与时间预览结果，并重新请求所有故事段。主要人物名单变化不重新调用分段 LLM 或主要人物提取 LLM。

除主要人物名单和必要的重名角色绑定选择外，所有 AI 与确定性阶段的中间产物在草稿中只读。用户不能在草稿中修改、增删、合并、拆分或换序正文语句，也不能编辑 `speaker`、duration 或 gap。用户可以预览、重试失败任务、重新生成整篇、取消或原子应用；正文与时间修正使用应用后的普通 timeline authoring。

非 AI 绑定器按最终主要人物名字查找现有 `SceneMeta.characters`：恰好一个同名角色时自动复用其 `id`，没有同名角色时自动创建新角色和稳定 ID；存在多个同名角色时不得按数组顺序猜测，草稿必须要求用户明确选择其中一个。重名歧义未解决前不能执行原子应用。

用户确认后，完整结果通过一次 semantic authoring transaction 写入正式时间线。该 transaction 先由非 AI 绑定器根据最新 scene 重新校验保存的 `CharacterBindingPlan` 与“每条目标对白恰好一枚角色表演占位”的不变量，再原子写入所需的 `SceneMeta.characters` 条目与全部正文及增强语句。角色集合或绑定已冲突时，流程回到角色绑定步骤，不静默改绑、不部分应用。名单外临时说话人只写入 statement 的 `speaker`，不创建角色条目。提交成功后，scene source 成为唯一正式事实；草稿不会与已提交时间线保持双向同步。后续修改使用普通 timeline authoring，不能让旧草稿静默覆盖正式 scene。

草稿的时间锚点来源只有 `zero` 与 `playhead` 两种：从 `0s` 开始，或从草稿会话创建时的播放头时间开始。`playhead` 模式在创建草稿时读取一次 CTI 并持久化为固定 `anchorTime`；生成、恢复和应用都不重新采样。`zero` 模式固定保存 `anchorTime = 0`。

应用时不检查生成语句与任何现有 statement 的时间重叠，也不自动 ripple、平移、删除或覆盖已有内容；生成结果按其计算时间直接插入，重叠后的编排由用户在正式时间线中处理。

本 ADR 不决定该草稿会话由侧边面板、独立工作台或其他 UI 形态呈现；UI 形态可以在不改变上述所有权边界的前提下另行设计。

AI 铺戏草稿会话必须本地持久化并支持断点恢复。每个故事段处理完成、主要人物名单发生变化或重名绑定被选择后保存检查点；关闭 UI 或应用重启不能丢失已经成功的 LLM 结果。恢复时只重新处理未完成或失败段，不能重复请求已经成功且输入未变化的段。

草稿根对象从 `schemaVersion: 1` 开始。当前实现已有 schema v2；引入 `CharacterBindingPlan` 与 `AiProseEnhancementStateV1` 时把当前版本提升为 v3。v2→v3 迁移只能添加未初始化的增强状态，不能在没有当前 SceneDocument 的情况下猜测角色绑定或伪造处理结果；旧 active 草稿加载后在进入绑定/增强步骤时正常生成计划。新版应用必须向后兼容所有由正式版本写出的旧草稿 schema，并通过显式、可测试的迁移器把旧结构升级到当前内存模型；不能通过删除旧 reader 迫使用户重新生成。旧版应用不要求读取未来版本草稿。当前应用遇到未知的新版本或损坏文件时必须保留原文件、禁止加载与应用，并报告具体原因，不能猜测性修复后写回。

持久化草稿仍是未提交事实，不进入 scene 文件、协作共享状态或项目服务端。草稿保存在当前项目配置的 `assetRoots.project` 目录下，并按 `sceneId` 与草稿会话 ID 隔离，例如：

```text
<project-root>/<assetRoots.project>/ai-authoring/<sceneId>/<sessionId>.json
```

草稿可以随项目目录一起移动和备份，但不能被 scene asset collector、协作 asset manifest 或视频导出流程收集。

成功提交后，草稿状态从 active 转为只读 `applied` 归档，并记录提交时间和 semantic authoring receipt。归档不自动删除；用户可以查看、复制成新的 active 会话或显式删除，但不能再次提交，也不能覆盖之后已经编辑过的正式时间线。

## Global AI Configuration And Output Capability

LLM 配置属于用户级全局 AI 设置，不属于 AI 铺戏面板、项目、scene 或草稿会话。全局设置统一管理 endpoint、API key、model 和已探测的输出能力；AI 铺戏只通过注入的 AI service 使用当前配置，React 组件不再自行持有凭据或直接拼装 provider 请求。

底层 AI provider 访问迁移到 provider-neutral `AiConversationTransport`，支持多轮 system/user/assistant/tool messages、text/image blocks、tool definitions/calls/results、structured response format、usage、context window 和 cancellation。现有 `AiProseLlmTransport` 保留为该底层 transport 上的简单 system+user/string-response adapter，使正文规范化、表演和电影感处理器不承担项目 Agent 的多轮协议。provider-specific OpenAI-compatible message/tool/image 映射只存在于 Electron main-process adapter。

endpoint、model 和能力状态可以保存在普通用户设置中。API key 必须由 Electron main process 使用平台安全存储加密持有，不能继续明文写入 renderer `localStorage`。renderer 只能读取“已配置/未配置”状态，并发送设置、替换、清除和测试命令，不能取回 key 原值。LLM transport 同样位于全局 AI service/main-process Adapter 后，避免请求时把 key 重新暴露给 React。

全局 AI 设置提供一个 `defaultModel`，并允许为 `segmentation`、`characterExtraction`、`normalization`、`rhythm`、`acting` 和 `cinematic` 六个阶段配置可选 model override。未覆盖的阶段继承 `defaultModel`；能力测试必须验证实际被引用的每个不同 model，而不能只测试默认模型后假设覆盖模型具有相同能力。表演与电影感阶段只要求受本地 schema 校验的结构化 JSON 响应，不要求原生 tool calling。

表演指导与电影感大师是固定输入、单次处理单元输出 patch 的处理器，不向模型注册读取或写入工具，也不执行多轮 tool loop；即使所选 model 支持 tool calling 也继续使用唯一的 `SemanticScenePatchV1` JSON 响应协议。首次 schema 失败后的纠正仍是普通模型请求。原生 tool calling、工具结果消息和自主上下文读取只属于独立项目 Agent。

全局 AI 设置必须提供显式测试入口，至少验证 endpoint 连通性、认证、model 可用性和 JSON Output 支持情况。测试只更新用户级能力状态，不创建草稿或修改项目。

JSON Output 是可选增强，不是第一版硬门槛：

- 所有 provider 请求都在 system/user Prompt 中声明完整输出约束；不能因为启用 JSON Output 就省略 Prompt 契约。
- provider 支持 JSON Output 时启用对应请求能力；若进一步支持严格 JSON Schema，可以使用更强的 schema 模式。
- provider 不支持 JSON Output 时，仍请求纯 JSON 文本，并在本地执行相同 parser、schema validator 和领域校验。
- provider 返回的内容无论使用哪种能力模式，都不能绕过本地校验后直接进入草稿或 scene。

任一 LLM 响应未通过 JSON parse、schema 或领域校验时，AI service 自动进行至多一次纠错请求。纠错 Prompt 包含原任务契约和具体校验错误，并要求只返回完整修正版结果。第二次仍失败时，对应分段规划、主要人物提取、故事段规范化或节奏规划任务进入可重试失败状态；服务不得无限重试，也不得猜测性修补后当作有效结果。

项目内草稿不复制 API key 或完整全局 AI 配置 snapshot，也不让 model identity 参与正文规范化结果的有效性。增强 checkpoint 可以按已定契约保存信息性的 producer model 名称，但仅更换全局 model/config 不作废已经成功并通过当前 gate 的草稿结果；尚未开始或重试的任务直接使用当时的当前全局配置。需要统一重新生成时，由用户显式重新生成整篇或对应增强单元。

## Text Block Capacity

容量拆分和 `targetBatchSize` 使用同一个 `visibleCharacterCount`：按 Unicode 扩展字素簇计数，一个汉字、字母、标点或完整 emoji 各计 `1`；水平空白字符同样计 `1`，因为会占用排版空间；换行、制表符和其他控制字符不计数。计数过程不得 trim 文本或进行 Unicode 归一化。这个显示容量度量不等同于后续 duration 估算使用的朗读字符量。

LLM 不负责满足 90 字显示目标。正文规范化完成后，确定性拆分器对每个角色对白或旁白块执行：

1. 不超过 90 个可见字符时原样保留。
2. 超过目标时，优先在第 90 个可见字符以内最靠后的句末标点后拆分；中文句号 `。` 与英文句号 `.` 都属于句末标点。
3. 目标范围内没有可用句末标点时，依次尝试逗号、分号和冒号等次级标点。
4. 目标范围内完全没有可用标点时，向后找到第一个允许的原文标点再拆分；该子块因此可以超过 90 个可见字符。
5. 拆分点必须位于原文标点之后，不在词句内部硬拆。
6. 每个子块继承父块的角色对白/旁白分类和说话人，字符内容与顺序保持不变。

容量拆分产生的标点边界仍是正常文本节奏边界，可以由语义节奏规划器标注合理停顿；它们不被强制锁定为 `none`。

## Deterministic Timing

语句 duration 始终由文本估算器计算。估算器使用独立、可配置且默认为 9 个朗读字符/秒的 `scriptReadingSpeed`，结合文本有效字数和块内标点停顿等确定性规则；它不能复用打字机逐字显示速度，也不能使用 LLM 提供的 duration。已有或后续生成的 TTS/语音文件时长也不参与编排，语音资源变化不会使既有语句流自动重排。

估算器保留现有短句的基础展示余量与最低时长，但移除 `pace` 乘数和所有 duration 上限。结果按以下公式计算并最终四舍五入到 `0.1s`：

```text
duration = max(
  0.9,
  spokenCharacterCount / scriptReadingSpeed + 0.35 + internalPunctuationPause
)
```

`spokenCharacterCount` 同样按 Unicode 扩展字素簇遍历，但只统计可朗读内容：汉字、字母、数字、emoji 和其他符号各计 `1`；空白、换行、控制字符及所有标点不计数。文本不做 trim 或 Unicode 归一化。标点只通过独立的块内停顿表影响 duration，不能同时作为朗读字符重复计时。

语句块内部的标点停顿计入该块 duration；语句块末尾标点不再额外增加 duration。块末停顿统一由该边界的 `gapSeconds` 表达，避免同一次停顿同时进入 duration 和 gap。

确定性文本估算器使用以下默认块内标点停顿表：

| 标点 | 增加时长 |
| --- | ---: |
| `，`、`,`、`、` | `0.15s` |
| `；`、`;`、`：`、`:` | `0.25s` |
| `。`、`.`、`！`、`？`、`!`、`?` | `0.35s` |
| `……` 或 `…` | `0.45s` |

连续省略号作为一次标点事件计算；引号、括号等闭合符号不单独增加停顿。判断块末标点时忽略其后的闭合引号或括号，整个块末标点事件仍不计入 duration。

`scriptReadingSpeed` 属于用户级普通对白/时间 authoring 设置，与现有 `dialogueTextSpeed` 和 `defaultDialogueDurationSeconds` 位于同一设置领域；它不写入 `ProjectMetadata`，也不属于全局 AI provider 设置。AI provider 设置只管理 LLM endpoint、凭据、model、输出能力和请求分批参数；确定性编排器不能依赖 AI 设置才能工作。

`scriptReadingSpeed` 只影响新生成或在草稿中重新编排的 duration。语句应用到 scene 后，具体 `durationSeconds` 是持久化 source fact；后续修改用户设置不能追溯重排已有 scene。

基线编排为每个相邻语句边界提供 `0.35s` 常规间隔。语义节奏规划可以在 `[0.25, 0.75]` 区间内调整，因此每个有效 `gapSeconds` 必须位于 `[0.25, 0.75]`。第一块从插入锚点开始，后续块满足：

```text
time[n] = time[n - 1] + duration[n - 1] + gapSeconds[n - 1]
```

若一个故事段在 90 字拆分后包含 `N` 个语句块，节奏 LLM 使用以下最小响应，并必须按位置返回恰好 `N - 1` 个正浮点数：

```json
{ "gapSeconds": [0.5, 0.25, 0.7] }
```

数组第 `i` 个值表示第 `i` 块与第 `i + 1` 块之间的停顿。响应不包含语句 ID、文本或故事段间停顿；`N <= 1` 时数组为空。数组长度错误时按响应校验失败纠错一次，仍失败则该故事段全部边界使用 `0.35s`，而不是猜测缺失位置或让正文规范化失败。LLM 不再输出旧的 `pace` 枚举；duration 仍完全由文本估算器决定。

节奏结果中的有限数值在应用前确定性 clamp 到 `[0.25, 0.75]`，例如 `0.1` 归一为 `0.25`、`0.9` 归一为 `0.75`；这种有界归一化不触发纠错请求。缺失值、非数字和非有限数值才视为响应校验失败，先按统一规则纠错一次，仍失败时让对应边界回退到 `0.35s`。

上述 `[0.25, 0.75]` 只适用于故事段内部边界。故事段之间始终使用固定 `storySegmentGapSeconds = 0.5s`，不请求 LLM 判断。

正文规范化的 canonical output 不再混入现有 `AiScriptSegmentPlan.steps` 中的 `enter`、`pause`、`exit` 或 `marker`。超过一万字的正文是正常输入规模，因此规范化调用不依赖单次请求完成整篇。

例如输入：

> 她攥紧杯子。“你迟到了。”

至少规范化为两个有序语句：旁白“她攥紧杯子。”，以及对应角色说出的“你迟到了。”。叙述不能因为无法直接映射为角色台词而被静默丢弃。

带插入叙述的引语同样按原文顺序展开：

> “前半句”，A 说，“后半句。”

规范化为三个有序语句：角色 A 的“前半句”、旁白“A 说”、角色 A 的“后半句。”。

## Consequences

- 第一版不接受需要系统发明对白的梗概或大纲作为有效输入。
- 规范化结果不允许存在“其他文本”或未分类正文；每个输出文本块都是角色对白或旁白。
- 说话人显示名识别与项目角色绑定不能混为一个成功条件；未绑定对白可以进入正式语句流，旁白则始终没有说话人身份。
- 质量验收检查正文是否被正确二分、按原顺序完整保留，而不是评价 AI 创作质量或改写质量。
- 时间与时长属于规范化后的确定性编排阶段，不要求 LLM 直接生成绝对时间值。
- 当前让 LLM 同时输出语句、进退场、停顿、marker 和 pace 的计划类型需要拆分；时间编排和未来演出增强分别消费正文语句流。
- 长正文先经过独立的语义分段规划，再逐段规范化；不能把自然段直接当作技术分批边界。
- 分段阶段的 LLM 输出量只随分界点数量增长，不随正文长度重复增长；实际处理段始终从本地源正文切出。
- 普通格式不承担不必要的句内切分复杂度；只有行级候选明显不足时才启用长行句末候选。
- `targetBatchSize` 是唯一的产品分段容量参数；现代模型的上下文上限不需要在领域模型中复制成第二个批量阈值。
- 有限并发、稳定拼接和单段重试让长正文处理不必线性等待；正式 authoring 仍保持 all-or-nothing。
- 故事段是规范化请求的完整输入边界；不生成有损的故事总结，也不把相邻段重复发送给规范化模型。
- 时间编排对相同文本和相同配置产生相同结果；语音文件存在与否不改变 statement 的开始时间或 duration。
- 当前 AI 估算器的 7 秒 duration 硬上限不能继续承担文本框容量控制；显示容量由语句块拆分解决，duration 按拆分后的实际文本分别计算。
- 90 字目标由可测试的非 LLM 代码尽量满足；无可用标点时允许超过目标，以换取绝不在作者词句内部硬拆。
- 严格串行保证功能下限，独立语义节奏规划保留成片节奏上限；二者不能合并回一个同时生成正文、duration 和演出的宽提示。
