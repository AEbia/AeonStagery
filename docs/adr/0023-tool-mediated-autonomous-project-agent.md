---
status: partially-superseded
superseded_by:
  - ADR-0024
last_reviewed: 2026-08-14
---

# Tool-Mediated Persistent Project Agent Conversation

Partially superseded (2026-08-14, benchmark-gated by ADR0024). 项目 Agent 的写寻址已由 ADR0024 改为 source identity：statement/companion identity 隐藏、行号写寻址、line-map/stale-line-map 行为、写工具 locator schema、模型写回执与诊断定位均以 ADR0024 为准。Conversation 生命周期与持久化、严格 exact-version 并发、authoring gate、provider/transport 与能力探测、上下文压缩，以及表演指导/电影感处理器的 line-based `SemanticScenePatchV1` 契约在本 ADR 继续有效。

ADR0022 负责无损正文规范化与确定性时间编排；后续的项目收尾工作需要一个能够自主选择读取工具、理解正式 scene 与项目资源，并自动完成合法 semantic authoring 的项目 Agent。这个能力与正文规范化是不同的架构边界，因此单独记录。

## Decision

项目 Agent 由用户在持久化 Conversation 中通过自然语言发起一次执行回合。回合启动后，Agent 不等待额外确认，可以把通过校验的 patch 直接提交给 semantic authoring transaction；它不会在 AI 铺戏完成后自动接管。

Conversation 是本机用户级、绑定单一 `{ projectId, sceneEntryId, sceneDocumentId }` 的长期交互记录，同一 scene 可以保存多个 Conversation。Conversation 没有 completed、cancelled 或 blocked 终态，也没有 goal；普通 assistant 文本结束当前执行回合并使 Conversation 再次可输入，后续用户消息继续同一 Conversation。只有用户显式删除才移除 Conversation。

一个执行回合由用户消息、一个或多个完整 assistant messages、宿主执行的 tool calls、按原调用顺序返回的 tool results，以及最终普通 assistant 回复组成。Agent 可以在回合内持续读取、校验、写入、处理冲突并重新规划；不注册 `completeTask`、`reportBlocked`、cancel 或 pause 控制工具，也不要求模型发出终止信号。

除目标 scene 的有界表演能力目录外，宿主只提供当前 Conversation 的用户消息、工具定义和受控权限，不预先注入项目、scene、版本或路径内容。Agent 自主选择读取其他内容。工具层内部绑定工作区、路径 allowlist 和 source version，并通过逻辑工具提供当前 scene、资源目录、相关文件、校验/编译和 semantic transaction 能力。Agent 不读取或操作 AI 铺戏草稿，不能任意写入或删除项目文件、执行 Shell 或读取 API key。

宿主在 Conversation 首次执行、上下文压缩/恢复，以及 scene 角色、绑定模型或 performance profile fingerprint 变化后，直接把目标 scene 全部角色的有界 Agent 能力投影注入模型上下文。该投影从正式 `PerformanceCapabilityCatalogV1` 生成，每个实际可用 motion/expression key 及其可用短描述只出现一次，并保留角色、field-level degrade、lookAt/reaction targets 与简短诊断；重复的 profile provenance 和 intersection 结构留在宿主正式目录中。角色绑定可包含主模型与多个副模型（variants）；投影对主模型与全部副模型的实际 motion/expression 取并集并按值去重，主模型实际持有的 key 才附 profile 短描述，仅存在于副模型的 key 以原始值（不带描述）进入投影——目录既不为副模型编造描述，也不因重复 key 膨胀 prompt。目录由 `PerformanceProfileProvider`、当前角色绑定与实际模型 motions/expressions 求交集生成，不注册额外的 Agent 读取工具；这项固定注入是自主上下文选择的唯一例外。

通用项目文件读取固定为 `readProjectOverview`、`listProjectFiles`、`readProjectText` 和 `searchProjectText`。`readProjectText` 使用显式 `startLine + lineCount`，可接受规范化项目相对路径，或已注册外部库的稳定 `@mount/<id>/...` 引用；列表和搜索结果统一使用非负 `offset + limit` 并只遍历项目目录。未知或超大输出必须携带 `truncated`、`hasMore` 与明确续读参数。所有输入都不能接受绝对路径、`..`、越界 symlink；挂载文本读取只按已注册根目录解析，并应用相同的受保护文件过滤。raw project.json、所有正式 scene 文件、AI 铺戏草稿、Agent Conversation store、版本控制目录、环境文件、凭据和私钥都不能通过通用文件工具读取；目标 scene 只能使用 scene 工具，其他 scene 不进入当前 Conversation 的读取范围。二进制文件只返回元数据。

`readProjectOverview` 返回清理后的项目名称、project version、active scene 名称/相对路径、scene 列表名称/相对路径、asset roots 和模板信息，不返回 projectId/defaultSceneId/scene entry ID、本机根路径或本机 voice preset 绝对路径。注册的外部资源库由资源搜索和检查工具返回稳定的 `@mount/<id>/...` 引用、资源类型和结构化元数据；已知的安全文本引用可再由 `readProjectText` 按行读取，Live2D motion、expression 等能力仍由工具解析。

资源读取固定为 `searchResources` 和 `inspectResource` 两个通用工具，不注册 background、motion、audio 等类型专用工具。`searchResources` 使用 `project`、`mount:<id>` 和 `template:<id>` 三类无冲突 namespace，递归扫描项目资源、已注册 external mounts 与启用模板目录，再按 kind、文本、owner/outfit 和 namespace 过滤，并使用 `offset + limit` 分页。对大型 project/mount 库，调用方可传相对 `pathPrefix` 浏览一个目录的直接子项；目录返回 `kind: "directory"`、所属 namespace 与可继续浏览的 `pathPrefix`，没有可绑定 resource reference，文件才携带项目相对或 `@mount/...` reference。对场景资源选择，空 prefix 先以恒定大小浏览 mount 根，调用方从结果取得 namespace 后再逐层浏览，而不以无范围的递归搜索作为发现前提；因此直接挂载 background 目录仍可按库分类导航。扫描不跟随各注册根目录内的 symlink，不能越过根目录或把本机绝对路径暴露给 Agent；同一规范化查询的首次调用建立扫描 snapshot，后续分页复用该 revision，底层变化时返回 `pagination_changed` 并要求从 offset 0 重查。项目和 mount file candidate 返回可以直接写入 scene 的项目相对或 `@mount/...` reference；模板中尚未采用的 candidate 只返回 `materialization_required` 与语义 metadata，不提供伪 reference；任意外部 path candidate 和本机绝对路径都不进入结果。

