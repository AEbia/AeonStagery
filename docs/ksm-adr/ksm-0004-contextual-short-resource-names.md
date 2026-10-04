---
status: draft
last_verified: 2026-07-29
implementation_status: first-version-core-complete-coverage-and-hardening-in-progress
---

# Contextual Short Resource Names

AeonStagery 当前在 scene、角色目录和模板 manifest 中直接保存模型、背景、音频等文件路径。完整路径能够精确定位文件，但用户必须反复理解项目目录、模板包目录和 Live2D bundle 结构；同一角色的不同模型也难以自然共享 motion、expression 等表演资源。统一模板系统已经定义模板来源、启用顺序和 asset id，但仅靠 `assets.index` 逐项枚举大型社区资源包会产生明显维护负担。

短资源名应当减轻用户对路径和默认上下文的负担。调用处已经知道资源字段类型，角色语句通常已经知道目标角色，对话也已经知道说话人，因此不应要求用户重复填写 `live2d/anon/motions/idle01.motion3.json`。同时，短名不能依赖不可解释的扫描顺序，也不能因为模板顺序变化而在用户不知情时切换到另一个文件。

KSM-0003 已经实现 `SceneDocumentV2 -> CompiledScene -> PreparedCompiledScene` 单向管线。`SceneStatementCompiler` 必须是无文件系统、无模板优先级依赖的确定性 lowering；项目路径到 runtime URI 的转换属于 `RuntimeAssetPreparer`。本 ADR 在该边界上固定短资源名的 authoring 语义，不把环境相关解析重新塞回 compiler，也不承诺第一阶段同时完成所有 Live2D runtime 的外部 motion/expression 注入。

## Decision

引入上下文感知的短资源名和统一 `ResourceAuthoringResolver`。资源字段向 resolver 提供 `kind`，semantic authoring intent/scope 提供可用的角色、outfit、插入时间和启用模板视图；用户只填写无法可靠推导的部分。完整路径继续受支持，并可以显式绕过短名查询。

管线固定为：

```text
ShortResourceInput / full path
  -> ResourceAuthoringResolver (context completion, lookup, conflict selection)
  -> projectize or materialize stable project-relative reference
  -> SemanticAuthoringApplicationService / SceneStatementFactory
SceneDocumentV2
  -> SceneStatementCompiler (opaque reference pass-through; no I/O)
CompiledScene
  -> RuntimeAssetPreparer (project reference -> PreparedAssetRef/runtimeUri)
PreparedCompiledScene
  -> preview / seek / bake / export
```

短名输入采用以下紧凑语法：

```text
[namespace@][owner:]name
```

示例：

```text
idle01                    # 当前目标角色的 motion
soyo:idle01               # 使用 soyo 资源集中的 motion
mygo@soyo:idle01          # 使用 mygo 模板中 soyo 的 motion

school_winter             # 当前角色的模型 outfit
soyo:school_winter        # soyo 的模型 outfit
mygo@soyo:school_winter   # 指定模板、角色和 outfit

classroom                 # background 字段中的背景短名
mygo@classroom            # 指定模板中的背景
```

`namespace` 是稳定的模板 package id 或项目资源命名空间，不是模板显示名；`owner` 在第一阶段主要是角色 id。冒号不表示“把动作施加给谁”，动作的实际 target 仍由语句中的角色目标决定。例如目标为 `anon` 的 `characterPerformance` 使用 `soyo:idle01`，表示把 soyo 资源集中的动作应用给 anon。

解析器内部必须将输入标准化为结构化 key，而不是让各 UI 和 runtime 自行切字符串：

```ts
interface ResourceKey {
  kind: ResourceKind;
  name: string;
  namespace?: string;
  ownerId?: string;
  outfitId?: string;
}
```

短语法首先是 authoring input，不是 compiler 指令。资源选择器和 Raw Script authoring adapter 可以接受紧凑字符串，但在提交 semantic mutation 前必须解析并 materialize；`SceneStatementCompiler` 只验证/透传 source 中已经稳定的 portable reference，不能再次查询模板、目录或外部库。资源选择器向用户显示短形式，同时显示解析到的来源、模板和实际文件。

### Picker-First Presentation

产品 UI 以资源选择器为主，不要求普通用户手写短名。短名系统首先是资源发现、索引、上下文补全和稳定身份机制；紧凑语法主要用于 Raw Script、模板编写、诊断、复制粘贴和可选的高级搜索。搜索器和分类器必须查询结构化的 `kind`、`namespace`、`ownerId`、`outfitId`、alias 和兼容性 metadata，不能靠 UI 重新拆分字符串。

