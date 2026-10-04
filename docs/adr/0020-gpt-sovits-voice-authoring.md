---
status: accepted
---

# GPT-SoVITS Voice Authoring, Local Voice Library, and Template Profiles

AeonStagery 已经具备为当前 dialogue 生成语音的最小链路，但当前入口把本机运行环境、项目 preset、参考音频和一次性生成动作混在设置页与 ActionInspector 中。这个结构无法支持持续试听、候选比较、跨项目复用和角色默认音色，也容易让本机绝对路径进入项目数据。

本机 GPT-SoVITS 安装中可能存在第三方插件添加的 `presets/`、`metadata.json`、`history.json` 或 `ui_config.json`。这些目录和格式不是 GPT-SoVITS 官方 API 契约，AeonStagery 不能把产品行为或持久化 schema 建立在它们之上。

本 ADR 决定 GPT-SoVITS authoring 的状态分层、Module / Interface / Seam、资源进入项目的事务顺序，以及它与统一 template package、timeline authoring 和协作资源规则的关系。

## Decision

引入独立的 `VoiceAuthoring` Module，统一承载语音工作台、用户语音库、候选生成、项目角色默认和 template voice profile 应用。UI 只表达用户意图和读取 session 状态，不直接访问 Node 文件系统、Electron IPC、DocumentStore、DocumentAdapter 或引擎单例。

语音 authoring 使用三层不同所有权的数据，三者不能共用一个带可选绝对路径的大型 preset 类型：

1. `LocalVoicePreset` 是机器本地、跨项目复用的用户配置，可以引用本机模型路径，但不能被 scene、project 或 template 直接引用。
2. `ProjectVoiceProfile` 是当前项目内的角色语音配置，只保存逻辑模型 selector、项目相对参考音频和推理默认值。
3. `TemplateVoiceProfile` 是统一 template package 的声明式 capability，只保存逻辑模型 selector、template asset id 和可序列化推理默认值。

状态转换必须经过 `VoiceAuthoringService` 或 template application service：

```text
raw local files
  -> LocalVoicePreset
  -> ProjectVoiceProfile
  -> dialogue voice asset

LocalVoicePreset
  -> TemplateVoiceProfile
  -> ProjectVoiceProfile
```

不存在 `TemplateVoiceProfile -> LocalVoicePreset` 的隐式持久化，也不存在 `LocalVoicePreset` id 直接写进 scene 的捷径。

## Alignment With Existing Decisions

本 ADR 按 `docs/adr-status.md` 的 current reading 解释既有决策，不恢复已经被后续 ADR 取代的历史约束：

- ADR-0001 仍要求 UI 不直接触碰 engine singleton、Store 作为 read model、mutation 经过受控 seam。本 ADR 因此使用 `VoiceWorkbenchSessionStore` 与 `VoiceAuthoringService`，但不采用已经过时的 “DocumentAdapter 是所有 UI 唯一写入口” 说法。
- ADR-0004 要求 I/O pipeline 收敛到 application service 和注入的 file access Interface。本 ADR 将 library/cache/template metadata 规则与 Electron Node I/O Adapter 分离，React 不承担文件读写。
- ADR-0011 规定未确认的本地 preview/draft 可以取消，但已提交共享状态没有通用 shared undo。本 ADR 将候选留在 local session，只有采用后才进入项目与协作链路。
- ADR-0014 规定 collaborative scene 继续使用 project-relative asset reference。本 ADR 保持 `dialogue.params.voice = 'vocal/...'`，不把 local preset id、absolute path、template asset id 或 content hash 写进 scene voice 字段。
- ADR-0018 仍是 resource readiness 和 collaboration asset scope 的 freshness anchor；KSM-0003 已把 ordinary timeline edit 切换到 semantic statement authoring。本 ADR 因此要求 dialogue patch 走 `SemanticAuthoringApplicationService` 的窄 `author()` 端口，正式音频先 projectize，并继续受 `CollaborativeAssetReadinessGate` 与 `CollaborativeAssetScopePolicy` 约束。
- KSM-0001 与 KSM-0002 定义统一 template package 的架构和 UI 方向，`docs/cn/template-system.md` 描述当前已实现契约。本 ADR 只新增声明式 `voiceProfiles` capability 和对应 application service，不引入平行 package format、resolver 或可执行插件代码。