`pathPrefix` 与非空 `ownerId` 或 `outfitId` 组合时，在该相对目录下递归搜索文件，再与 namespace、kind、text、owner/outfit 条件取交集；仅传 `pathPrefix`（可带 kind/text）时仍浏览直接子项。递归查询只遍历 prefix 的祖先及其子树，不跟随 symlink，不匹配同名路径前缀的相邻目录。点号开头的内部目录和文件（例如 `.mtn_exp`）不进入 project、mount 或 template 的资源搜索/目录浏览，显式指定内部 prefix 也不返回候选；inspect 不把内部文件报告为可绑定模型。`project` namespace 只包含本项目资源，外部库属于 `mount:<id>`，因此本地资源为空而外部库有资源是正常状态。

所有 list/search 结果按工具声明的稳定键确定性排序，并返回 `hasMore`、`nextOffset`，只有计算便宜时才返回 total。宿主按 execution + tool + 规范化 query 保存最近分页 revision，不要求模型回传 revision；同一查询翻页期间底层 revision 变化时返回 `pagination_changed`，要求从 `offset: 0` 重查，不能静默跳项或重复。分页状态不携带 scene identity、版本授权或写入权限，在执行回合 suspended、settled 或 lease 更换时清除。

`inspectResource` 只接受项目相对或稳定 mount reference，返回存在性、scope、实际 kind、可绑定状态与受控媒体 metadata。Live2D model 额外解析 motions、expressions 和模型能力；`sizeBytes` / `modelDocumentBytes` 是实际模型入口文档字节数，不是整个 bundle 大小，相同内容的 outfit 入口文件可以返回相同大小。motions 保留模型文档声明的全部 key，即使包含多个角色的命名空间，也不按候选 ownerId 删除可用动作。图片只返回尺寸/MIME，视觉内容使用条件注册的 `readImage`；音频可以返回格式、字节数和可安全取得的 duration，但任何时候都不返回音频内容。两个资源工具都不能复制、导入、重命名、删除或物化文件，且 inspect 结果不是写入授权，每次 semantic transaction 的严格资源 gate 都必须重新检查 reference。

若当前 Agent model 的最终能力状态为 `imageInput: supported`，宿主额外注册 `readImage({ reference })`；unsupported 或 unknown 模型的工具列表中不存在该工具。reference 只接受项目相对图片或资源工具返回的稳定 `@mount/...` 引用，禁止绝对路径、网络 URL、越界 symlink 和任意 base64 输入。工具以原生 multimodal image result 返回经过字节、MIME、解码像素和输出尺寸限制的图片，附带原始与送模尺寸元数据；超大图安全缩放，SVG 必须安全栅格化否则拒绝，动态图确定性提供首帧。Agent 不得读取音频内容、视频帧，seek、暂停或捕获当前舞台，避免操作共享的 Stage、playback、Live2D 和 UtSystem。未来若提供 scene frame capture，必须建立独立 renderer、Live2D runtime 和 UtSystem 隔离，并另行记录架构决策。

项目 Agent 只能把已经存在的项目相对引用或稳定 `@mount/<id>/...` 引用写入 semantic scene，不注册资源复制、导入、重命名或删除工具。Agent 的 semantic transaction 不能产生文件系统 side effect，也不能调用会先物化资源再提交 scene 的 authorResource 路径。必须物化后才能使用的 template 资源向 Agent 返回结构化 `materialization_required`，由用户通过现有资源采用流程处理。

项目 Agent 复用全局 provider 与凭据，但通过独立的 `projectAgentModel` 设置选择模型，未配置时继承全局 defaultModel；每次模型请求使用当时的实际设置，Conversation 期间修改 endpoint 或 model 会直接作用于下一次请求，不固定 Conversation 模型，也不因为换模强制压缩或 rebase 既有 provider-neutral messages。新设置继续走正常能力检查、上下文预算和 transport 错误路径；若 native tool calling 不具备运行资格或现有上下文无法被新模型接受，宿主把当前执行回合置为 `suspended: provider_configuration_required` 并释放 lease，Conversation 仍可浏览和接受用户后续输入。表演与电影感 model 的能力结果不能替代项目 Agent 实际所选 model 的能力状态。独立读取工具可以并行，semantic transaction 必须串行。

统一模型能力契约以 endpoint + model 为键保存 `jsonOutput`、`nativeToolCalling`、`imageInput` 与 `contextWindow`。布尔能力使用 `supported | unsupported | unknown` 三态，每项同时记录 `providerMetadata | activeProbe | userConfig | conservativeDefault` 来源；冲突时固定采用 `userConfig > activeProbe > providerMetadata > conservativeDefault`。provider metadata、用户配置或成功的 active probe 都可以直接把 `nativeToolCalling` 与 `imageInput` 声明为 supported，瞬时网络错误、限流和探测中断只能产生 unknown，不能被缓存为 unsupported。当能力来源为 active probe 时，native tool calling 使用无业务副作用的哨兵 tool definition，只有 assistant 返回名称和参数都合法的 provider 原生 tool call 才记为 supported，宿主不执行该哨兵工具；image input 使用宿主内置的微型测试图片，只有请求被接受且响应通过确定性校验才记为 supported。

项目 Agent 只有在所选 model 的 nativeToolCalling 明确 supported 时才能启动；unknown 与 unsupported 都不具备运行资格。`readImage` 也只在 imageInput 明确 supported 时注册。context window 依次采用 provider/model metadata、用户配置与 conservative default `262144` tokens，并在能力结果中保留解析来源。能力缓存随 endpoint、model 或相关用户配置变化而失效，不能拿其他 stage/model 的探测结果替代。

provider 访问通过新的 `AiConversationTransport` seam：请求和响应使用 provider-neutral 多轮 messages、text/image content blocks、原生 tool definitions/calls/results、usage、context window 与取消信号。Electron main process 继续独占 API key、endpoint 和 provider-specific OpenAI-compatible 映射；renderer 只交换规范化 conversation payload。项目 Agent 的 tool loop、Conversation store、scene snapshot、authoring gate 与调度策略留在业务 service，不进入 transport 或 main-process provider adapter。现有 AiProseLlmTransport 作为该 seam 上的简单 adapter 保留，避免让项目 Agent 协议污染 AI 铺戏接口。

规范化消息使用 discriminated union。system/user message 携带 `content: AiContentBlock[]`；assistant message 携带完整 content blocks 与原生 `toolCalls: AiToolCall[]`；tool message 使用 `toolCallId + name` 关联调用并携带 content blocks。`AiContentBlock` 固定包含 `{ type: "text", text }`、`{ type: "json", value: JsonValue }` 与 `{ type: "image", mimeType, bytes: Uint8Array, detail: "auto" | "low" | "high" }`。tool arguments 必须是经过 JSON 解析但尚未执行的结构化值，tool JSON result 也保持结构化，不能先序列化为要求模型再次解析的说明性文本。

