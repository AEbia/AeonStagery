# ADR Status

本文件是 ADR 新鲜度索引，也是 ADR 编号的唯一权威目录。最后翻新：2026-10-03。

历史 ADR 保留原始决策语境，但不再默认代表当前实现。查当前架构时，先读下面的 freshness anchors；只有需要理解迁移背景时再读 archived / historical 文档。

## Freshness Anchors

| ADR | Status | Current Reading |
| --- | --- | --- |
| [KSM-0003 Semantic Scene Statements](ksm-adr/ksm-0003-semantic-scene-statements.md) | current freshness anchor | 当前 semantic statement authoring、prepared runtime、template payload 与 legacy deletion gates 的权威入口；SceneDocumentV5 现作为当前 schema epoch（由 ADR-0031 演进，支持自 v3 与 v4 自动迁移），协作协议升级为 v3 wire。 |
| [0031 Evolution Compatibility Policy](adr/0031-evolution-compatibility-policy.md) | current freshness anchor | 持久化创作资产演进兼容政策；SceneDocumentV5 为当前激活的 schema epoch（支持自 v3 与 v4 自动迁移），project metadata v2（包含 Project Compatibility Envelope），collaboration wire v3（要求 sceneSchemaVersion = 5），以及兼容性协调器 (Compatibility Coordinator) 与未知字段保真契约的权威入口。 |
| [0018 Timeline Authoring, Collaboration Transactions, and Resource Seams](adr/0018-timeline-authoring-collaboration-resource-seams.md) | current for collaboration/resource seams; timeline edit section superseded by KSM-0003 | Collaboration transaction planner、publish executor、asset readiness gate、Live2D bundle rules 与 asset scope policy 仍以本文为入口；legacy action-edit Interface 已由 semantic statement authoring 接管。 |
| [0019 Live2D Cubism Multi-Version Runtime Compatibility](adr/0019-live2d-cubism-multiversion-runtime.md) | current freshness anchor | Cubism 2 与 Cubism 3/4/5 runtime Adapter seam、Live2D entry 识别与 bundle 兼容承诺以本文为准。 |
| [0021 Stable External Library Mount References](adr/0021-stable-external-library-mount-references.md) | current freshness anchor | 本地 scene 使用稳定 `@mount/<id>/...` 引用，用户设置映射本机根目录，协作发布前 projectize 为项目相对引用。 |

## Current Supporting Decisions