选择器中的资源标题使用“当前上下文中最短且无歧义”的显示形式：

- 资源 owner 等于选择器当前主要角色时，只显示 `idle01`。
- 跨角色资源显示 `soyo:idle01`；owner 只表示资源所属，不修改 statement target。
- namespace 默认不进入主标题；只有同一 owner/name 存在实际来源冲突时，才显示 `mygo@soyo:idle01`。
- outfit、模板来源、runtime family 和兼容性作为副标签或详情显示，不继续塞入紧凑语法。
- 离开选择器分组上下文后，Inspector 中的已选跨角色资源仍必须显示 owner；namespace 仍只在冲突时进入主文字，完整 identity 始终可在 tooltip/详情中查看。

一级资源列表默认聚焦当前 target/owner 和活动 outfit；“其他角色”二级列表按 owner 分组展示可复用资源。跨角色选择的确认区必须明确显示“将 Soyo 的 idle01 应用于 Anon”，并在 KSM-0005 完成后显示兼容报告。普通搜索框主要匹配 name、alias 和显示名；namespace、owner、outfit、格式和兼容性优先使用独立 filter/chip，可另外支持 `owner:soyo namespace:mygo idle` 这类可选高级查询。

当前 scene schema 继续保存 project-relative path string。模板或外部库资源在 statement 创建前通过现有资源管线复制/projectize；因此模板启用顺序变化不会改变已有 source document。未来若确有不复制模板资产、并让 scene JSON 长期保存 namespaced short ref 的需求，必须在新的 scene schema version 中增加显式 `PortableResourceRef` discriminated union，并同步扩展 codec、compiler、协作和 runtime preparation；不能在 v3 普通 string 中加入环境相关隐式语义。

## Context Completion

允许省略的信息由调用位置严格决定，不能由全局“最近使用角色”一类隐式状态猜测：

| 省略项 | 可用上下文 | 无上下文时 |
|---|---|---|
| 资源类型 | 参数 schema，例如 motion、background、voice | 拒绝解析 |
| 角色 owner | `characterPerformance.target`、`characterPresence.id`、对话 `$speaker` | 要求 `owner:name` |
| outfit | authoring service 从该语句时刻之前的 semantic character presence/model facts 推导；模型选择时由选择器 scope 提供 | 先查角色公共资源；仍有歧义则要求选择 |
| 模板 namespace | 当前项目已启用模板和项目资源视图 | 按优先级解析；发生冲突时要求确认 |
| 扩展名 | 资源类型允许的入口文件列表 | 多个候选时报歧义 |

时间上下文中的活动 outfit 必须由 `SceneDocumentV2` 的 canonical statements 确定性投影得到。编辑器光标、当前选中角色和上一次选择只用于预填 authoring intent，不能参与 statement 保存后的编译或运行时解析。

用户从冲突候选中明确选择某个模板资源后，authoring receipt 应记录输入、选中 namespace、源文件和 materialized project path；statement 保存 materialized project path。UI 可以继续把它显示为 `mygo@classroom`，但 source v3 不依赖当前模板顺序。对于尚未提交的 draft，namespace qualifier 用于消歧；对于已经提交的 statement，项目路径是事实。

## Standard Conventions

第一版标准 Live2D 目录约定为：

```text
live2d/{character}/models/{outfit}/{model-entrypoint}
live2d/{character}/motions/{motion-entrypoint}
live2d/{character}/expressions/{expression-entrypoint}
```

模型入口和角色公共动作文件使用受资源类型约束的候选名，而不是把复合扩展名当作普通 `{ext}`。模型 JSON 中声明的 motion/expression 属于该 outfit 的内置表演资源；独立角色目录用于多个 outfit 共用：

```text
model.json
model.model3.json
model.wmdl

{name}.mtn
{name}.motion3.json

{name}.exp.json
{name}.exp3.json
```

实现可以接受经过验证的其他 Live2D 模型入口文件名，但同一短 key 匹配多个入口时必须报告歧义。模型纹理、physics、pose 和模型 JSON 已引用的内部文件属于 bundle 闭包，不作为普通可调用短资源暴露。

逻辑目录名不强制项目立即把现有 `figure`、`background` 等 asset root 迁移到物理 `assets/` 目录。resolver 通过 `ProjectMetadata.assetRoots` 和模板 `assets.root` 把逻辑 convention 映射到实际根目录；短引用不应绑定某一代项目目录布局。

除 Live2D 外，优先支持以下短资源类型：