`AiToolCall` 本身使用 ready/invalid discriminated union。ready call 必须携带本轮唯一 `toolCallId`、非空 name 与已解析的 JsonObject arguments；invalid call 携带规范化 toolCallId、可呈现 name 和结构化 parse/protocol error。adapter 对缺失或重复的 provider call id 生成当前 assistant 轮次内唯一的规范化 id，并在后续历史重映射中保持一致；arguments 不是合法 JSON object、name 为空等单调用问题产生 invalid call。invalid call 永不分发执行，但仍返回关联的 `invalid_arguments` tool result，使 Agent 可以在下一轮纠正；同一 assistant 响应中的其他 ready calls 继续按既定读写屏障执行。

单个 invalid call 不触发整轮 provider 重试。只有连续三个模型轮的全部 tool calls 都无效，并且归一化错误签名相同时，宿主才暂停当前执行回合为 `suspended: repeated_invalid_tool_calls` 并记录用户可见活动；任一轮存在至少一个 ready call 都清零该连续计数。Conversation 不因此终结，用户可以补充说明、更换模型或重新发起执行。

只有整个 assistant envelope 无法安全规范化时才拒绝整轮，且该轮任何工具都不执行。宿主只向模型发送结构化协议错误后重新请求，不保存 provider raw response。相同归一化 envelope 错误连续出现三次时，宿主暂停当前执行回合为 `suspended: provider_protocol_incompatible`；任一次成功规范化都会清零连续计数。该计数由宿主保存在模型上下文之外的 Agent 执行状态中，不依赖对话型上下文摘要。renderer 永远不接收 provider raw arguments、原始增量片段或私有响应字段。

image block 跨 renderer/main IPC 只传经过字节、MIME 与解码上限检查的 bytes、MIME 和 detail，不传项目/本机路径、资源 reference 或任意 data URL。`readImage` 返回关联原 tool call 的 multimodal tool result；main-process provider adapter 负责把统一 tool result 映射为实际 provider 支持的合法消息序列。provider raw response、私有字段和流式增量 tool-call arguments 不进入 renderer，业务层只接收规范化完整消息。

provider 原生允许 multimodal tool result 时，adapter 直接映射统一消息。对于允许 user image input、但拒绝在 `role: "tool"` 中放图片的 OpenAI-compatible Chat API，adapter 必须先按原 call 顺序发送该 assistant 轮次的全部文本/JSON tool results，使每个 tool call 在协议上闭合，再追加一条宿主生成的 multimodal user projection；projection 按原调用顺序包含 toolCallId/name 关联标签与对应图片。它只属于 provider transport 投影，不是 Agent 用户消息，不进入用户可见对话日志，也不参与排队用户消息的冲突处理；后续请求从原始 multimodal tool results 确定性重建。由此 `imageInput` 明确 supported 即足以注册 `readImage`，不额外引入 `multimodalToolResult` capability。

`readImage` 的图片 bytes 与文字/JSON content block 使用相同的单份消息持久化规则：只要所属 message 仍在当前 Agent 模型上下文中，经过既有字节和解码限制的 bytes 就随该 message 保存一次；每轮请求只引用并重新组装消息，不复制 bytes。上下文压缩原子替换旧 messages 后删除不再属于当前模型上下文的图片 bytes。Conversation 恢复时直接恢复当前完整 messages，不自动重读资源；资源后来不存在或内容变化时，Agent 必须通过工具重新取得当前事实。

恢复后若资源不存在或内容指纹变化，只向 Agent 报告当前状态，不能把旧视觉观察当作当前资源事实。正常 80% 上下文压缩可以让摘要模型消费当前模型上下文中的图片并提取文字化关键发现；摘要替换提交成功后删除旧图片 payload。

Project Agent 的模型请求可以请求 SSE 流式响应。main-process provider adapter 独占 SSE 读取与聚合，只有在完整 assistant message 可规范化后，业务层才校验 tool calls、把该 message 单份写入 Conversation store 并开始工具调度。renderer/main IPC 只传按 requestId 隔离的无内容进度事实：连接已建立、首次模型输出以及当前工具类别/名称；renderer 永远不接收 CoT、正文 delta、provider raw response 或未完成的 tool arguments，也不在 renderer 拼接 provider-specific 参数。首次收到 reasoning、正文或 tool-call delta 才开始“正在工作”计时；请求 stream 但 provider 回退为完整非流式响应时保持“正在连接”，不伪造工作时间。模型完整消息进入工具阶段或该轮结束时立即移除计时。工具开始时显示读取、校验或写入状态；完成后才以真实 tool call/result 投影出可展开、脱敏且限长的持久化活动事实。

`reasoningContent` 是 provider continuation 所需的不可见模型状态：它随完整 assistant message 单份保存在 Conversation store/journal，并在后续 provider 请求中回传。它不属于 Agent UI、活动日志或 DevTools 调试镜像；所有这些展示路径必须递归脱敏 `reasoning`、`reasoning_content` 和 `reasoningContent`。`AiConversationTransport` 可以继续为既有 AI 铺戏保留自己的 streaming 语义，但 Project Agent 业务层始终只接收规范化完整消息。

单个模型轮遇到网络中断、限流、超时或 provider 5xx 时总计最多尝试三次，并遵守 `Retry-After`、使用退避。完整 assistant envelope 到达前不会调度任何工具，因此这些 transport 重试没有 authoring side effect，也不能重复执行上一轮已经完成的工具。连续三次 transient provider failure 后，宿主把当前执行回合暂停为 `suspended: provider_unavailable`、保留 Conversation store，并释放全局执行槽；Conversation 不进入终态，用户可以稍后继续。

无效 API key、模型不存在或 endpoint 配置错误等确定性 provider 配置问题不消耗 transport 重试次数。宿主立即把当前执行回合暂停为 `suspended: provider_configuration_required` 并保留 Conversation store；用户修复设置后，宿主必须针对实际选择的 endpoint + model 重新执行能力检查，只有 nativeToolCalling 再次明确 supported 时才能继续。该暂停不能删除既有模型上下文或对话日志。

renderer 侧 `AiConversationTransport.complete(request, { signal })` 接收标准 AbortSignal；Electron adapter 为请求生成宿主 requestId，并在 signal abort 时调用 `conversation.cancel(requestId)`。main process 以 `{ senderFrame, requestId }` 为 ownership key 保存请求专属 AbortController，并把 signal 传给 provider fetch；cancel 只能作用于同一 sender 创建的请求，幂等返回 `cancelling | alreadySettled | notFound`。requestId 是 transport 内部 identity，不能写入模型消息、Agent 工具参数或 tool result。