| ADR | Status | Current Reading |
| --- | --- | --- |
| [0006 Visual Composition Model](adr/0006-visual-composition-model.md) | current | 视觉组合模型方向仍有效；source/runtime 入口按 KSM-0003 的 semantic contract 解读。 |
| [0007 Scene Visual Block Schema](adr/0007-scene-visual-block-schema.md) | current | `SceneVisualBlock` 仍是结构化视觉主数据入口。 |
| [0008 Visual Authoring Seams](adr/0008-visual-authoring-seams.md) | current, extended by KSM-0003 | Visual / Timeline / Composition authoring seam 拆分仍有效；legacy action-based composition wording 按 semantic statement implementation 改读。 |
| [0009 Canonical Environment Layers](adr/0009-canonical-environment-layers.md) | current, extended by KSM-0003 | Environment Layer 身份、`background` 保留层与旧 background action alias 删除规则仍有效。 |
| [0010 Centralized Collaboration Server](adr/0010-centralized-collaboration-server.md) | current with clarified adapter | 中心化服务端仍有效；embedded server process 是启动 Adapter，不是 renderer 房主。 |
| [0011 ID-Backed Collaborative State and No Shared Undo](adr/0011-collaborative-state-model-and-undo-boundary.md) | current, extended by 0018 and KSM-0003 | ID-backed shared state 与 no shared undo 有效；实体已从 action 切换到 statement / companion。 |
| [0012 Optimistic Collaboration with Presence](adr/0012-optimistic-collaboration-with-presence.md) | current, extended by ADR-0028 | 普通编辑的乐观协作与 presence 非锁语义仍有效；自定义 Motion 写入是 ADR-0028 定义的实体级租约例外。 |
| [0013 Live2D Bundles and Single-File Backgrounds](adr/0013-collaborative-live2d-asset-bundles.md) | partially superseded | Live2D bundle 规则有效；“只覆盖 Live2D + background” 已由 ADR-0018 扩展为 Live2D bundle、background image、audio file、image file 与 animation file。 |
| [0014 Project-Relative Asset References](adr/0014-project-relative-asset-references-in-collaboration.md) | current, narrowed by ADR-0021 for local authoring | 协作 scene 继续用 project-relative asset reference；本地外部库 source authoring 可先使用 `@mount/<id>/...`，协作发布前 projectize。 |
| [0015 Collaborative Document Layer Above DocumentStore](adr/0015-collaborative-document-layer-above-document-store.md) | current, extended by 0018 and KSM-0003 | `DocumentStore` 是 materialized read/projection model，不是共享事实来源；共享事实已切到 semantic statement state。 |
| [0016 Collaborative Persistence vs Local Scene Snapshots](adr/0016-collaborative-persistence-vs-local-scene-snapshots.md) | current | 服务端持久化为协作事实来源仍有效。 |
| [0017 Collaborative Timeline Order](adr/0017-collaborative-timeline-order.md) | current, translated by KSM-0003 | 同时间顺序事实有效；当前名称是 `statementOrder` / `companionOrder`，不是旧 `timelineOrder` action sequence。 |
| [0020 GPT-SoVITS Voice Authoring and Local Voice Library](adr/0020-gpt-sovits-voice-authoring.md) | current | GPT-SoVITS 用户语音库、候选生成、项目角色默认、template voice profile 与资源采用事务的权威边界；明确不依赖第三方 preset 插件格式。 |
| [KSM-0001 Unified Template System](ksm-adr/ksm-0001-unified-template-system.md) | current | Versioned template packages、semantic payload、template source precedence 与 template asset materialization 的权威入口。 |
| [0022 AI Prose-to-Script Normalization](adr/0022-ai-prose-to-script-normalization.md) | proposed | AI 正文无损规范化、角色表演占位、表演/电影感处理器与正式 scene 增强边界的决策入口。 |
| [0023 Tool-Mediated Persistent Project Agent Conversation](adr/0023-tool-mediated-autonomous-project-agent.md) | partially superseded by ADR-0024 | Conversation 生命周期、持久化、exact-version gate、provider/transport、上下文压缩与项目 Agent 主循环仍有效；旧行号写寻址由 ADR-0024 取代。 |
| [0024 Source-Identity Project Agent Authoring](adr/0024-source-identity-project-agent-authoring.md) | current | Project Agent 以稳定 statement/companion identity 读取与写入正式 scene；写工具、回执、诊断与 benchmark gate 以本文为准。 |
| [0025 External Agent Bridge](adr/0025-external-agent-bridge.md) | proposed | 复用 Project Agent 业务装配的 headless CLI、stdio JSON-RPC 与 benchmark sample port。 |
| [0026 WebGAL Script Import as a Scaffolding Source](adr/0026-webgal-script-import-scaffolding-source.md) | current | WebGAL 剧本导入脚手架：单文件单场景、`changeFigure` 状态语义、说话人/立绘双向身份绑定、`@mount` 引用、导入回执（含 report）与阅读速度导入时定参。 |
| [0028 Scoped Custom Motion Edit Lease](adr/0028-scoped-custom-motion-edit-lease.md) | current | 自定义 Motion 转换和写入使用服务端裁定的角色表演实体级租约；普通场景编辑仍遵守 ADR-0012。 |
| [0029 Live2D 自定义 Motion 关键帧编辑](adr/0029-live2d-custom-motion-keyframe-authoring.md) | current, implemented | 自定义 Motion 是 `characterPerformance` 的 `kind: 'custom'` Motion 来源；资源 Motion 转换、关键帧/曲线编辑、运行时与协作边界的权威入口。 |
| [0030 Dialogue Duration Policy Ownership](adr/0030-dialogue-duration-policy.md) | current, implemented | `resolveDialogueDuration` 是对白默认、节奏档位、阅读速度和文本更新重算策略的唯一 policy 入口；调用方只声明语境。 |
| [0032 崩溃界面与诊断报告恢复体系](adr/0032-crash-screen-and-diagnostic-report-recovery.md) | current, implemented | 全栈分级捕获、无堆栈沉稳崩溃界面、日志黑匣子环形缓冲、严格脱敏结构化诊断报告与静态兜底恢复体系的权威入口。 |
| [0033 Live2D 资源 Motion 曲线缓存与 Seek 求值统一](adr/0033-live2d-resource-motion-curve-cache-seek.md) | current, implemented | 普通资源 Motion 在加载期生成隐藏逐帧曲线缓存（纯派生数据，512MB 预算），Seek 缓存优先 + SDK 回退，Play/Bake/Export 复用同一求值器的权威入口。 |
| [0034 Live2D 运行时状态清理与淡入来源权威](adr/0034-live2d-runtime-state-purge-and-fade-source.md) | current, implemented | `purgeCharacterRuntimeState` 是 Seek/编辑/角色回收的唯一清脏入口；动作/表情淡入来源必须由场景裁定，不读模型存活状态。 |
| [0035 开源许可与 Live2D 运行时分发边界](adr/0035-open-source-licensing-and-live2d-runtime-distribution.md) | current, accepted | Apache-2.0 发布下的三方许可声明、运行时 staging（auto/none/verify）、`none`/`verify` 两套打包闸门与"更新不删除已有运行时"不变量的权威入口。 |
| [0036 更新渠道与差分下载基线](adr/0036-update-channels-and-differential-baselines.md) | current, accepted | OSS / GitHub 渠道、差分更新基线与块图补取、安装缓存 SHA256/签名校验及禁止静默整包回退的权威入口。 |

