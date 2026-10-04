# 模板系统

AeonStagery 模板是 JSON manifest 包。一个模板包可以提供可复用的编排组合、角色预设、对白样式、视觉预设、资产和项目默认值。

本文描述当前已实现的契约。架构决策见 `docs/ksm-adr/ksm-0001-unified-template-system.md` 与 `docs/ksm-adr/ksm-0003-semantic-scene-statements.md`；延期产品工作记录在 `docs/ksm-adr/TODO.md`。

## 第一版范围

模板系统第一版覆盖以下流程：

- 发现内置、项目内和外部素材库中的模板包。
- 在创建项目时和打开项目后启用、排序模板包。
- 支持在项目主页（`ProjectHome`）与设置弹窗（`SettingsDialog`“项目模板”页签）直接导入模板 ZIP 压缩包。
- 只合并已启用模板包，并按 `project > user > builtin` 与启用顺序处理优先级。
- 解析模板建议默认值，并允许用户覆盖。
- 将解析后的对白样式物化到新建 semantic statements；延期的相机与光照预设选择器已从配置界面中省略，避免暴露未指派的运行时能力。
- 创建项目时选择初始角色预设与服装导入模式。
- 打开项目后把选中的模板角色导入当前场景（写入当前 `SceneDocumentV5` 场景）。
- 应用角色预设时把选中的 Live2D 模型资产复制进项目。
- 在时间轴插入菜单中展示模板编排组合，并显示来源信息。
- 在设置弹窗“项目模板”页签中直接新建和编辑 AI 表演模板，包括角色 ID、别名、Motion 与 Expression 语义。模板 ID、表演配置 ID 与配置名称由系统管理，不在编辑页展示。

表演模板先按角色 ID 精确匹配场景角色，ID 不一致时，用模板别名精确匹配场景角色名称。别名匹配会统一全半角、忽略首尾空格与大小写，不做模糊匹配。旧表演模板中的 `canonicalName` 在加载时转为别名；新保存的数据仅使用角色 ID 与别名。

打开项目后，编辑页根据当前剧本角色与已启用的模板显示“已匹配：角色名”“未匹配”或“匹配冲突”。修改角色 ID 或别名时立即更新结果。同一剧本角色命中多个同级候选，或一个模板角色对应多个剧本角色，均显示匹配冲突。

延期能力记录在 `docs/ksm-adr/TODO.md`。

## 包布局

产品模板清单使用 schema v2，内置模板位于 `src/templates/default/manifest.v2.json`。

命名上有意保持不对称：

- `src/templates/` 使用复数，因为它是随应用分发的模板包集合。
- 项目和外部素材库内使用单数 `template/`，因为它复用现有项目资产根 `assetRoots.template = "template"`。

项目和用户模板从素材库根目录发现：

```text
<project root>/template/<package>/manifest.v2.json
<external library root>/template/<package>/manifest.v2.json
```

`<root>/template/manifest.v2.json` 也被接受，表示模板包直接以 `template/` 为根。普通发现流程不会加载旧的 `manifest.json`；旧清单仅用于显式迁移：

```bash
npm run migrate:template-v2 -- /path/to/template/package
```

该命令在包根生成 `manifest.v2.json`，保留旧清单作为迁移输入。Web 应用或 WebGAL 包顶层的同名 PWA `manifest.json` 不是 AeonStagery 模板清单。

发现阶段按根目录分配 scope：

- `project`：当前项目 `template/` 目录下的包。
- `user`：外部素材库根目录下的包。
- `builtin`：随应用分发的包。

## 优先级

如果存在项目模板配置，合并视图只包含 `templates.enabledTemplateIds` 中列出的包。启用包随后按以下优先级合并：

```text
project > user > builtin
```

同一 scope 内由项目 metadata 控制启用顺序：

```json
{
  "templates": {
    "enabledTemplateIds": ["mygo", "mujica"]
  }
}
```