用户取消当前执行回合时 renderer 先进入 cancelling，等待可取消调用 settle；Conversation 不进入 cancelled 终态，而是在安全停点后恢复为可输入。若 assistant 完整响应已经到达，模型请求不再可追溯取消：尚未启动的工具组不执行，已经开始的读取允许结束或丢弃结果，正在提交的 semantic transaction 仍原子完成。renderer frame/window 销毁时 main 自动 abort 该 sender 的所有未完成 provider 请求，并按恢复规则把当前执行回合标记为 suspended。

同一 assistant 响应包含多个 tool calls 时，宿主按原始 call 顺序把它们切成连续只读组与写入屏障。连续 reads 在组开始时共享 snapshot 并行执行；每个 write 必须等待之前的读取组和写入完成，并严格串行；写入之后的读取看到该 write 实际成功或失败后的状态。所有结果最终按原 call 顺序组成 tool result messages。每个调用独立进行 schema 校验，单个失败不取消其他调用；前序结构写入导致后续 locator 失效时返回 `stale_line_map`，不隐式合并或回滚。取消后不再启动尚未执行的组或调用，正在提交的 transaction 仍原子完成。

项目 Agent 的模型请求不占用 AI 铺戏使用的全局 `maxConcurrentAiRequests` 信号量，而使用独立的单通道请求队列。由于应用全局只允许一个 Agent 执行回合占用执行槽，任一时刻最多只有一个项目 Agent 模型请求；下一次模型请求必须等待当前模型请求及其工具阶段结束。provider 的总并发峰值因此可以达到 `maxConcurrentAiRequests + 1`。

项目 Agent 只接受 provider 原生的结构化 tool call。模型返回的工具名和 JSON 参数必须先通过宿主工具注册表与参数 schema 校验，再由宿主分发；执行结果作为标准 tool result 消息进入下一次模型请求。普通 assistant 文本和用户消息都不能被解析、猜测或提升为工具命令。没有 tool call 的普通 assistant 文本是合法回复并结束当前执行回合。nativeToolCalling 未明确 supported 的 model 不具备执行资格，开始/继续前检查直接返回结构化能力错误且不取得执行槽；Conversation 仍然存在，用户可以在更换 model/config 并重新取得 supported 结果后重试。

所有读取和写入工具统一返回版本化 `AgentToolResult<T>` envelope。成功结果使用 `ok: true` 与 typed data，并在需要时提供 `truncated`、`hasMore`、`nextStartLine` 或 `nextOffset`；可预期失败使用 `ok: false` 与结构化 `code`、`message`、`retryable`、可选 `suggestedAction` 和 diagnostics，不能让模型解析异常文本。suggestedAction 只表达 `reread_scene` 等机械恢复动作，不替 Agent 解决任务冲突。

项目 Agent 不注册 `completeTask`、`reportBlocked`、`cancelTask` 或 `pauseTask`。普通 assistant 文本可以说明已完成、无需修改、需要用户选择或当前无法继续，但这些语义不成为 Conversation lifecycle；回复只结束当前执行回合。宿主不解析 assistant 文本来推断完成或阻塞，也不存在 `terminal_signal_required` 或 repeated-missing-terminal-signal 协议。

如果读取结果已经证明当前请求无需修改，Agent 直接返回普通 assistant 文本，不需要用空 transaction 制造 receipt。零写入回复不运行整份 scene 的 strict authoring gate，与本次请求无关的既有 error 不阻止 Agent 说明 no changes。发生过写入时，最后一笔 transaction receipt 必须先作为 tool result 返回模型，后续普通 assistant 回复才能基于真实提交结果叙述；可信变更计数与 warnings 仍只来自 receipt，并被宿主投影为用户可见活动。

写入成功 data 必须包含 committed status、数字 DocumentStore version、无内部 UUID 的 inserted/updated/deleted/moved 计数、semantic warnings 和 line-map 状态。行号保持变更后宿主自动把当前执行回合的 base snapshot 推进到已提交版本并保持适用行号；行号失效变更返回 `validThroughLine` 与 `refreshRequired`，旧行号只在该界限之前继续可用。固定错误码至少覆盖 `scene_not_read`、`stale_line_map`、`pagination_changed`、`invalid_arguments`、`wrong_line_kind`、`conflicting_operations`、schema/semantic/compiler/resource failures、`materialization_required`、`version_conflict`、`forbidden_path`、`result_too_large` 和 `vision_unavailable`。tool result 不返回内部 UUID、stack trace、绝对路径或完整 candidate scene。

项目 Agent 写工具注册表固定包含 `insertStatement`、`insertCompanion`、`updateStatement`、`updateCompanion`、`deleteLine`、`moveLine`、`reorderCompanions` 和 `applyAuthoringTransaction`。前七个工具一次只接受并提交对应的一个 `SemanticSceneOperationV1`，各自产生独立原子 transaction 与 receipt；最后一个工具显式接受版本化 operations 数组，提供跨 operation 全有或全无语义。八个参数 schema 都从同一 operation 权威定义生成，不维护重复 schema，也不注册额外 `applySceneOperation`、family-specific 或 bulk convenience 写工具。模型在尚未成功读取 scene 时只看到只读工具定义；任一成功 scene read 绑定 snapshot 后才看到完整写工具表。共享的读取绑定、原子性和 transaction 规则写入 system prompt，但每个工具描述仍保留其专有的目标、定位、父子关系、替换和失败语义。

正式 scene 读取注册为 `readScene`、`searchScene` 和 `validateScene` 三个工具。`readScene` 按显式 `startLine + lineCount` 返回 active formal scene 的扁平全局行视图、只读 scene meta、角色目录、总行数和数字 DocumentStore version，并附带 `hasMore`、`nextStartLine` 与 `truncated`；默认和最大页宽均为 500 行，单页 UTF-8 序列化内容还受 200 KB 安全上限约束。到达字节上限时返回可续读页；单个首行本身超限时返回 `result_too_large`，且不建立可写 snapshot 绑定。`searchScene` 按文本、family 或时间范围过滤，以 `offset + limit` 返回按 scene time、source order 与 line 稳定排序的命中行及有限相邻语境；`validateScene` 返回 source schema、semantic、compiler 和严格资源检查 diagnostics，并尽可能映射为 Agent line。三者都不读取 AI 铺戏草稿。

