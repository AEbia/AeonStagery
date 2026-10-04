---
status: accepted
---

# Source-Identity Project Agent Authoring

ADR0023 的项目 Agent 写协议使用 Agent 行号隐藏 statement/companion source identity。结构写入会使后续行号失效，并让无状态模型 provider 在后续请求中反复携带刷新得到的 scene 内容；本决策改为直接使用正式 scene source 已有的稳定不透明 identity，以降低完成一次正确 authoring 任务的总模型 token。该方案已通过真实 provider benchmark 的验收门槛（见 Benchmark Gate），本 ADR 转为 accepted，并部分取代 ADR0023 的项目 Agent 行号写寻址决策。

## Decision

项目 Agent 的 scene 读取返回正式 source 已有的 `statementId` 和 `companionId`。root statement 以 `statementId` 寻址；dialogue companion 以 `{ statementId, companionId }` 复合寻址，因为 companion ID 只在 parent 内保证唯一。两者都是不透明 source identity，不承诺 UUID 格式或 family 前缀，不创建额外 Agent reference、持久映射表或 tombstone。identity 在对象存活期间稳定；update、move、reorder 与 family replacement 保留 identity，delete 和 family replacement 自动删除的不兼容 companions 使相应 identity 失效。

Agent 行号只保留为读取投影中的非权威展示位置。项目 Agent 的写参数、显式 transaction、模型可见 diagnostics 和 committed tool result 均不包含行号、line map、`validThroughLine`、`invalidatedFromLine`、`refreshRequired` 或 `stale_line_map`。诊断使用 source identity、字段 path 和仅在稀疏 transaction diagnostics 中需要的 `operationIndex`；UI 可以独立把 identity 投影为当前展示位置。

项目 Agent authoring facade 在当前 source snapshot 内确定性解析 source identity，并转换为现有 semantic authoring intent；它不保存 identity 映射。表演指导与电影感处理器继续使用无 source identity 的 line-based `SemanticScenePatchV1`。项目 Agent 复用相同的 operation 名称、registry 派生 draft/patch payload 和统一 authoring gate，但拥有独立的 source-identity locator schema。

项目 Agent 写工具固定为 `insertStatement`、`insertCompanion`、`updateStatement`、`updateCompanion`、`deleteSourceItem`、`moveSourceItem`、`reorderCompanions` 与 `applyAuthoringTransaction`。`deleteSourceItem` 和 `moveSourceItem` 使用 statement/companion target union；严格 schema 通过必需字段判别分支，不要求额外 `kind` discriminator。root target 只使用 `statementId`，companion target 使用 `statementId + companionId`。root move 接受绝对 `time`，companion move 接受 source-native `anchor + offset`，`updateCompanion` 不再修改这两个时间字段。位置参数使用 `beforeStatementId`、`beforeCompanionId` 和 `orderedCompanionIds`；锚点仍受相同 time 或同 parent 约束。transaction 开始时统一解析所有既有 identities；新插入对象由宿主生成 identity，不能由同一 transaction 的后续 operation 通过临时别名引用。

模型可见的成功结果保持最小：返回 committed status、counts、warnings，以及与输入 operations 严格等长同序的 results。单操作或批量成功项都不重复 `operationIndex`；数组位置即为关联。每项 outcome 为 `inserted | updated | deleted | moved | reordered | no_change`；transaction 中的合法 no-op 不省略也不算错误。至少一项实际变化时整体 status 为 `committed`，全部为 no-op 时为 `no_change`，不创建 history 或增加 document version。普通 update、delete、move 与 reorder 只返回 outcome；insert 额外返回宿主生成的 statement/companion identities；family replacement 额外返回自动删除的 companion locators。只有宿主保存值与请求值确有差异时才返回最小 `normalized` merge patch。模型结果不返回 document version、source target 副本、payload 副本、scene 片段或完整 candidate。所有 scene read/write tool result 也不向模型返回 document version；它只存在于宿主 snapshot、authoring receipt、history 与 benchmark debug 数据中，`version_conflict` 也不暴露具体版本号。