后面的条目优先级更高。因此当 `mygo` 和 `mujica` 定义了同一个记录 id 时，`mujica` 会覆盖 `mygo`。

桌面应用把应用随附或普通外部模板的编辑写入本机统一模板库；项目目录中的模板直接写回项目包。同一模板 ID 的本机版本会覆盖应用随附或普通外部素材库中的版本，项目模板仍保持最高优先级。界面只显示一个合并后的模板，不区分“内置模板”和“用户模板”。

## Manifest 格式

Manifest 使用 JSON。必填字段：

```json
{
  "manifestSchemaVersion": 2,
  "template": {
    "id": "mujica",
    "name": "Ave Mujica",
    "version": "1.0.0",
    "compatibility": {
      "sceneSchemaVersion": 5
    }
  }
}
```

Manifest schema 保持为 v2（`manifest.v2.json`），但同时支持 scene schema 4 与 5 的 payload。无论包内声明为 4 还是 5，装载后均由语义转换与验证链路物化为当前激活的 `SceneDocumentV5` 事实。

支持的顶层能力字段：

- `defaults`
- `assets.index`
- `characterPresets`
- `authoringCombos`
- `dialogueStyles`
- `performanceProfiles`
- `visualRecipes`
- `sceneBlueprints`
- `lightingPresets`
- `environmentPresets`
- `cameraPresets`
- `textLayerStyles`
- `audioPresets`
- `exportPresets`

每个可合并记录都必须有稳定的字符串 `id`。通用 preset 会保留未知字段，因此 UI 和运行时适配器可以在不先修改 loader 的情况下演进。

## 图片对话框样式

`glass`、`minimal`、`classic` 仍是软件内置 renderer。模板若只需要替换对话框和人名框 UI，应使用受控的 `image-dialogue-v1`，不应携带 CSS、TSX 或可执行脚本。

模板包推荐统一使用复数目录 `assets/`：对话框图片放在 `assets/ui/dialogue/`，字体放在 `assets/fonts/`。manifest 中的路径相对于 `assets.root`，因此写成 `ui/dialogue/textbox.png` 和 `fonts/dialogue.ttf`：

```json
{
  "assets": { "root": "assets" },
  "defaults": { "dialogueStyleId": "my-theme.dialogue" },
  "dialogueStyles": [{
    "id": "my-theme.dialogue",
    "name": "My Theme Dialogue",
    "renderer": "image-dialogue-v1",
    "params": {
      "textbox": {
        "image": "ui/dialogue/textbox.png",
        "nineSlice": [48, 48, 48, 48],
        "x": 120, "y": 760, "width": 1680, "minHeight": 240
      },
      "namebox": {
        "image": "ui/dialogue/namebox.png",
        "nineSlice": [24, 24, 24, 24],
        "x": 160, "y": 690, "width": 320, "height": 88
      },
      "text": {
        "fontFile": "fonts/dialogue.ttf",
        "fontFamily": "My Theme Dialogue",
        "fontSize": 46,
        "x": 190, "y": 820, "maxWidth": 1500
      },
      "speaker": {
        "fontFamily": "My Theme Dialogue",
        "fontSize": 40,
        "color": "$characterColor"
      }
    }
  }]
}
```

`nineSlice` 顺序为左、上、右、下；省略时图片会作为普通 Sprite 缩放。配置保存后，图片和字体会复制到项目资产，解析后的 presentation 默认应用到以后新建的对白。已有对白不会因模板更新或禁用而自动换皮，但可在选中对白后的 Inspector 中通过“对话框样式”手动切换。`fontFile` 存在时必须同时声明稳定的 `fontFamily`。

## 角色

角色预设支持一个角色绑定多个模型变体。这是表达多套服装、模型版本或不同 Live2D 文件的推荐结构：