同一模型轮并行发起的 scene reads 必须共享一个宿主 snapshot。每次成功 scene read 都把 base snapshot 与完整行映射保存在模型上下文之外的 Agent 执行状态中；模型无需在写工具参数里重复提交 version，写入默认绑定最近一次成功读取。尚未建立 scene snapshot 时所有写工具返回 `scene_not_read`。一旦已经读取，只要行映射仍适用就不要求机械重读；写入时只接受与 base snapshot 完全相同的 DocumentStore version，并发人类编辑导致 `version_conflict` 后由 Agent 重新读取和规划，不做字段级三方合并。连续内容一律使用行范围续读；列表和搜索只使用 offset 分页，分页位置不作为 scene identity、snapshot 或 version token。

项目 Agent 的写入工具与 ADR0022 的表演、电影感处理器复用中立的版本化 `SemanticScenePatchV1` 和七种固定的 `SemanticSceneOperationV1` operation algebra，但不共享调用方式或授权语义。公共操作只包含 insert/update statement、insert/update companion、delete/move line 和 reorder companions；family payload 与 patch schema 从 `SceneStatementDefinitionRegistry` 生成，阶段差异由数据化 policy 收窄。项目 Agent 通过原生 tool call 构造操作并可自动提交；两个增强处理器只返回受阶段 schema 限制的 patch。新增 statement family 不扩展工具面，也不能产生 family-specific Agent command。

项目 Agent V1 的写权限覆盖全部 statement families 与 dialogue companions，因此“任意合法剧本更改”表示不对 statement family 设业务白名单。marker、scene meta 和 character directory 可以通过读取工具进入 Conversation 语境，但不能由 V1 Agent 修改，也不能塞入 `SemanticScenePatchV1`。这些域未来需要写入时应使用各自专用 authoring facade，并另行定义与 statement transaction 的原子边界。

Agent-facing `insertStatement` 必须提供显式非负有限时间和完整 statement draft。可选 `beforeLine` 仅能引用同时间 root statement，省略时排在该时间点现有 statements 之后；不同时间 locator、companion line 和 `afterLine` 都不合法。新 dialogue 若需要 companions，必须在 statement draft 中一次完整声明，因为显式 transaction 不会为新对象提供临时行号。

Agent-facing `insertCompanion` 提供 dialogue `parentLine`、可选的同 parent `beforeLine` 和完整 companion draft。宿主可以用现有 insert 与 reorder intents 在该 operation 内原子实现指定位置，但生成的内部 companion ID 不进入 Agent 结果，也不能在同一显式 transaction 中被后续 operation 寻址。

Agent-facing update 使用 registry 派生的递归 JSON Merge Patch，而不是把 `params` 当作一个整体替换字段。对象叶字段递归更新，数组保持原子，`null` 只删除可选字段。statement update 排除 ID、time 和 companions，companion update 排除 ID 与 parent；family replacement 必须一次提供不同 type 与完整 params。任何依赖 replacement 中间结果的操作都必须推迟到重新读取后的模型轮次。

`deleteLine` 根据行类型删除 root 或 companion，删除 root 会级联其 companions。`moveLine` 使用绝对时间，移动 root 不重排 source order；同一 transaction 的 parent/companion moves 按最终 parent time 统一求值而不依赖数组顺序。`reorderCompanions` 必须列出初始 snapshot 中同一 parent 的全部 companion lines，且不能与该 parent 的 companion insert/delete 混用。move 属于行号保持变更，delete 与 reorder 属于行号失效变更。

每个写入 tool call 都是独立的 semantic authoring transaction，多个写入调用严格串行并分别返回成功、失败和 receipt；宿主不得把同一模型响应中的调用隐式合并。一个调用失败不回滚此前成功的调用，也不自动阻止其他仍可安全寻址的调用。行号保持变更后，仍有效的 Agent 行号可以供后续调用继续使用；行号失效变更使受影响映射失效后，引用这些行号的后续调用返回结构化 `stale_line_map`，不得猜测目标。真正要求全部成功或全部失败的修改必须由 Agent 显式调用 `applyAuthoringTransaction(operations)`。

为保持与共享 `SemanticScenePatchV1` 契约一致，`applyAuthoringTransaction` 接受空 operations，并返回 `ok: true, status: "no_change"`。空事务只校验 envelope version，不进入 mutation queue、不执行 authoring gate、不创建 history entry 或 transaction receipt，也不改变 DocumentStore version。七个单 operation 写工具仍拒绝空 patch 或无意义参数；Agent 通常应在无需修改时直接结束，而不是把空事务当作心跳。

显式 `applyAuthoringTransaction` 中的所有 line 与 parentLine 都针对事务开始时的同一 Agent 行视图解析。宿主必须先把全部行号解析成内部 locator，再执行任何 operation；数组内的增删或重排不改变后续 operation 的行号含义。不提供事务内临时行号或别名，新建 statement 若需要 companions，必须在插入 draft 中完整描述。依赖前一项运行结果的操作必须拆到下一轮工具调用。任一 locator、operation 或最终校验失败时，整个显式事务不提交。

显式事务允许合并同一 statement 的不同字段 patch，但不得依赖 operation 数组顺序解决语义冲突。同一字段被多次修改、同一目标同时 update 与 delete、删除 statement 后又修改其 companion 或移动它，以及 type replacement 与旧 type 字段 patch 并存时，工具都返回结构化 `conflicting_operations`。type replacement 必须独立提供完整的新 type 与 params。任何 operation 冲突都是硬错误，整个显式事务不提交，由 Agent 重新规划。

单次 Agent 执行回合不设置固定的 tool-call loop 上限，也不设置累计 token、费用或模型请求预算，可以跨多次上下文压缩继续运行。每次 `AiConversationRequest` 都完整携带当前 Agent 模型上下文；持久层不保存每轮 request 的 messages 快照，而是让每条规范化 message/content block 只保存一次，再按当前有序 message 引用组装请求。

宿主在下一次请求预计达到模型 context window 的 80% 时触发压缩，摘要语义完全由当前 `projectAgentModel` 生成。预计占用包含 system message（含 Agent 能力投影）、当前全部 messages、assistant `reasoningContent`、排队用户消息、当前可见的完整工具 schema、multimodal 图片 token 成本和预留输出预算；不能等待 provider context overflow。实际 provider usage 用于校准该估算并记录不含内容的估算/实际差异，不能改变 80% 阈值或形成累计 token 预算。context window 优先使用 provider/model metadata，其次用户配置，均不可得时采用保守默认 `262144` tokens；换模后当前上下文无法被新模型接受时，执行回合暂停为 `provider_configuration_required`，不能让宿主私自删减或改写语义。

压缩请求使用当前完整 Agent 模型上下文、不注册工具，并要求版本化 `AgentConversationSummaryV1`：

```ts
interface AgentConversationSummaryV1 {
  version: 1;
  objective: string;
  importantDetails: string[];
  workState: {
    completed: string[];
    active: string[];
    nextMove: string[];
  };
  relevantFiles: string[];
}
```