如果上述 ADR 后续被新的 freshness anchor 替代，应先更新本 ADR 的 current reading，再修改 voice authoring seam；不能只在 UI 或 Electron handler 中局部绕过。

## Third-Party Preset Boundary

AeonStagery 不支持第三方 GPT-SoVITS preset 插件格式：

- catalog 不自动扫描 GPT 根目录中的 `presets/`。
- 不解析第三方 `metadata.json`、`history.json` 或 `ui_config.json`。
- 不提供一次性导入或持续兼容 Adapter。
- 不把第三方目录结构作为测试 fixture 或产品约定。

如果用户显式把某个第三方目录加入 `referenceRoots`，其中的音频只作为无可信元数据的原始参考文件出现。目录名可以作为搜索标签，但 prompt text 和 prompt language 必须由用户确认。

现有 AeonStagery `project.json.voiceGeneration.gptSovits.presets` 属于本项目早期 schema，与第三方插件格式无关。它继续被防御性读取并显示为旧版项目配置，但新 UI 不再写入该结构；用户可以显式把它另存为新的用户配置或项目 profile。

## Module And Interface Boundaries

### VoiceAuthoringService

`VoiceAuthoringService` 是 UI 的 application seam。它接收语义化命令并返回 receipt，不暴露底层 IPC 或文件路径操作步骤：

```typescript
interface IVoiceAuthoringService {
  generateCandidate(command: GenerateVoiceCandidateCommand): Promise<VoiceCandidateReceipt>;
  adoptCandidate(command: AdoptVoiceCandidateCommand): Promise<VoiceAdoptionReceipt>;
  saveLocalPreset(command: SaveLocalVoicePresetCommand): Promise<LocalVoicePresetReceipt>;
  setCharacterDefault(command: SetCharacterVoiceProfileCommand): Promise<CharacterVoiceProfileReceipt>;
  publishTemplateProfile(command: PublishTemplateVoiceProfileCommand): Promise<TemplateVoiceProfileReceipt>;
  discardSession(sessionId: string): Promise<void>;
}
```

该服务通过构造器注入以下窄 Interface：

- `VoiceLibraryRepository`：本机用户语音库的 metadata 与托管参考音频。
- `VoiceCatalogPort`：模型与原始参考文件发现。
- `GptSovitsProcessPort`：API status/start/stop、权重切换与 `/tts`。
- `VoiceCandidateCachePort`：候选缓存、读取和清理。
- `ProjectResourceService`：把候选或参考音频复制进项目资源根。
- `IProjectWorkspaceService`：持久化 project voice profiles。
- semantic authoring port：读取当前 `SceneDocumentV4` snapshot，并提交 dialogue `update-statement` intent。
- semantic character command port：通过同一 application service 写入角色默认 profile id。
- `TemplatePackageCatalog` 与 template application/export ports：解析和发布 template capability。

不得让 `VoiceAuthoringService` 接收完整 `BootstrapContext`。Bootstrapper 只负责构造和连接这些窄端口。

### VoiceWorkbenchSessionStore

`VoiceWorkbenchSessionStore` 是只读 read model，包含当前模式、目标 scene/action、编辑文本、选择的模型和参考、候选列表、busy state 与错误。所有 mutation 由 `VoiceAuthoringService` 或 session controller 完成。

未采用候选是本地 draft。关闭工作台只隐藏 UI，不立即丢弃当前项目 session；项目切换、显式清空或应用退出时才销毁。

### Electron Adapters

Electron main process 负责子进程、HTTP、二进制文件和 userData 目录。preload 只暴露类型化 voice API。纯规则必须留在可测试的 renderer-neutral Module 中：

- catalog 分类、稳定排序和逻辑 selector 匹配。
- local/project/template schema validation 与 normalization。
- 请求参数构建和默认值。
- cache/project/template 路径约束。
- profile precedence 和 source metadata。

React 组件不能直接调用 `window.aeonStageryAPI.gptSovits`；调用必须封装在注入的 `GptSovitsProcessPort` 或 repository Adapter 后面。

## Catalog Discovery

GPT-SoVITS root 只用于运行环境验证和约定模型目录发现：