```json
{
  "characterPresets": [
    {
      "id": "tomori",
      "name": "Tomori",
      "speakerColor": "#8db7ff",
      "variants": [
        {
          "id": "school",
          "name": "School Uniform",
          "model": "assets/characters/tomori/school.model3.json"
        },
        {
          "id": "stage",
          "name": "Stage Outfit",
          "model": "assets/characters/tomori/stage.model3.json"
        }
      ]
    }
  ]
}
```

创建项目时选中角色预设后，它会写入初始场景的 `meta.characters`。如果预设没有显式 `model`，第一个 variant 会成为角色默认 `model`，所有 variants 会保留为角色的 `variants`。

创建项目时会把选中角色的模型文件导入新项目。对于 Live2D 模型，导入器会复制模型 JSON 和引用的 bundle 依赖，因此初始场景运行时不会依赖原始模板包路径。

## 在文件资源中使用模板资源

资源浏览器的“文件”页和底部“文件资源”列表会显示当前项目启用模板中的资源，并标注“模板：名称”。模型归入 `figure/`，背景、音乐、语音、音效、图片和动画分别归入对应分类，保留包内目录层级。入口来自 `assets.index`、`resourceConventions` 及角色预设的模型和全部变体；索引路径相对于 `assets.root`（默认 `assets`），角色预设模型路径沿用相对于模板包根目录的规则。

文件列表只显示可用入口，不独立展示模型的贴图、动作、表情等依赖。选取资源或将其拖到时间轴时，资源会复制到项目；模型会一并复制完整依赖，场景保存项目相对路径。切换项目或调整启用模板后列表自动刷新，也可以点击“刷新文件资源”重新扫描。禁用模板不会删除已导入项目的文件。

## 编排组合

编排组合会成为可插入的时间轴模板。schema v2 使用语义场景 `payload`，也可以引用包含 `payload` 的包内 JSON 文件：

```json
{
  "authoringCombos": [
    {
      "id": "dialogue_push",
      "name": "Dialogue Push",
      "category": "dialogue",
      "payload": {
        "kind": "timelineFragment",
        "statements": [
          {
            "type": "camera",
            "params": {
              "mode": "move",
              "zoom": { "kind": "delta", "value": 0.25 },
              "durationSeconds": 1.2
            }
          },
          {
            "type": "dialogue",
            "params": { "text": "Dialogue", "durationSeconds": 3 }
          }
        ]
      }
    }
  ]
}
```

只有包含合法语义 `payload` 的 combo 会暴露为时间轴模板。旧 `actions` 结构只能通过迁移命令转换，不能进入产品发现路径。

## 资产

模板资产用包相对路径索引：

```json
{
  "assets": {
    "root": "assets",
    "index": [
      {
        "id": "mujica_logo",
        "kind": "image",
        "label": "Mujica Logo",
        "path": "assets/logo.png"
      }
    ]
  }
}
```

资产解析会拒绝逃逸模板包根目录的路径。

## 项目 Metadata

模板包可以建议项目默认值：

```json
{
  "defaults": {
    "dialogueStyleId": "glass"
  }
}
```

默认值解析顺序：

```text
内置默认值 -> 已启用模板默认值（按优先级） -> 用户覆盖值
```

`project.json` 只保存启用模板、选中的能力和用户覆盖值：

```json
{
  "templates": {
    "enabledTemplateIds": ["aeonstagery.default"],
    "defaults": {},
    "selectedCharacterPresetIds": []
  }
}
```

如果用户手动修改某个默认 selector，该值会保存到 `templates.defaults`，后续模板变化不会静默覆盖它。

支持的默认 selector：

- `dialogueStyleId`
- `lightingPresetId`
- `environmentPresetId`
- `cameraPresetId`
- `textLayerStyleId`
- `audioPresetId`
- `exportPresetId`

打开缺少 `templates` 的旧项目时，会规范化为内置默认配置。

## 当前 UI 集成

时间轴空白处菜单通过 `TimelineAuthoringService.getAvailableTemplates()` 读取编排组合。该服务会在项目根或外部素材库根变化时刷新模板发现结果。