| Kind | 示例 | 价值与阶段 |
|---|---|---|
| `live2dModel` | `soyo:school_winter` | 第一阶段；角色/outfit 选择最频繁 |
| `background` / `image` / `icon` | `mygo@classroom` | 第一阶段；路径规则简单、用户收益明显 |
| `bgm` / `sfx` / `voice` | `daily`, `soyo:line_001` | 第一阶段；字段类型和角色上下文明确 |
| `live2dMotion` / `live2dExpression` | `idle01`, `soyo:smile` | 第二阶段；需要 runtime 注册与兼容校验 |
| `animation` | `character_enter_left` | 后续；先明确声明式动画格式 |
| `font` / `lut` / `mask` | `source_han_sans`, `dusk` | 后续；由对应视觉系统接入 |

镜头、光照、缓动和入退场定义是 preset，不是文件资产。它们可以复用 namespace 和冲突诊断基础设施，但应由 `PresetResolver` 解析，不能因为也有短 id 就混入 `ResourceKind`。

## Template-Defined Conventions

产品模板路径已经切换到 `manifest.v2.json`。模板可以在 manifest v2 中声明自己的 package-local 路径约定，以便不重排既有社区资源包。规则是声明式候选 pattern，不允许模板提供 resolver JavaScript：

```json
{
  "manifestSchemaVersion": 2,
  "template": {
    "id": "mygo",
    "name": "MyGO",
    "version": "1.0.0",
    "compatibility": { "sceneSchemaVersion": 2 }
  },
  "resourceConventions": {
    "live2dModel": {
      "patterns": [
        "live2d/{character}/models/{outfit}/{entrypoint}",
        "figure/{character}/{outfit}/{entrypoint}"
      ],
      "entrypoints": ["model.json", "model.model3.json", "model.wmdl"]
    },
    "live2dMotion": {
      "patterns": [
        "live2d/{character}/motions/{name}.{extension}"
      ],
      "extensions": ["mtn", "motion3.json"]
    }
  }
}
```

模板规则必须满足：

- 只允许每种 `ResourceKind` 预先定义的占位符。
- 解析范围不能离开模板 package root，禁止绝对路径和 `..`。
- 规则只影响声明它的模板 namespace，不能重定义项目或其他模板的规则。
- `assets.index` 中的显式声明和 alias 优先于约定发现，用于处理异常目录和稳定重命名。
- 不按文件系统返回顺序决定结果；同一优先级多个候选必须形成可诊断冲突。
- 扫描结果应在模板加载时建立只读索引并缓存，不能在每帧或每次 runtime action 中遍历目录。
- `resourceConventions` 由 manifest v2 parser 校验并进入 `TemplatePackageCatalog`；`manifest.json` 只用于显式 legacy migration，不能重新进入产品发现路径。

## Resolution and Precedence

authoring lookup 按以下边界处理：

1. 显式完整路径按现有 `ProjectResourceService` 规则读取并 projectize，不套用短名优先级。
2. 带 namespace 的短名只在该 namespace 中解析。
3. 不带 namespace 的短名依次查询项目资源和启用模板合并视图；模板间继续遵守 KSM-0001 的显式顺序与 `project > user > builtin` scope 优先级。
4. 单个 namespace 内按显式 asset entry、alias、outfit override、角色公共 convention、标准 fallback convention 的顺序解析。
5. 找不到、扩展名不支持或同级多匹配都返回结构化诊断，不能悄悄退化为猜测路径。

`ResourceAuthoringResolver` 返回候选与诊断，不直接修改 document。用户确认后由 `SemanticAuthoringApplicationService` 以单次 mutation/receipt 写入 materialized project reference；失败时不产生半条 statement。完整绝对路径可用于选择资源，但进入 scene v3 前必须 projectize。协作资产收集、保存和导出只消费 source/compiled 中的稳定项目引用，不重新扫描模板。

`RuntimeAssetPreparer` 不重复执行上述优先级。它只把 compiler 透传的稳定 reference 转换为新的 deep-immutable `PreparedAssetRef`。现有按参数名猜测 `file/image/model/voice/animation` 的实现应逐步改成由 `SceneStatementDefinitionRegistry` 声明 typed asset slots，短资源系统不能再增加一套散落的字段名清单。

## Live2D Compatibility Boundary

当前 runtime 的 `playMotion` 和 `setExpression` 使用活动模型 JSON 已注册的 group/name。发现 `live2d/{character}/motions/` 下的独立文件并不等于 runtime 已能播放它。第二阶段需要建立 runtime-neutral 的外部表演资源 registry，再分别适配 Cubism 2、Cubism 3+ 和 WMDL。

跨 outfit 或跨角色复用还必须验证：