provider API 在请求之间无状态，但宿主持有 Conversation、base source snapshot、document version 和 transaction 正确性状态。source identity 不绕过 ADR0023 的严格 exact-version gate；并发版本变化仍返回 `version_conflict`，要求重新读取和规划，不做字段级三方合并。source identity 的稳定期是一个 source 对象连续存活的生命周期：跨 update、move、reorder、保存、重开和协作同步保持不变，delete 结束该生命周期；不对删除后的历史字符串复用提供额外保证。上下文压缩规则不改变，摘要仍不保存 statement/companion identities。

当 source identity 不存在时，工具返回 retryable `source_identity_not_found`，并以 `suggestedAction: "call_readScene"` 提示 Agent 调用已有的 `readScene`；工具不模糊匹配、按文本猜测目标或退回行号。显式 transaction 遇到该错误时整体不提交。

项目 Agent 不新增 transaction preview、dry-run、prepared transaction 或 commit token。宿主在普通写 tool call 内完成候选构建、乐观预检、权威 gate 与原子提交，并按一般 tool-result 流程返回成功 receipt 或失败 diagnostics。当前没有旧 Conversation 需要迁移；协议与 toolset 直接提升版本，不实现 line-based Conversation 的迁移、兼容或清理分支。

Agent UI 从宿主 authoring receipt 独立投影变更对象、类别和时间范围，并支持按当前 source identity 定位。当前不提供字段级 before/after diff，也不为 UI 需求扩大模型 tool result。

## Benchmark Gate

开发者在修改写协议前先实现可手动触发的真实 provider benchmark，计划用 line-based 协议生成 baseline artifact，实施 source-identity 协议后由同一 runner 生成 candidate artifact；最终产品不保留协议切换开关。命令使用显式 `--phase`、`--runs`、`--token-budget` 和 `--output`；输出文件位于 gitignored 的 `.scratch/project-agent-benchmark/`，已存在时拒绝覆盖，除非显式传入 `--overwrite`。

（架构修订）benchmark gate 实际运行在 ADR0025 的 standalone Agent Bridge 引擎上（headless CLI `npm run agent:bridge -- benchmark ...`），而不是 Electron 专用 mode；provider 配置与 credential 来自 bridge 的 CLI/env（`--endpoint`/`--model`/`--api-key` 或 `AEON_AGENT_BRIDGE_*`），benchmark 命令本身不引入新的 credential/endpoint/model 覆盖面。fixture project、Conversation journal 和 Agent lease 全部隔离；每个样本从同一 650 行 scene fixture 复制到新的临时目录，完成或失败后都清除 source 和临时 journal。报告不保存 endpoint URL、消息、prompt、reasoning、tool arguments/results 或 scene 内容。同一 phase 的 token budget 停止调度阈值、`phase_budget_exhausted`/`usage_unavailable` 不可续跑、能力探测单独报告且不计入 task tokens、可选 `cachedInputTokens` 与 cache coverage 语义均按原文执行。

（验收修订，2026-08-14）line-based baseline 无法采集：本树在实施完成后不再包含 line-based 项目 Agent 写路径且不保留 toggle（见上文 Decision），而 benchmark gate 依赖的 standalone engine 在 line-based 时期并不存在；维护者按 issue 02 决议把 baseline 记录为不可采集，验收门槛改为 candidate-only。candidate 必须完整、`eligible`、provider usage 可用，四类任务 oracle 成功率均为 1.0；报告同时展示单次更新的首次读取成本、模型轮数、成功率，以及全样本与仅成功样本的 token、逐任务中位数和等权总体中位数。token 总量下降假设（source identity 降低总模型 token）不再直接可测，作为未验证动机保留在本 ADR 的历史文本中。

实际执行（2026-08-14，模型 deepseek-v4-flash，runs=1，token budget 600000）：candidate artifact `.scratch/project-agent-benchmark/candidate.json`，四类任务全部通过 oracle，成功率 1.0；总 task tokens 477596，等权总体中位数 138712.5；逐任务中位总 token 为 singleUpdate 15944（4 轮）、insertThenUpdate 184227（5 轮）、deleteThenUpdateDownstream 138536（4 轮）、atomicBatch 138889（4 轮）；cache coverage 1.0（hitRate 0.733）。运行中发现的三个 harness/oracle 缺陷（JSON 键序敏感的 oracle 比较、insert 锚点位置判定、per-task version increase 计算）均已修复并回归覆盖。