## Historical / Superseded

| ADR | Status | Current Reading |
| --- | --- | --- |
| [0001 Adapter + Store Architecture](adr/0001-adapter-store-architecture.md) | partially superseded | UI 不直接触碰 engine singleton、Store 是 read model、写入跨受控 authoring seam 仍有效；ScriptEngine Orchestrator 与 DocumentAdapter-only 写入说法已过时。 |
| [0002 UI Migration Strategy](adr/0002-ui-migration-strategy.md) | archived historical plan | Adapter / Store 迁移执行计划记录；不要作为当前 migration checklist 使用。 |
| [0003 Remaining Bridges and Known Gaps](adr/0003-remaining-bridges-and-known-gaps.md) | archived historical snapshot | Orchestrator 废弃决策有效；具体 bridge 清单、测试数量和 UI 残留列表已过时。 |
| [0004 SceneFileService IO Layer](adr/0004-scenefileservice-io-layer.md) | superseded by KSM-0003 | SceneFileService 作为 I/O application service 的方向有效；source codec、compile/load/save、ID 和 prepared runtime 细节以 KSM-0003 为准。 |
| [0005 Timeline Structural Authoring](adr/0005-timeline-structural-authoring.md) | partially superseded by ADR-0018 and KSM-0003 | structural authoring 的 typed intent / receipt / all-or-nothing 事务语义仍是历史基础；当前 public authoring Interface 是 semantic statement authoring。 |
| [0027 Live2D Parameter Animation Authoring](adr/0027-live2d-parameter-animation-authoring.md) | superseded by ADR-0029 | 原始帧末 Parameter Clip 设计已由 ADR-0029 取代；`live2dParameterClip` family 与 `applyLive2DParameterClip` runtime action 已删除，其 schema v3 计划不属于当前契约。 |
| [KSM-0002 Template UI Entry Points Draft](ksm-adr/ksm-0002-template-ui-entry-points-draft.md) | archived draft | 第一轮 template UI 产品方向草案；当前已实现契约见 `docs/en/template-system.md`、`docs/cn/template-system.md` 与 KSM-0001。 |

## Pruned

- Removed `0004-implementation-plan.md`: it was an execution checklist, duplicated ADR number 0004, and was superseded by the SceneFileService ADR plus KSM-0003.
- Removed `adr/STATUS.md`: it was a stale duplicate of this index and contained obsolete or missing paths.