这些字段对应 `Objective`、`Important Details`、`Work State / Completed / Active / Next Move` 与 `Relevant Files`。`objective` 是摘要中的当前对话方向，不是持久 goal identity，也不产生完成或终态。摘要不得复制正式 scene 全文、Agent 行号、内部 UUID、完整 receipts 或完整工具日志；模型需要当前内容时必须重新调用读取工具。

摘要 schema 失败时可以使用当前模型纠正一次；再次失败、网络失败或压缩请求无法安全容纳时，宿主不得生成 deterministic 语义摘要，而是把执行回合暂停为 `suspended: context_compaction_required`，保留原模型上下文并释放执行槽。用户更换模型或重试后可以继续同一 Conversation。

压缩只能发生在当前 assistant tool-call 轮全部完成、全部 tool results 已单份持久化之后、下一次模型请求之前。摘要成功后，宿主原子写入 summary message、更新当前 message 引用集合，并删除被摘要替换的旧 messages 与其中的图片 bytes；已从真实 tool results 投影到 Agent 对话日志的简短活动记录继续保留。压缩不回滚已提交的 semantic transaction，也不重置执行回合的版本冲突计数等正确性状态。

所有可能返回大量内容的读取和搜索工具必须限制单次结果并支持续读：连续内容返回 `nextStartLine`，列表和搜索返回 `nextOffset`，同时携带 hasMore 与截断说明，由 Agent 显式决定是否继续读取。二进制资源只按受控 image content block 或元数据进入当前模型上下文。semantic transaction receipt 的关键字段不得截断。每次工具调用结束后，宿主重新预测下一次请求占用；单个结果超过安全容量时返回结构化 `result_too_large`，不得把超大结果强行加入上下文。

Conversation 本身没有 lifecycle enum；只要未被用户删除就始终可浏览并可接受用户消息。`running` 与 `suspended` 只描述当前可选执行回合。普通 assistant 回复、用户取消或 Agent 说明无法继续都会结束当前执行回合并使 Conversation 回到可输入状态；provider、协议、上下文压缩或 scene 暂不可用可以保留 suspended checkpoint，但不能产生 Conversation 终态。

用户取消当前执行回合后，宿主停止安排新的模型请求和工具组。正在执行的模型请求或只读工具如果支持取消则主动终止；无法终止时，其迟到结果不得重新推动执行。乐观预检和 mutation queue 等待阶段仍可取消；只有 durable pending 已成功写入且权威 semantic transaction commit 已开始后，该 transaction 才必须原子 settle，保存 receipt，并投影真实的用户可见活动。已提交变更不回滚，Conversation 随后恢复可输入。

用户在模型或工具执行期间发送的新消息按发送顺序原文排队，不合并、不摘要、不解释冲突。当前 assistant response 已发出的全部 tool calls 必须按既定读写屏障完整执行并记录 tool results，排队消息严格在这些结果之后作为独立 user messages 加入下一次 `AiConversationRequest`；用户输入不能插入已经打开的 tool-call 协议，也不能使当前调用被丢弃。取消是宿主控制信号，不进入用户消息队列。

Agent 对话日志与当前模型上下文使用同一 Conversation store，但不是同一投影。规范化 user/assistant messages、tool calls/results 和图片 content blocks 各保存一次；UI 直接显示仍保留的 user/assistant 文本，并持久保存宿主从真实 tool result 确定性生成的简短活动，例如“读取 scene”“已提交 2 处修改”。活动不重新加入 `AiConversationRequest.messages`，也不是 receipt 副本。完整 tool result 被压缩删除后，活动仍保留；正式变更的长期审计继续由 scene history/undo 与项目文件承担。线程窗口把每个 tool anchor 与对应活动按共享 `toolCallId` 绑定，而不是按追加序号配对：没有对应 tool message 的宿主活动——上下文压缩与 scene gate 终态失败——独立成行渲染，不会把后续真实工具行错标成“上下文已压缩”或把真实活动挤进尾部；严格对齐的旧记录（活动无 id）仍按追加顺序回退配对。活动日志的读取计数只统计成功的相关读取；full-access 下 `runTerminalCommand` 的成功单独计数为 `successfulTerminalCommandCount`，绝不进入「成功读取 N」，但在 full-access 语义下仍满足零写入回合的“已检查项目”前提。

Conversation store 以稳定 `conversationId` 寻址，并绑定 `{ projectId, sceneEntryId, sceneDocumentId }`；scene 名称和路径只用于展示，不构成身份。Conversation 不跨项目或 scene；同一 scene 可以创建、保存并随时恢复多个 Conversation。列表为每个 Conversation 保存自动标题、最后活动时间与可选用户重命名，不提供 archive。Conversation 只在用户显式删除时清除；删除移除模型 messages、活动、执行 checkpoint 与未提交恢复数据，不回滚已经提交的 scene 变更。

Conversation store 位于应用本地数据目录，不写入项目目录或协作状态，不跨机器迁移。项目路径移动不影响恢复。在协作场景中，Conversation 只属于发起者；只有已提交到正式 scene 的 semantic 变更按现有协作机制共享。应用或项目关闭后只恢复 Conversation、当前完整模型上下文与 suspended checkpoint，不自动调用模型或工具；用户重新打开并发送消息或显式继续后才可以申请执行槽。

Conversation store 记录 `storeVersion`、`agentProtocolVersion`、`toolsetVersion` 和 statement registry/policy fingerprint。恢复时若执行契约变化，宿主先迁移 store 与 pending，再用当前 system prompt、工具定义和 policy 触发模型压缩，不能把旧 provider-specific 投影直接继续使用。迁移或压缩无法完成时保留 Conversation 并暂停执行；不得把 Conversation 标记为 blocked 或删除。

Conversation 固定绑定目标 scene。恢复和每次 scene 读取/写入前，应用必须通过正常 scene activation seam 核对 `sceneEntryId + sceneDocumentId`；不一致或暂时加载失败时暂停执行并等待重新激活。宿主确认目标 scene 已删除或不再属于该 project 时，记录 `target_scene_unavailable` 活动并停止工具执行，但 Conversation 仍可浏览、删除或在未来由显式迁移功能处理；同名或同路径的新 scene 不能静默继承 Conversation。

Conversation store 同时承担 semantic transaction 的崩溃恢复记录。正式 commit 前必须原子保存 pending operation、基础 source version 和预期变更指纹；pending 写入失败时不得 commit。commit settle 后，receipt 作为对应 tool result 的唯一完整持久副本写入当前模型 messages，用户活动只保存展示所需的最小事实，不复制 receipt。上下文压缩删除旧 tool result 后，长期审计交给 scene history/undo。