项目创建界面是全屏 onboarding surface（`ProjectHome`）。主创建页处理项目名、位置、模板包启用和排序，并提供直接导入模板 ZIP 压缩包的入口。用户可以从该页进入独立的 Template Capability Config 配置能力级选项。

当前 Template Capability Config 支持初始角色选择与服装导入方式（快速导入仅默认服装 vs 完整导入全部服装）。创建项目时，它会把选中的 preset id 写入 `selectedCharacterPresetIds`，播种初始场景角色目录，并把选中的角色资产导入新项目。

Template Capability Config 暴露默认对白样式选择器。显示值由内置默认、最高优先级的启用模板默认值和用户覆盖值解析而来。UI 会展示值的来源：内置、模板或用户覆盖，并允许用户重置回模板默认值。延期的相机和光照预设选择器已从配置界面中省略，避免向用户暴露尚未指派运行时能力的选项。

在已打开项目中，顶栏交互保持精简，模板配置收归至全局设置弹窗（`SettingsDialog`）的「项目模板」(`templates`) 页签。在该页签中，用户可以：
1. 导入新的模板 ZIP 压缩包（直接安装到本机专用模板库并即时刷新发现列表）；
2. 调整当前项目的模板包启用状态与优先级顺序；
3. 配置默认对白样式与角色导入选项，并支持一键将选中的模板角色导入当前场景（自动复制模型资产、保留 variants，并写入当前 `SceneDocumentV5` 场景）；
4. 在下方独立编辑 AI 表演模板与画像配置（`TemplatePerformanceProfileEditor`）。

Scene blueprint、模板资产应用、环境、文字、音频和导出 preset 应用已经体现在 manifest 与项目 metadata 合同中，但其用户可见应用流程仍延期。

## 实现入口

- Manifest 解析：`src/services/template-package/TemplatePackageManifest.ts`
- 包加载和合并优先级：`src/services/template-package/TemplatePackageLoader.ts`
- 包发现：`src/services/template-package/TemplatePackageDiscovery.ts`
- 项目 metadata：`src/api/types/project.ts`
- 项目创建持久化：`src/services/io/ProjectResourceService.ts`
- 编排 registry 集成：`src/services/timeline-authoring/TimelineAuthoringService.ts`
- 时间轴模板 UI 入口：`src/ui/StatementBlockLibrary.tsx`

## 语音配置

统一 template package 可以声明 `voiceProfiles[]`，`characterPresets[]` 通过 `voiceProfileId` 选择角色默认音色。模型只能使用 `fileName` 和可选 `relativePathSuffix` 组成的逻辑 selector；参考音频必须使用 `assets.index` 中的稳定 asset ID。

```json
{
  "assets": {
    "index": [
      { "id": "voice.tomori.primary", "path": "voice/tomori.wav", "kind": "audio" }
    ]
  },
  "voiceProfiles": [
    {
      "id": "voice.tomori",
      "name": "Tomori",
      "gptModel": { "fileName": "tomori.ckpt" },
      "sovitsModel": { "fileName": "tomori.pth" },
      "references": [
        {
          "id": "primary",
          "label": "Primary",
          "assetId": "voice.tomori.primary",
          "role": "primary",
          "promptText": "示例文本",
          "promptLang": "zh"
        }
      ],
      "inferenceDefaults": { "textLang": "zh", "speed": 1 }
    }
  ],
  "characterPresets": [
    { "id": "tomori", "name": "Tomori", "model": "characters/tomori.model3.json", "voiceProfileId": "voice.tomori" }
  ]
}
```

复杂配置可以通过 `file` 指向 package-local JSON。Loader 仍会校验模型 selector、参考项以及 asset ID；不允许绝对路径或可执行脚本。应用模板角色时，参考音频复制到 `vocal/reference/`，配置物化为项目 voice profile，scene 只保存项目 profile ID。