- `GPT_weights*` 中的 `.ckpt` 是 GPT model candidate。
- `SoVITS_weights*` 中的 `.pth` 是 SoVITS model candidate。
- 用户显式配置的 `modelRoots` 可以补充这两类模型。
- 用户显式配置的 `referenceRoots` 只发现支持的音频文件。

扫描必须跳过 `runtime`、`tools`、`pretrained_models`、依赖缓存、临时目录和符号链接循环。结果数量和单次扫描耗时必须有上限；超限、权限错误和坏路径作为结构化 issue 返回，不能使整个 catalog 不可用。

模型配对基于提示而不是事实推断。相同或相近 basename 可以形成推荐，但用户仍独立选择 GPT 与 SoVITS 模型。模型 locator 使用：

```typescript
interface LocalModelLocator {
  absolutePath: string;
  fileName: string;
  relativePathSuffix?: string;
  size?: number;
  modifiedAt?: number;
}
```

本机 preset 首先尝试原 absolute path；路径失效时再使用 `fileName + relativePathSuffix` 在配置 roots 中恢复。第一版不对大型权重计算完整内容 hash。

## Local Voice Library

用户语音库位于：

```text
<userData>/voice-library/library.json
<userData>/voice-library/references/<presetId>/<referenceId>.<ext>
```

`library.json` 必须包含 `schemaVersion`，写入采用 temp file + atomic rename。参考音频在保存 preset 时复制到托管目录，JSON 只保存托管相对路径。原始参考音频移动或删除后，已保存 preset 仍然可用。

`LocalVoicePreset` 至少包含：

```typescript
interface LocalVoicePreset {
  id: string;
  name: string;
  gptModel: LocalModelLocator;
  sovitsModel: LocalModelLocator;
  references: LocalVoiceReference[];
  inferenceDefaults: VoiceInferenceOptions;
  createdAt: string;
  updatedAt: string;
}

interface LocalVoiceReference {
  id: string;
  label: string;
  managedPath: string;
  role: 'primary' | 'auxiliary';
  promptText: string;
  promptLang: string;
  tags?: string[];
}
```

用户库支持 create、save-as、update、rename、duplicate 和 delete。删除操作只能触及经过 user voice-library root 校验的文件。它不能删除模型、原始参考文件、项目资产或 template assets。

## Candidate Generation

工作台支持当前 dialogue 与自由文本两种模式。每次生成一条候选，`regenerate` 复用模型、参考和推理参数，但分配一个新的显式 seed。候选记录完整输入，保证比较与复现不依赖当前 UI state。

候选缓存位于：

```text
<userData>/voice-workbench/<sessionId>/<candidateId>.wav
```

缓存路径由 Electron 生成，renderer 不能提交任意输出路径。启动时清理超过 24 小时的遗留 session；正常退出清理当前 session。

GPT-SoVITS weight switching 是进程全局状态，因此全应用只允许一个在途 generation。生成命令先 ping API；API 不可达且 root 有效时允许由该用户命令启动本地进程并等待有限时间。超时或失败只产生失败 receipt，不写候选、不修改项目。

工作台可以试听原始参考、托管参考和候选，但任意时刻只允许一个 preview audio 播放。preview controller 的生命周期与 session 分离，关闭 UI 时必须停止并释放当前 HTMLAudioElement。

## Candidate Adoption

候选采用遵守 resource-first、document-second 顺序：

1. 校验 session/candidate ownership 和当前 project/scene identity。
2. 通过 `ProjectResourceService` 把 cache audio 复制到 `vocal/generated/`，得到项目相对路径。
3. 如果只是保存到项目，到此返回 resource receipt。
4. 如果应用到 dialogue，通过 semantic authoring application service 提交完整的 dialogue `update-statement` params。
5. statement commit 失败时，删除本次新建且尚未被引用的项目文件，并返回失败 receipt。

当候选文本与 dialogue text 相同，只提交：

```typescript
{
  params: {
    voice: 'vocal/generated/...wav',
    lipSync: true
  }
}
```

当文本不同时，UI 必须让用户选择“同步文本并应用”或“仅保存到项目”。不能把不匹配语音绑定到旧文本。任何采用路径都不自动修改 `durationSeconds`；UI 只显示候选时长和 dialogue window 的差异。