- runtime family 和文件格式兼容；
- 目标模型包含动作或表情需要的参数 id；
- 必要时声明允许的角色、模型或参数集合；
- 不兼容 runtime 应拒绝，部分参数缺失应在 UI 和 validation daemon 中给出可见警告。

因此 `soyo:idle01` 的语义可以在第一阶段固定，但在外部 motion registry 完成前，只有模型 JSON 已注册的同名动作可以直接执行。UI 不应展示“可用”却无法实际播放的 convention motion。

## Implementation Progress (2026-07-29)

- `ResourceKind`、`ResourceKey`、紧凑语法 parser、结构化诊断、确定性 `ResourceIndex` 和上下文 resolver 已实现。
- 项目中的模型、背景、图片、BGM、voice 和 JSON animation asset roots，以及模板 `assets.index`/alias 和受限 `resourceConventions` 扫描已进入统一索引；跨 namespace 同名候选保留到 picker 层消歧。
- 可信模板 package root 验证、项目物化、provenance receipt 和 semantic statement/character 原子应用入口已实现。
- `SceneStatementDefinitionRegistry` 已声明 typed source/compiled asset slots，`RuntimeAssetPreparer` 不再按 `file/image/model/voice/animation` 字段名猜测资产。
- 第一批 picker 已接入角色主/副模型和 semantic Inspector 的 model、background/image、BGM/SFX、voice 与 custom animation 字段；支持当前/其他角色分组、namespace 冲突显示、来源筛选和手动刷新。SFX 和 HTML custom animation 可以从文件视图或模板显式条目选择，但项目约定索引尚未自动发现这两类资源。
- authoring context projector 已从 canonical `characterPresence` facts 按语句时间推导活动 outfit；dialogue speaker、角色 target 和显式 picker outfit 均进入同一结构化 context。跨 owner 选择在提交前明确确认。
- 显式项目路径和已注册外部库绝对路径已进入统一 materialization/receipt 流程；外部引用以 copy 模式 projectize 后才写入 scene v3。
- KSM-0005 之前不把 convention motion/expression 标记为可播放；外部表演资源、参数兼容报告和 runtime registry 仍待下一 scene schema 实现。
- 项目约定索引尚未覆盖 icon、font、LUT、mask、独立 motion/expression、SFX 和 HTML animation；这些类型不能仅因已列入 `ResourceKind` 就视为第一版完整支持。
- 已完成项和加固/后续工作以可勾选清单维护在 [`TODO.md`](./TODO.md#ksm-0004-上下文短资源名)。

## Consequences

- 常见调用从完整路径缩短为 `idle01`、`school_winter` 或 `classroom`，资源类型、当前角色和活动 outfit 不再重复填写。
- `soyo:idle01` 明确表示资源 owner，不改变动作 target；模板冲突另由 `namespace@` 表达。
- 社区模板可以保留自己的目录布局，同时受 package root、安全占位符和歧义检查约束。
- 短名是 authoring identity；scene v3 持久化 materialized project path。资源重命名仍需要项目资源迁移工具同步改写 source references。
- resolver、资源选择器、validator、协作资产收集和导出必须共享同一解析结果，不能各自复制路径规则。
- 模板顺序只决定尚未提交输入的默认候选；authoring receipt 确认并 materialize 后，已有 statement 不会因优先级变化而静默换源。

## Implementation Order

1. 定义 `ResourceKind`、短名 parser、`ResourceKey`、结构化诊断和纯内存索引；用测试固定上下文补全、namespace、owner、歧义和路径逃逸规则。
2. 在 `ProjectResourceService`、`TemplateAssetResolver` 与 `TemplatePackageCatalog` 之上实现 `ResourceAuthoringResolver`，接入项目 asset roots、manifest v2 `assets.index` 和受限 `resourceConventions`。
3. 扩展 semantic authoring intent/receipt，使“选择短名 -> 确认候选 -> projectize -> 插入/更新 statement”成为原子操作；compiler 不增加 I/O。
4. 先接入 Live2D model/outfit、背景、图片和音频 picker，并让 source v3 保存 materialized project reference；这批功能不要求修改 Live2D motion runtime，能最早产生用户可见收益。
5. 让 `SceneStatementDefinitionRegistry` 成为 asset slot 的唯一事实来源，更新 `RuntimeAssetPreparer`、协作 manifest 和导出收集使用相同 slot metadata。
6. 按 KSM-0005 和新的 scene schema version 实现外部 Live2D motion/expression registry 与参数兼容验证，再启用角色公共动作与 `soyo:idle01` 跨角色调用。
7. 更新模板迁移 CLI、TODO 和中英文能力文档；旧 `manifest.json` 规则不进入产品 fallback。