若进程崩溃或生命周期中断使 assistant tool-call 轮没有完整 tool results，宿主不得重放未完成 call、旧 patch 或未知 pending，也不得伪造闭合 tool result。恢复时丢弃未闭合的 assistant/tool 轮，保留已经确认提交的变更活动，把未知 pending 清除为不可重放状态，并在下一次用户输入触发的模型请求中注入一次结构化 `turn_aborted` recovery message，说明已确认提交、未知结果和需要重新读取的范围。未完成调用的潜在副作用不能由宿主根据当前 scene 猜测归因。

应用全局同一时刻只有一个 Agent 执行回合可以占用执行槽，不按 projectId 或 scene 分配并行槽。任意多个 Conversation 可以持久存在，idle/suspended Conversation 不占用执行槽；开始或继续任一 Conversation 的执行回合都必须重新取得唯一 lease。当前执行回合内部仍可并行调用彼此独立的读取工具，所有 Agent 写入保持串行；人类编辑不受 Agent 执行槽阻塞。

执行采用 editor renderer、Agent window 与 main process 三层。持有 DocumentStore 的原编辑 renderer application layer 运行 `ProjectAgentService`，负责模型轮次编排、tool loop、scene snapshot 与行映射、读取调度、authoring gate 和 semantic transaction；独立 Agent window 负责 Conversation 列表、对话与活动展示、状态和用户输入。Electron main process coordinator 负责应用级唯一 execution lease、本机 Conversation store 原子持久化、model request/cancellation 和 renderer reload 后的恢复协调；main 不执行 scene mutation，也不维护 DocumentStore 副本。

editor renderer 开始或继续执行回合前必须通过 IPC 获取 lease，因此多个窗口、renderer reload 或 UI 绕过都不能创建第二个 running execution。内部 conversationId、executionId 与 lease token 只存在于 IPC/store，不进入模型上下文。Agent window 最小化时执行继续；正常关闭时停止新调度并等待当前本地 tool/transaction 到安全停点后保存 suspended checkpoint 和释放 lease。应用崩溃无法到达安全停点时使用 `turn_aborted` 规则。

Agent-facing scene 使用扁平 JSON 行视图：root statement 与 dialogue companion 都有连续的 line，companion 用 parentLine 表示归属。Agent 永远看不到或提交 scene/statement/companion/conversation/execution/transaction/correlation 的内部 UUID identity；工具内部把行号解析为 UUID locator。角色号、speakerId/target、layerId、recipeId、instanceId、graphic/lighting object id、motion/expression key 和资源引用等领域语义键继续在 params 中呈现。隐藏规则由 registry/schema 按字段声明，不能按字段名包含 `id` 或值看似 UUID 进行全局脱敏。参数、文本与 `moveLine` 是行号保持变更；增删、reorder、父子关系变化，以及删除不兼容 companion 的 family replacement 是行号失效变更，只在受影响位置及其后重新编号。

Agent facade 提供通用的 updateStatement(line, patch)，避免为每个 statement family 维护独立工具。prompt 负责当前用户请求的软规则，例如默认只做表演润色、用户未明确要求时不改文案；工具负责硬规则。statement/companion UUID 由工具管理，params 中领域语义键仍由 Agent 正常 author；companion 的增删、更新和重排继续使用现有 companion intents。已有 statement 的 type 变更必须携带完整新 type + params，作为原子 family replacement 处理，不保留不兼容 companions。

任何变更必须通过 source schema、semantic validation、compiler 和资源引用检查；semantic validation warning 可以保留，error 不得提交。工具契约错误只返回结构化错误，不自动猜测或修补 patch。人类与 Agent 修改不同字段时可以合并，同一字段冲突时 transaction 失败，不阻塞或回滚人类编辑；Agent 必须重新读取、重新规划后重试，版本冲突最多自动重试三次。

每个 Agent 写入工具都必须在正式提交前对内存候选 scene 自动执行不可跳过的 authoring gate：应用 operation、source schema 校验、完整 semantic validation、compiler，以及严格资源引用检查。semantic validation warning 收集进 receipt 但允许提交；任一 error 阻止提交。严格资源检查不得沿用 RuntimeAssetPreparer 的宽松降级行为，资源不存在、越出允许范围或无法解析都属于 error。只有 gate 全部通过后，工具才能调用正式 semantic authoring transaction；prompt 和 Agent 都无权关闭该 gate。

authoring gate 对最终完整 candidate 采用绝对严格语义，不区分 error 是 Agent 新增还是 scene 原本已有。工具把既有 semantic 或资源 error 映射到 Agent 行号返回；Agent 可以先通过合法 transaction 修复，再继续当前用户请求。如果修复会违反用户明确限制，例如本轮只允许修改背景，则不能把旧 error 降级放行；Agent 用普通 assistant 文本说明限制并结束当前执行回合，Conversation 仍可继续。semantic warning 仍可保留。

Agent 写入采用乐观预检与权威提交两阶段。工具先在 semantic mutation queue 外基于 Agent 的 base snapshot 执行完整预检；正式提交进入现有 mutation queue 后读取最新 DocumentStore version。只有该 version 与 base snapshot 精确相等时才重新执行权威 authoring gate 并在同一串行操作中立即提交；任何 version 变化都返回 `version_conflict`，不做字段级三方合并，由 Agent 重新读取、重新规划后重试。旧 snapshot 的预检结果不能授权向新版本提交。UI 不获取 Agent 编辑锁，人类 authoring transaction 继续进入同一 mutation queue 串行落地。

## Relationship To ADR0022

AI prose normalization 仍然只负责无损产生角色对白/旁白语句、确定性 duration/gap 和独立可用的角色表演占位 companion，不读取草稿之外的项目 Agent 工作上下文，也不由项目 Agent 自动接管。用户可以在不启用任何增强处理器时应用占位并手动填写表演。旧 `agentPrompts.ts` 中表达的表演指导与电影感职责保留为 AI 铺戏中的顺序处理步骤，并可对当前 active scene 单独运行，但实现迁移为 semantic scene 的 typed 结果或 patch，不保留旧文件/API 契约，也不再输出 action/timeline JSON。项目 Agent 是独立工作流，不调用、不编排也不接管这两个处理器。

专用表演资料属于启用模板域的只读项目上下文：由模板 manifest/profile 文件声明和加载，按既有模板优先级解析，并通过 `PerformanceProfileProvider` 与实际 Live2D 能力共同形成过滤后的表演能力目录。profile 中的 motion 仍是当前模型的本地动作键，例如 `char-b/angry01`；模板 namespace 只标识资料来源，不成为 scene motion 的外部资源引用。项目 Agent 与表演指导可以消费同一解析结果，但表演指导消费正式 `PerformanceCapabilityCatalogV1`，Agent 只消费其能力保持的紧凑投影，不能修改模板 profile、调用表演指导处理器，或因 profile 存在而跳过 source schema、资源引用和 semantic authoring gate。