生成文件进入 scene 后继续复用现有 `dialogue.params.voice`、`DialogueCoordinator`、`AudioCoordinator`、export mixing 和 `asset://` range playback，不新增第二条运行时语音链路。

## Project Voice Profiles

用户显式执行“设为角色默认”时，当前本机选择被物化为 `ProjectVoiceProfile`：

```typescript
interface ProjectVoiceProfile {
  id: string;
  name: string;
  gptModel: PortableModelSelector;
  sovitsModel: PortableModelSelector;
  references: ProjectVoiceReference[];
  inferenceDefaults: VoiceInferenceOptions;
}

interface PortableModelSelector {
  fileName: string;
  relativePathSuffix?: string;
}

interface ProjectVoiceReference {
  id: string;
  audio: string;
  role: 'primary' | 'auxiliary';
  promptText: string;
  promptLang: string;
  tags?: string[];
}
```

`audio` 必须是 `vocal/reference/...` 项目相对路径。模型权重不复制进项目，因为它们是本机推理工具依赖，而不是 scene runtime asset。换机器后无法解析 selector 时，UI 显示本机模型缺失，不把 profile 判定为损坏 project data。

角色目录记录可选 `voiceProfileId`。`dialogue.params.speakerId` 对应角色存在 profile 时，工作台自动预选，但用户仍可覆盖当前 session。

“设为角色默认”是 application transaction：

1. projectize 参考音频。
2. 保存 project profile。
3. 通过 semantic character command port 写入角色 binding。

后一步失败时必须执行补偿：移除本次新建 profile，并清理尚未引用的参考音频。UI optimistic state 必须回滚到上一次持久化结果。

Project voice profile metadata 第一阶段不进入实时协作共享状态。采用后的 dialogue voice 属于 ADR-0018 已接受的 audio asset scope，必须继续经过现有 collaboration readiness gate。未来若要实时共享 project profile 或 reference library，必须显式扩展 `CollaborativeAssetScopePolicy` 和 project metadata 协作协议。

## Template Voice Profiles

统一 template manifest 增加类型化 `voiceProfiles` capability，`characterPresets` 可以声明 `voiceProfileId`。Template profile 与 project profile 共享推理参数语义，但资源引用不同：

```typescript
interface TemplateVoiceProfile {
  id: string;
  name: string;
  gptModel: PortableModelSelector;
  sovitsModel: PortableModelSelector;
  references: TemplateVoiceReference[];
  inferenceDefaults: VoiceInferenceOptions;
}

interface TemplateVoiceReference {
  id: string;
  assetId: string;
  role: 'primary' | 'auxiliary';
  promptText: string;
  promptLang: string;
  tags?: string[];
}
```

`assetId` 必须引用同一 package 的 `assets.index`。Template profile 不能包含绝对路径、project-relative path、renderer code 或任意脚本。

Template profile 遵循既有 `project > user > builtin` 和 enabled list 后项优先规则。合并结果必须保留 source metadata，UI 必须显示来源。Template package 的唯一持有者改为 `TemplatePackageCatalog`；timeline authoring、Template Capability Config 和 VoiceAuthoring 只消费 catalog 的窄 read Interface。

Template character 应用到项目时，template application service 必须：

1. 解析 character preset 和 voice profile。
2. 通过 `TemplateAssetResolver` 解析 reference asset。
3. 通过 `ProjectResourceService` 复制到 `vocal/reference/`。
4. 生成 project voice profile。
5. 通过角色目录 seam 写入角色与 `voiceProfileId`。

应用完成后的 scene 与 project 不能依赖 template-relative path。模板资源不会因为被发现而自动进入协作范围；只有被物化并成为正式项目引用的资源才能进入后续 readiness 判断。

## Managed Template Publishing

用户可以把 `LocalVoicePreset` 显式发布为 user 或 project template profile。第一阶段只允许写入 AeonStagery 管理的包：

```text
<userData>/templates/aeonstagery.user-voices/manifest.json
<projectRoot>/template/aeonstagery.project-voices/manifest.json
```

发布器不能修改 builtin、external library 或其他作者的 template package。参考音频复制到 managed package 的 `assets/voice/`，manifest 只写 asset id。用户发布到当前项目时，该显式命令可以把 managed package id 追加到 `templates.enabledTemplateIds`；普通扫描不能静默启用模板。