该 profile 只能作为声明式能力目录被读取：角色身份、alias、模型动作/表情键和短描述属于数据；system prompt、可执行规则、强制覆盖策略和固定动作覆盖率不属于 profile，也不能被 Agent 当作工具授权。

Agent 看到的 profile motion 描述必须以当前模型实际能力为边界：参考模型缺失的 key 只产生 `profile_motion_unavailable` warning，当前模型额外存在的 key 可以作为无描述通用能力；模型读取/解析失败仍阻止写入。profile 命中角色名不能授权 Agent 提交当前模型不存在的动作键。

profile 不给 Agent 或表演指导增加固定动作覆盖率；它只提供更准确的动作语义候选。Agent 仍须根据用户任务和叙事动机决定是否 authoring，不能把旧 prompt 的“全额控制/拒绝罚站”解释成写入授权。

模板 profile 使用 manifest 的 `performanceProfiles` 声明；完整内容可以放在模板包内的 JSON 文件中，也可以直接 inline `characters`，但不能同时提供 file 与 inline 内容。Agent 接收的是 loader 校验并与实际模型能力求交后的目录，不接收 profile 原始文件路径。

能力目录没有匹配 profile 时 Agent 可以继续使用通用表演资料；模板 profile 文件缺失、损坏或版本不支持则属于模板 discovery/configuration error，宿主必须在注入目录中报告结构化诊断，不能把不完整的资料当成空能力目录继续自动写入。

Agent 不通过 `PerformanceProfileProvider` 读取模型文件或舞台状态；宿主先取得当前角色绑定的实际模型能力，再与只读 profile 解析结果合并成注入目录。该目录生成逻辑可以与表演指导共享，但 profile provider 不成为 Agent 工具或写入授权边界。

该解析结果按单个 scene character 独立解析，先按模板 `characterPreset.id` 与 scene character `id` 匹配，再按规范化 canonical name/alias 后备匹配；model、outfit 和资源路径不参与身份判断。同一 scene 中多个不同角色各自命中不构成歧义；只有单个 scene character 命中多个同等候选时工具才返回结构化 `ambiguous_identity`。解析不使用模糊包含匹配，组合名称必须是显式 alias；Agent 必须报告歧义并等待选择，不能静默改写角色绑定或 scene meta。

表演指导和电影感大师只使用结构化 JSON 返回 `SemanticScenePatchV1`，即使模型支持 tool calling 也不注册工具或运行 tool loop。项目 Agent 是唯一要求 provider 原生 tool calling、接收 tool result 并自主选择读取内容的工作流；共享 operation algebra 不改变这一执行边界。

项目 Agent 的自动提交授权只适用于用户在 Agent Conversation 中明确发起的执行回合。表演指导与电影感大师在正式 scene 上运行时只生成候选 patch，必须由用户明确应用；它们不能复用项目 Agent 的免确认提交语义。

## Consequences

- 项目 Agent 可以完成背景资源绑定、表演润色和其他合法剧本收尾，但正式 scene 仍只能通过 semantic authoring seam 改变。
- 项目 Agent 拥有独立单通道模型请求队列，不与 AI 铺戏阶段争抢并发 permit。
- 项目文件列表与文本搜索保持在项目目录内；已注册外部库中的已知文本可通过稳定挂载引用按行读取，图片和媒体能力继续通过资源工具按模型能力受控暴露。
- Agent 视觉能力只允许查看独立图片资源，不允许操作或捕获当前用户舞台；共享的 Stage、playback、Live2D 和 UtSystem 不得被 Agent 视觉检查抢占。
- Agent 只绑定已有资源引用，不物化或删除资源文件，因此写入事务保持在 semantic scene 边界内。
- 工具执行授权只来自经过 schema 校验的原生 tool call，不存在文本命令 fallback。
- 写入 tool call 是默认原子边界；跨操作原子性必须由 Agent 显式请求，不能由宿主隐式扩大。
- 显式事务采用单一基础行视图并预先解析全部 locator，不把 operations 数组变成依赖中间结果的脚本语言。
- 显式事务拒绝自相矛盾的操作，不使用隐式 last-write-wins 猜测 Agent 的最终意图。
- Agent-facing 表示不暴露持久化身份；行号映射与精确版本冲突由工具层承担，V1 不做字段级三方合并。
- prompt 规则可以随着当前用户请求变化，但 schema、编译、资源和并发安全规则不会依赖 prompt 遵守。
- 每次写入都先经过统一的强制 authoring gate，且 Agent 资源检查采用严格失败语义而不是 runtime preparation 的宽松降级。
- gate 要求最终完整 scene 无 error；既有错误也必须修复，否则 Agent 只能说明限制并结束当前执行回合，Conversation 仍可继续。
- 乐观预检减少无效排队，最终正确性由 mutation queue 内的精确版本检查与权威 gate 保证。
- 无界执行回合不会因为固定轮数上限而被截断，但宿主必须支持 80% 阈值的模型压缩和 Conversation 恢复。
- 宿主持久状态承担事务与并发正确性，模型生成的对话型摘要只承担认知恢复；scene 和行号仍以工具当前读取得到的 snapshot 为准。
- 读取工具需要提供有界、可续读的结果，保证一次大文件读取或搜索不会越过压缩预留空间。
- Conversation 没有 completed、cancelled 或 blocked 终态；普通回复、取消和技术阻塞只结束或暂停当前执行回合。
- 用户可见的提交活动来自宿主 receipt，避免模型遗漏或虚构已经提交的工作。
- 多个 Conversation 可以在同一台机器上跨应用生命周期恢复，同时不会写入项目文件或协作状态。
- 恢复 Conversation 不等于恢复执行；跨应用生命周期继续消耗模型或调用工具需要用户再次明确输入或继续。
- write-ahead 记录阻止旧 patch 在恢复时被重放，但不对“scene 可能已提交而 receipt 尚未落盘”的崩溃窗口做事后归因；该结果保持未知并要求 Agent 重读规划。
- 全局单执行槽避免多个自治执行回合持有不同 scene 认知并相互制造冲突，同时不限制保存多个 Conversation 或人类继续编辑。
- 运行界面中的后续用户输入是同一 Conversation 的普通消息；用户可以另建多个 Conversation，但它们不能同时执行。
- 排队用户消息的顺序和原文由宿主保证，语义冲突完全由 Agent 处理。
- 取消请求停止未来工作，但不会牺牲正在执行的 semantic transaction 原子性或回滚已经提交的变更。