Application-managed user template root 加入 template discovery 的 `user` scope。它继续使用同一个 `TemplatePackageLoader`、schema validator、asset resolver 和 precedence，不引入 voice-specific package loader。

## Voice Inference Options

共享的 `VoiceInferenceOptions` 第一阶段包含：

```typescript
interface VoiceInferenceOptions {
  textLang: string;
  speed: number;
  topK: number;
  topP: number;
  temperature: number;
  textSplitMethod: string;
  repetitionPenalty: number;
  sampleSteps: number;
  superSampling: boolean;
  seed: number;
}
```

API transport defaults、validation range 和版本兼容属于纯 voice rules Module。UI 不自行拼 `/tts` body。`batch_size` 等执行优化继续由 Adapter 使用受测默认值，不与“生成几条候选”的产品语义混为一谈。

## Failure And Atomicity Rules

- catalog 部分失败不能清空最后一次有效 catalog；issue 单独投影。
- local library JSON 损坏时保留原文件并返回 recovery issue，不能用空库覆盖。
- local preset 保存必须先复制 reference，再原子提交 metadata；metadata 失败时清理新副本。
- generation 失败不能创建成功 candidate record。
- candidate 采用必须先 projectize resource，再提交 document edit。
- project profile 保存或角色 binding 失败必须回滚 optimistic UI 并执行补偿。
- template 发布先写 staging directory，通过 validation 后再替换 managed package。
- 所有 delete/cleanup 必须验证目标位于对应 managed root 内。

## Consequences

- Settings 只负责 GPT-SoVITS process、model roots 和 reference roots；用户配置 CRUD 与生成流程移到专用语音工作台。
- ActionInspector 保留手动 voice file 选择，只提供带当前 dialogue context 的工作台入口。
- 本机路径、项目路径和 template asset id 在类型层分离，减少绝对路径泄漏与错误 resolver 复用。
- 用户语音库不需要项目即可存在，但保存项目角色默认、采用候选和发布 project template 都要求有效项目 identity。
- 新 capability 增加 template schema 和 application service，不把 GPT-SoVITS 执行逻辑塞进 `TemplatePackageLoader`。
- 真实完成标准包括生成、试听、采用、scene playback 与 export playback；通过 unit tests 但实际无声不算完成。

## Non-Goals

- 不读取或迁移第三方 GPT-SoVITS preset 插件数据。
- 不训练 GPT 或 SoVITS 模型。
- 不把模型权重复制进项目、协作存储或 template package。
- 不提供远程 GPT-SoVITS 服务认证、上传或多租户队列。
- 不提供批量 dialogue generation；第一阶段每次只生成一条候选。
- 不自动修改 dialogue duration。
- 不在 template 中执行任意 JavaScript、Python、renderer 或 plugin code。
- 不在第一阶段实时协作 project voice profile 和 reference library metadata。

## Implementation Alignment

本 ADR 的应用与持久化架构已实现：

1. renderer-neutral voice types/rules、Electron Adapters 和 `VoiceAuthoringService` 已建立。
2. user voice library、受限 catalog、托管参考音频和 CRUD 已实现。
3. modal workbench、dialogue/free-text 双模式、candidate cache、preview、seed 与单任务生成已实现。
4. candidate 采用已经过 `ProjectResourceService` 与 semantic statement authoring，提交失败会清理新资源。
5. project profile、角色 `voiceProfileId`、本机模型缺失状态和 template character 物化已实现。
6. `TemplatePackageCatalog` 是统一 package owner；typed `voiceProfiles`、package-local JSON 和 managed user publishing 已实现。
7. 定向 seam tests、完整 `npm test`、`npm run build` 与 `git diff --check` 已通过。

尚未在本 ADR 的实现变更中完成真实 GPT-SoVITS 权重切换、生成音频、Electron 试听、scene playback 和 export playback 的人工验证。该项仍是发布前运行时验收要求；不能用 unit test 或构建成功替代。

架构 guard 继续阻止 voice UI 直接导入 Electron/Node、DocumentAdapter、可写 Store，并阻止 portable schema 接受绝对路径。
