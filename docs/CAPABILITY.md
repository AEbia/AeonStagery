# AeonStagery 场景编排与引擎能力手册

AeonStagery 是一款面向视觉叙事与动画制作的交互式场景编辑器，支持由对白、角色、镜头、环境、音效与素材构成的多轨道时间线场景。无论你是场景编剧、演出导演、音频配音师还是素材协作者，都能通过直观的时间线与语义化语句（Semantic Statements）创作并交付高质量场景。

本手册采用实践导向的撰写风格，包含快速上手步骤、语义语句格式、参数说明、实用示例以及规则边界，方便创作者随时查阅与落地。

---

## 状态标识说明

在探索各项功能前，你可以通过以下状态了解当前引擎特性的可用程度与支持边界：

| 状态 | 含义与规划建议 |
| :--- | :--- |
| **当前支持** | 完整可用，已通过编译、预览、回放与数据契约验证，可放心投入生产。 |
| **部分支持** | 语义编辑或部分运行时已就绪，但生命周期、资源寻址、Seek 或导出仍有限制，建议单独验证。 |
| **延期规划** | 数据契约或界面结构已预留，但尚未向创作者开放完整的可用工作流。 |
| **废弃兼容** | 已淘汰的旧语句或操作，仅用于向后兼容加载和播放旧场景，不再作为新场景制作入口。 |
| **不支持** | 系统可识别或提示友好报错，但目前未提供可用运行时实现。 |
| **非目标** | 明确不属于当前产品的设计目标与功能范围。 |

---

## 快速上手：制作第一个可预览场景

如果你希望快速熟悉 AeonStagery 的基本操作流程，请遵循以下 6 个步骤制作你的首个短场景：

1. **准备项目与素材**：创建或选定项目目录，备好角色模型（Cubism 2.1）、背景图片、对白配音或动画文件。素材可以直接放在项目内，也可以使用本机素材库挂载（`@mount`）。
2. **新建或打开场景**：在项目管理器中新建项目（自动登记默认场景）或打开已有 `project.json`。
3. **放置角色与背景**：在场景时间轴的起点（0 秒）添加角色登场，并添加环境背景图层。
4. **编排对白与演出**：添加一条带有明确时长的对白，并为角色配置动作（Motion）或表情（Expression），或挂载镜头特写。
5. **资源校验 (Readiness)**：播放前检查资源引用是否有效。若使用了外部挂载 `@mount`，确保目标路径真实存在且可读。
6. **播放与预览**：点击播放控制器检查画面、声音、动作与时间节奏是否匹配，确认无误后即可进行场景烘焙或导出。

---

## 对白与旁白 (dialogue)

对白是场景叙事的核心骨架。AeonStagery 支持带有明确持续时间的角色台词、无角色绑定的旁白，并支持在对白下挂载一层伴随发生的附加演出（Companions）。

### 基础语法与示例

一条标准对白语句的典型结构如下：

```json
{
  "id": "line-01",
  "time": 0.6,
  "type": "dialogue",
  "params": {
    "speakerId": "hero",
    "text": "大家准备好了吗？我们马上出发！",
    "durationSeconds": 2.5
  },
  "companions": [
    {
      "id": "cam-focus-hero",
      "anchor": "start",
      "offset": 0,
      "type": "camera",
      "params": {
        "mode": "focus",
        "target": "$speaker",
        "durationSeconds": 0.8
      }
    }
  ]
}
```

### 核心参数说明

- `speakerId` *(string, 可选)*：说话人角色 ID。若省略或为空字符串，该行将作为**旁白**处理。
- `text` *(string)*：展示在文本框中的台词内容。
- `durationSeconds` *(number)*：对白的显式展示持续时长（以秒为单位）。
- `style` *(string, 可选)*：字幕文字效果，支持 `typewriter`（打字机）、`fadeIn`（淡入）、`cinematic`（电影式）和 `instant`（即时）；适用于内置与图片对话框，包括粉色名牌。
- `companions` *(array, 可选)*：附属在该对白上的伴随动作列表。支持挂载镜头特写（如 `$speaker` 对焦）、角色动作表情或提示音效。

对白音量、默认对白样式、文字速度、默认时长与文本框入场动画集中在“设置 → 对白”中。默认样式保存在项目中，只应用于新添加的对白；单句的字幕效果与对话框样式可在属性面板调整。文本框入场动画由本机的全局开关统一控制，关闭后文字仍按所选字幕效果展现。

### 需要注意的规则

- **时长必须显式指定**：系统在播放时不会临时猜测或推算台词停留时长，必须在参数中给出具体的 `durationSeconds`。
- **配音不隐式改写时长**：即使后续为该对白配置或生成了语音音频，系统也不会私下篡改已设定的 `durationSeconds`，需由创作者按需调整。
- **单层附加项约束**：Companions 仅支持单层挂载，不能无限嵌套；删除父级对白时，其所属的附加项会被一同清理，避免在时间线上残留无主的隐形表演。
- **自动对白镜头为延期能力**：当前不会根据文本或说话人全自动生成镜头切换，需由作者手动安排。

---

## Live2D 角色与表演 (Character & Performance)

**注意：由于使用 live2D 造成的任何版权纠纷，皆由二次创作者自行承担。**

AeonStagery 支持引入 Live2D 模型作为角色立绘，并提供精准的空间位移、姿态变换、动作表情触发以及底层参数曲线的自定义关键帧调节。

### 1. 角色登场与离场 (`characterPresence`)

用于声明角色何时进入舞台或从画面中退场：

```json
{
  "id": "hero-enter",
  "time": 0.0,
  "type": "characterPresence",
  "params": {
    "id": "hero",
    "mode": "enter",
    "model": "figure/hero/hero.model.json",
    "durationSeconds": 0.5
  }
}
```

- `id` *(string)*：角色在场景中的唯一身份 ID。
- `mode` *(string)*：`"enter"`（登场）或 `"exit"`（离场）。
- `model` *(string)*：Live2D 模型配置文件路径（项目相对路径或 `@mount` 路径）。
- `durationSeconds` *(number)*：淡入或过渡的时长。

### 2. 角色位置与空间变换 (`characterTransform`)

在时间线上对角色进行平移、缩放或旋转调度：

```json
{
  "id": "hero-move",
  "time": 1.2,
  "type": "characterTransform",
  "params": {
    "id": "hero",
    "position": [0.2, 0.0],
    "scale": 1.1,
    "rotation": 0,
    "durationSeconds": 0.8
  }
}
```

- 省略的变换字段将自动沿用角色先前的状态，无需重复声明未改变的参数。
- 该语句仅负责空间属性插值，不负责角色的加载或销毁。

### 3. 动作、表情与面部细节 (`characterPerformance`)

调度角色的肢体动作（Motion）、面部表情（Expression）、视线注视（LookAt）与眨眼（Blink）：

```json
{
  "id": "hero-perform",
  "time": 0.8,
  "type": "characterPerformance",
  "params": {
    "target": "hero",
    "motion": {
      "kind": "resource",
      "key": "motions/wave_hand.mtn",
      "fadeInSeconds": 0.3
    },
    "expression": "expressions/smile.exp.json",
    "lookAt": { "point": [0.5, 0.2], "enabled": true },
    "blink": { "enabled": true }
  }
}
```

### 4. 自定义动作关键帧编辑 (Custom Motion)

当你需要对 Live2D 动作的每个参数（Parameter）曲线进行逐帧修改或精确打点时，可将普通资源 Motion 转换为场景内联的自定义动作：

1. **发起转换**：在时间轴上选中已有动作片段，在右侧 Inspector 或菜单中点击“转为自定义动作”。
2. **选择采样密度**：根据需要选择采样精细度：
   - `sparse`（稀疏，适合粗略微调）
   - `standard`（标准，日常推荐）
   - `fine`（精细，捕捉细腻动作）
   - `frame`（逐帧，百分之百高保真采样）
3. **编辑关键帧**：展开时间轴下方的关键帧编辑器，在轨道视图、曲线视图或列表视图中框选并调整控制点的时间、数值与插值类型（贝塞尔、线性、阶梯等）。
4. **重新转换**：如果想放弃手调并重置回源动作，可选择“重新转换”并重新选择采样密度。

```json
{
  "kind": "custom",
  "durationSeconds": 2.0,
  "fadeInSeconds": 0.2,
  "derivedFrom": { "key": "motions/wave_hand.mtn" },
  "tracks": [
    {
      "parameterId": "PARAM_ANGLE_X",
      "keyframes": [
        {
          "time": 0.0,
          "value": 0.0,
          "segment": {
            "type": "bezier",
            "controlPoints": [
              { "time": 0.25, "value": 0.0 },
              { "time": 0.75, "value": 25.0 }
            ]
          }
        },
        { "time": 0.8, "value": 25.0 }
      ]
    }
  ]
}
```

### 需要注意的规则

> **注意：Live2D 模型版本边界**
> - **当前支持**：仅 **Cubism 2.1** 具备完整可用的运行时驱动、表情动作调度与关键帧编辑。
> - **不支持**：Cubism 3+/4+/5（`.model3.json`、`.moc3`）的关键帧编辑。

- **非破坏性内联转换**：转换自定义 Motion 后，关键帧数据直接内嵌保存在场景文件中，源 `.mtn` 文件不会被修改，播放时也不再强依赖源文件。
- **不支持从空白手绘**：目前不支持直接创建全新的空白 Custom Motion，必须基于已有的资源 Motion 转换派生。
- **转换不包含动态附加项**：呼吸（Breath）、眨眼（Blink）、口型（Lip-sync）及物理（Physics）运算属于运行时动态逻辑，不会被采样烘焙进关键帧。
- **重新转换覆盖提示**：执行“重新转换”会彻底替换当前轨道与关键帧的手工修改，请谨慎操作或通过 Undo 撤回。
- **多人协作独占租约**：在多人协作项目中，编辑某个自定义 Motion 会自动申请并持有该角色表演实体的编辑租约（Lease），其他协作者可实时查看和预览，但无法并发覆写该实体的表演属性。

---

## 镜头与环境控制 (Camera & Environment)

通过多景深镜头调度与图层环境变化，营造丰富的电影感镜头语言。

### 1. 镜头调度 (`camera`)

支持 6 种主流镜头模式，带平滑过渡与目标锁定：

```json
{
  "id": "cam-move",
  "time": 2.0,
  "type": "camera",
  "params": {
    "mode": "move",
    "position": [0.3, 0.1],
    "zoom": { "kind": "absolute", "value": 1.4 },
    "ease": "easeInOutCubic",
    "durationSeconds": 1.2
  }
}
```

- **模式列表**：
  - `focus`：聚焦到指定目标或角色（如 `target: "$speaker"` 或角色 ID）。
  - `move`：平移并调整缩放比例（Zoom）。
  - `follow`：镜头持续跟随目标移动，具备明确的启动与停止时间。
  - `path`：沿指定轨迹点平滑运动。
  - `shake`：产生屏幕震动或冲击波晃动效果。
  - `reset`：将镜头视角与缩放平滑重置为默认画面。

### 2. 环境图层管理 (`environmentLayer`)

通过图层叠放构建前景、中景与背景舞台：

```json
{
  "id": "bg-sunset",
  "time": 0.0,
  "type": "environmentLayer",
  "params": {
    "layerId": "bg-main",
    "mode": "set",
    "file": "bg/sunset_classroom.png",
    "z": -100,
    "opacity": 1.0,
    "durationSeconds": 0.8
  }
}
```

- `mode` 支持 `"set"`（创建或设置图层）、`"transform"`（图层变换/淡入淡出）与 `"remove"`（移除图层）。
- **规则**：执行变换或移除时，目标 `layerId` 必须指向已经存在或此前已创建的图层。

### 3. 视觉风格与光照 (`visualStyle` / `lighting`)

- **对象视觉风格 (`visualStyle`)**：作用于单个角色或物体本身的视觉属性，例如边缘光（Rim-light）、色调调和与融入度。
- **场景光照 (`lighting`)**：提供全局光照预设（Preset）、色彩覆盖层（Overlay）以及点光源（PointLight），具备独立的启停与调制生命周期。

### 需要注意的规则与兼容性提示

- **废弃的镜头滤镜 (`filterAdd`, `filterChange`, `filterReset`)**：旧版本滤镜语句仅保留回放与加载兼容性，新制作场景中不再提供入口，统一由 `visualStyle` 与 `lighting` 取代。
- **历史别名失效**：旧版环境别名（如 `background` alias）不再受支持，请显式通过 `environmentLayer` 指定图层。
- **退役语句**：希区柯克变焦（Hitchcock Zoom）与角色接地（Grounding）特殊语句已退役，可用标准镜头移动与缩放自由组合实现。

---

## 声音与素材管理 (Audio & Assets)

AeonStagery 对音频、图形图层与外部素材提供了规范化的引用机制与智能配音支持。

### 1. 素材引用形式：项目相对路径 vs 本机挂载 (`@mount`)

在项目中引入素材资源时，有两种推荐方式：

| 引用方式 | 语法示例 | 适用场景 | 协同与便携性 |
| :--- | :--- | :--- | :--- |
| **项目相对引用** | `audio/bgm01.mp3`<br>`bg/classroom.png` | 项目交付、长期存储、多人协作。 | **最高**。随项目目录一同打包和分发，开箱即用。 |
| **本机素材挂载** | `@mount/my-lib/sound/hit.wav`<br>`@mount/shared/bg.png` | 引用本机公共素材盘或个人素材库。 | **受限**。仅当前机器有效，更换设备需重新配置同名挂载点。 |

> **重要规则：协作前必须项目化 (Projectize)**
> 如果你的场景中引用了 `@mount` 外部素材，在将项目发布给协作者或提交前，必须在资源管理器中执行 **Projectize（项目化）** 操作。系统会将外部文件自动拷贝进项目目录并转为项目相对路径。未项目化的挂载引用会直接阻断协作发布。

### 2. 背景音乐与音效 (`audio`)

统一管理时间线上的 BGM 与具名音效实例：

```json
{
  "id": "sfx-bell",
  "time": 1.5,
  "type": "audio",
  "params": {
    "role": "sfx",
    "mode": "play",
    "instanceId": "bell-ring-01",
    "file": "audio/school_bell.wav",
    "volume": 0.8,
    "durationSeconds": 3.0
  }
}
```

- BGM 通过 `role: "bgm"` 搭配 `mode: "play"` 或 `mode: "stop"` 控制，并支持淡入淡出（fade）参数。
- 音效（SFX）拥有独立的 `instanceId`，可在重叠播放时精准控制特定实例的音量与淡出。

### 3. 图形与文字图层 (`graphicLayer`) — *[部分支持]*

允许在场景中叠加静态图片或动态排版文本：

```json
{
  "id": "title-text",
  "time": 0.5,
  "type": "graphicLayer",
  "params": {
    "kind": "text",
    "mode": "set",
    "id": "title-text-layer",
    "text": "第一幕：命运的交汇",
    "fontSize": 32,
    "color": "#ffffff",
    "durationSeconds": 4.0
  }
}
```

> **注意**：图形图层目前处于 **部分支持** 状态。图层的生命周期可在数据层正常表达，但运行时的平滑变换（Transform）、精确 Seek 寻道及烘焙导出的一致性尚未达到百分百保真，使用时建议在时间线上逐段测试效果。

### 4. 声明式与 HTML 动画 (`customAnimation`)

支持引入预制的动画组件或动效文件（如 HTML/CSS 动画、Lottie 等）并在时间线上触发：
- 必须具有明确的播放时长 `durationSeconds`。


### 5. GPT-SoVITS 智能配音生成

AeonStagery 内置了与本机 GPT-SoVITS 推理服务的深度集成，支持在创作台词时一键生成角色配音：

1. **配置环境**：确保本地已启动模型服务，并在项目或角色设置中选择 GPT 权重（`.ckpt`）、SoVITS 权重（`.pth`）、参考音频及 Prompt 文本。
2. **生成候选**：选中目标对白，点击“生成配音”，系统将向本地服务发送请求生成试听候选；可记录并复用 Seed 值以保持音色一致性。
3. **文本一致性检查**：若生成的候选文本与当前对白内容产生分歧，必须由创作者选择：
   - **“同步文本并应用”**：将台词同步修改为生成音频对应的文本，并绑定该音频。
   - **“仅保存到项目”**：将音频放入素材库备选，不覆盖当前对白文本。
4. **资源优先落地 (Projectize First)**：采用成功的配音时，系统会优先将生成的 WAV 文件落盘至项目的 `vocal/generated/` 相对路径中，随后再安全写入对白引用。

> **规则**：
> - 采用生成的语音**不会**自动改写对白的 `durationSeconds`，请根据实际试听体验调整显示时长。
> - 引擎仅负责本地推理调用与候选采纳，不包含模型训练、云端多租户与批量合成流水线（非目标）。

---

## 模板与预设系统 (Templates)

为了减少重复劳动，AeonStagery 支持通过模板包复用成熟的角色预设、对白样式组合与时间线片段。

### 模板包规范与导入

- 模板包格式为标准 ZIP 压缩包，内部包含 `manifest.v2.json`。
- 模板必须声明兼容 `schemaVersion: 5`（同时兼容 v4）。
- **导入与启用**：在项目主页或“全局设置 -> 项目模板”中导入 ZIP 包，并可自由启用、禁用或拖拽调整模板包的加载优先级。

### 模板插入机制：完全物化 (Materialization)

当你从模板库中将一个组合（如“登场镜头预设”、“争吵对话片段”）拖入时间轴时：
- 模板内容将**即刻展开并物化**为标准的 v5 语义语句。
- 场景中不会残留模板实例 ID 或外链依赖。即使日后删除了该模板包，已物化到时间线上的内容依然完整可用并可自由修改。

> **注意**：模板编辑器（Template Editor）、社区线上注册表（Community Registry）与场景蓝图（Scene Blueprint）目前属于 **延期规划** 能力。

---

## WebGAL 剧本导入 (WebGAL Import)

AeonStagery 提供了一键将现有 WebGAL 文本剧本（`.txt`）转换为单场景时间线脚手架的导入工具。

### 导入流程

1. **选择文件**：在导入界面选取 WebGAL `.txt` 脚本文件。
2. **关联素材**：若剧本中包含立绘与背景引用，指定对应的素材目录或本机挂载点。
3. **阅读速度与时长**：设置阅读语速预设（仅用于未匹配到真实语音时的台词时长估算；若检测到挂载的逐行语音文件，则自动以实际音频时长为准）。
4. **生成脚手架**：点击导入，系统将生成一份标准的 v5 场景草稿。
5. **查阅导入报告 (Report)**：导入完成后会自动弹出转换报告，展示成功转换的对白、角色与背景，并明确列出跳过的指令。

### 需要注意的规则

> **注意：单文件脚手架边界**
> WebGAL 导入旨在为场景演出创作提供一个**单文件、单场景的编辑起点（Scaffold）**，并非全功能的 Galgame 引擎重写迁移器。

- **自动转换的内容**：角色对白、旁白、立绘登场/退场/切换、背景变换、基础镜头对焦。
- **跳过与未支持的内容**：游戏玩法向的逻辑分支（`choose`）、全局/局部变量（`setVar`）、标签跳转（`jumpLabel`）、场景跳转（`changeScene` / `callScene`）以及背景音乐音效指令均会被跳过，并在报告的 `skipped/unsupported` 列表中清晰说明。

---

## 多人协同制作 (Collaboration)

AeonStagery 支持多位创作者在同一网络或局域网中联机协作编排场景。

### 协作连接架构

- **协议版本**：若客户端与服务端版本不匹配，连接将被拒绝。
- **连接方式**：支持主持新房间、主持本地已有剧本或输入服务器 地址 加入已有房间。

### 资源就绪检查 (Readiness & Blocking)

多人协作最常遇到的痛点是“你的电脑上有图，我的电脑上全是红叉”。AeonStagery 引入了发布前的强制校验机制：
1. **自动扫描**：主机在发布场景前，系统会自动扫描全部引用的资源是否存在、可读并计算 Hash/Size。
2. **拦截未项目化资源**：若引用了 `@mount` 本机私有素材，发布将被直接**阻断（Blocked）**，直至创作者将其一键 Projectize（复制到项目内）。
3. **安全同步**：协作者加入房间后，会自动下载缺失资源并进行内容哈希校验，校验完全通过后才会应用场景更新。

### 并发编辑租约 (Lease) 与感知 (Presence)

- **实时感知 (Presence)**：你可以实时看到协作者的光标位置、正在选中的轨道或正在浏览的时间段。
- **自定义动作独占租约 (Custom Motion Lease)**：为了避免多人同时修改复杂的 Live2D Parameter 曲线造成错乱，当某位协作者展开编辑自定义 Motion 时，服务器会自动为其分配租约锁定该角色表演实体。其他成员可保持播放与观察，直至编辑者退出并释放租约。
- **无全局共享撤销**：协同模式下不存在跨用户的全局 Undo，任何修改都作为新的时间线事实广播提交。

---

## 预览、播放、烘焙与导出 (Preview & Export)

为了确保创作者在编辑界面看到的效果与最终输出的成品高度吻合，AeonStagery 构建了统一的运行时准备机制（Prepared Runtime）。

### 播放器交互功能

在预览视窗中，创作者可随时使用以下控制能力检查演出细节：
- **逐帧步进 (Step Frame)**：逐帧前进或后退，精细核对动作与音效的打点对齐。
- **瞬时寻道 (Seek)**：拖拽播放指针任意跳转，引擎内置状态清理机制（ADR-0034）确保跳转后角色姿态与淡入淡出完全正确，杜绝状态残留。
- **A/B 循环测试**：设置循环起点与终点，反复打磨高潮段落的表演与镜头节奏。
- **倍速播放**：支持 0.5x 至 2.0x 变速播放排查顿挫。

### 场景烘焙与最终导出

- **场景烘焙 (Bake)**：将所有时间线引用编译并预加载为当前设备极速回放的静态缓存，用于流畅检视与高帧率验证。若烘焙报错，请优先排查素材完整性。
- **离线导出 (Export)**：支持将场景渲染导出为高清晰度视频或指定格式素材。
  - 导出配置需视本机硬件加速与编码器支持情况而定。
  - **重要提醒**：若场景中包含部分支持的“图形图层（GraphicLayer）”，请务必在导出后回放检查画面图层的一致性。

---

## 常见问题与故障排查 (FAQ)

遇到异常情况时，可对照下表快速自查与定位原因：

| 异常现象 | 核心检查点 | 解决方案与能力边界 |
| :--- | :--- | :--- |
| **画面出现红叉，提示 mount/file 无法读取** | 检查引用是相对路径还是 `@mount`，确认本机挂载点是否移动或未配置。 | 重新在设置中配置有效挂载路径，或直接执行 Projectize 将素材复制到项目内。 |
| **识别到了 `.model3.json`，但角色无法显示或报错** | 检查模型是 Cubism 2.1 还是 Cubism 3+/4+/5。 | 当前仅 **Cubism 2.1** 具备可用运行时。Cubism 3+ 当前仅作元数据识别，不可用于实际播放。 |
| **图片图层显示正常，但导出或 Seek 时位置/透明度异常** | 确认是否使用了图形图层复杂的连续 Transform 或移除。 | `graphicLayer` 目前属于部分支持能力，建议简化图层变换或在关键时间节点手动拆分图层。 |
| **WebGAL 导入后没有声音，部分分支选择消失** | 查看导入完成时弹出的 Report 转换报告。 | 单文件脚手架仅转换演出向事实。分支选择、变量计算与 BGM 属于明确的跳过项（非目标）。 |
| **GPT-SoVITS 语音生成失败，无可用候选** | 检查本地模型推理服务是否存活，模型权重、参考音频与 Prompt 是否完备。 | 修复本地服务环境后重试。生成失败不会产生残缺音频，引擎不提供云端批量代跑服务。 |
| **配音候选生成成功，但提示与对白文本不一致** | 检查试听候选识别出的文本与时间轴文本差异。 | 按需选择“同步文本并应用”或“仅保存到项目”。采用配音后请手动确认对白时长。 |
| **“转为自定义动作”按钮置灰或转换失败** | 确认目标角色为舞台上激活的 Cubism 2.1 模型，且动作中不仅含有 Parts 曲线。 | 确保模型加载正常后重试。目前不支持从空白或 Cubism 3+ 模型发起动作转换。 |
| **自定义动作提示被锁定，无法调整关键帧** | 检查协作面板中的成员状态。 | 另一位协作者正在编辑该角色动作并持有租约，等待对方退出编辑或租约释放即可。 |
| **协作房间点击“发布”提示被阻断** | 检查资源预检面板中列出的红项。 | 外部挂载文件尚未 Projectize，或本地文件存在校验缺失。一键项目化后即可通过验证。 |

---

## 语义语句与能力速查表

下表汇总了 AeonStagery 的 14 种核心语义语句族（Statement Families）与主要架构规划，可作为速查词典使用：

| 创作意图 | 语义语句 / 术语 | 状态 | 说明与限制 | 深入规范 |
| :--- | :--- | :--- | :--- | :--- |
| **角色或旁白台词** | `dialogue` | **当前支持** | 记录发言人、台词与明确时长；支持挂载单层 Companions，配音不篡改时长。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **角色登场或离场** | `characterPresence` | **当前支持** | 维护角色稳定身份与模型映射；仅限 Cubism 2.1 运行时。 | [ADR-0019](adr/0019-live2d-cubism-multiversion-runtime.md) |
| **角色位移/缩放/旋转** | `characterTransform` | **当前支持** | 平滑插值空间属性；未声明的参数自动继承；不处理登场销毁。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **角色肢体与面部表演** | `characterPerformance` | **当前支持** | 调度 Motion、Expression、注视与眨眼；需指定明确演出时长。 | [ADR-0019](adr/0019-live2d-cubism-multiversion-runtime.md) |
| **Live2D 关键帧曲线** | `kind: 'custom'` Motion | **当前支持** | 非破坏性生成内联副本；支持多轨道曲线微调；协作独占租约。 | [ADR-0029](adr/0029-live2d-custom-motion-keyframe-authoring.md) |
| **镜头景深与运镜** | `camera` | **当前支持** | 支持聚焦、移动、跟随、路径、震动与重置；具备启停时间。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **环境背景图层** | `environmentLayer` | **当前支持** | 图层添加、变换与移除；必须引用已存在的 Layer ID；旧别名已废弃。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **对象视觉融入与边缘光**| `visualStyle` | **当前支持** | 作用于单体对象的样式修饰，与全局滤镜严格区分。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **镜头滤镜添加** | `filterAdd` | **废弃兼容** | 历史遗留语句，仅用于播放兼容，不再提供新创作入口。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **镜头滤镜过渡** | `filterChange` | **废弃兼容** | 历史遗留语句，仅用于播放兼容，不再提供新创作入口。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **镜头滤镜重置** | `filterReset` | **废弃兼容** | 历史遗留语句，仅用于播放兼容，不再提供新创作入口。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **舞台光照系统** | `lighting` | **当前支持** | 独立管理光照预设、色彩覆盖与点光源。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **背景音乐与音效** | `audio` | **当前支持** | BGM 启停与独立音效实例重叠播放；时长与音量显式定义。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **图片与文字图层** | `graphicLayer` | **部分支持** | 数据层完整，但复杂 Transform、Seek 及导出一致性仍在迭代中。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **声明式动效与 HTML** | `customAnimation` | **当前支持** | 播放安全的预制动画文件；禁止运行任意外部不受信任代码。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **自动对白镜头生成** | `自动镜头调度` | **延期规划** | 暂未提供全自动文本语义推导镜头，需创作者手动配置。 | [KSM-0003](ksm-adr/ksm-0003-semantic-scene-statements.md) |
| **模板编辑器与社区中心**| `template editor / registry`| **延期规划** | 模板可视化编辑工具与线上分享仓库尚未开放完整工作流。 | [KSM-0001](ksm-adr/ksm-0001-unified-template-system.md) |
| **Cubism 3+/4+/5 运行时** | `Cubism 3+ Runtime` | **不支持** | 识别元数据不代表可用运行时，暂无预览及导出能力。 | [ADR-0019](adr/0019-live2d-cubism-multiversion-runtime.md) |
| **WebGAL 完整玩法迁移**| `完整 WebGAL Gameplay` | **非目标** | 仅提供单文件单场景演出脚手架，不迁移游戏引擎变量及分支逻辑。 | [ADR-0026](adr/0026-webgal-script-import-scaffolding-source.md) |
| **GPT-SoVITS 训练与托管** | `Voice Training / Cloud` | **非目标** | 仅支持本地已就绪模型的推理采纳，不承载模型训练与云端算力。 | [ADR-0020](adr/0020-gpt-sovits-voice-authoring.md) |
| **历史废弃别名与旧模板** | `Legacy alias / payload` | **不支持** | 统一采用规范化 v5 命名与结构，不再支持隐式模糊解析。 | [KSM-0001](ksm-adr/ksm-0001-unified-template-system.md) |

---

## 进阶参考与核心架构

日常创作时无需直接编辑底层数据文件，但了解以下核心概念有助于排查深度疑难或与技术人员对接：

### 核心名词术语

- **`SceneDocumentV5` (Source Schema)**：场景的数据源头，存储稳定的 ID、绝对秒数时间点与纯粹的意图参数。当前激活版本为 v5（系统加载时会自动将开发期 v3 与历史 v4 场景平滑升级至规范 v5）。
- **`Semantic Statement` (语义语句)**：将“角色登场”、“镜头平移”、“音效播放”等创作动作保存为时间线上一条独立的时间事实。
- **`Companion` (附加项)**：挂载于对白之下的一层附属事实（如台词触发时的特写或表情），严格受父级对白生命周期制约。
- **`Compiler` & `Prepared Runtime`**：场景编译器将抽象的语义意图翻译并解析为本机可读的准备态场景，供预览播放、烘焙与导出管线共享消费。
- **`Manifest v2`**：模板包的自述文件，规范声明模板兼容的场景版本、角色预设与资源索引。
- **`Wire v3`**：多人协同底层通讯协议，负责在网络中同步时间线变更，并严格校验场景 Schema 匹配性。

### 最小 v5 场景结构示意

以下精简 JSON 展示了“角色登场后，在第 0.6 秒说出台词并触发伴随特写”的数据形态：

```json
{
  "schemaVersion": 5,
  "sceneId": "demo-scene",
  "meta": {
    "title": "示例短场景",
    "resolution": [1920, 1080],
    "fps": 60,
    "durationSeconds": 4.2,
    "characters": [
      { "id": "hero", "name": "主角", "model": "figure/hero/hero.model.json" }
    ]
  },
  "statements": [
    {
      "id": "stmt-enter",
      "time": 0.0,
      "type": "characterPresence",
      "params": {
        "id": "hero",
        "mode": "enter",
        "model": "figure/hero/hero.model.json",
        "durationSeconds": 0.6
      }
    },
    {
      "id": "stmt-say",
      "time": 0.6,
      "type": "dialogue",
      "params": {
        "speakerId": "hero",
        "text": "一切准备就绪，我们出发吧！",
        "durationSeconds": 2.5
      },
      "companions": [
        {
          "id": "comp-cam-focus",
          "anchor": "start",
          "offset": 0,
          "type": "camera",
          "params": {
            "mode": "focus",
            "target": "$speaker",
            "durationSeconds": 0.8
          }
        }
      ]
    }
  ]
}
```

### 深入技术文档索引

如需查阅具体特性的技术实现细节与架构决策，请按 [CONTEXT.md](../CONTEXT.md) 与 [ADR freshness index](adr-status.md) 的索引参考下列权威文档：

- [KSM-0003：Semantic Scene Statements](ksm-adr/ksm-0003-semantic-scene-statements.md) — 语义语句族、Companions、编译与准备态管线。
- [KSM-0001：Unified Template System](ksm-adr/ksm-0001-unified-template-system.md) — 模板包 Manifest v2 规范、语义 Payload 与物化机制。
- [ADR-0018：协作与资源就绪检查](adr/0018-timeline-authoring-collaboration-resource-seams.md) — 协同资源边界、Projectize 项目化与阻断策略。
- [ADR-0019：Live2D/Cubism 运行时边界](adr/0019-live2d-cubism-multiversion-runtime.md) — Cubism 2.1 运行时适配与 3+ 占位符约束。
- [ADR-0020：GPT-SoVITS 语音生成集成](adr/0020-gpt-sovits-voice-authoring.md) — 候选生成、资源先行原则、文本同步机制与设计边界。
- [ADR-0021：外部素材库稳定挂载](adr/0021-stable-external-library-mount-references.md) — `@mount` 机制与跨设备项目化交付。
- [ADR-0026：WebGAL 剧本导入脚手架](adr/0026-webgal-script-import-scaffolding-source.md) — 单文件导入转换、时长估算与 Report 过滤机制。
- [ADR-0028：自定义 Motion 协同编辑租约](adr/0028-scoped-custom-motion-edit-lease.md) — 关键帧并发编辑权、租约生命周期与冲突裁决。
- [ADR-0029：Live2D 自定义 Motion 关键帧创作](adr/0029-live2d-custom-motion-keyframe-authoring.md) — 动作采样转换、曲线编辑与运行时求值。
- [ADR-0031：演进兼容政策](adr/0031-evolution-compatibility-policy.md) — Scene v5、Project Metadata v2、Wire v3 与自动迁移链路。
- [ADR-0032：崩溃界面与诊断报告体系](adr/0032-crash-screen-and-diagnostic-report-recovery.md) — 全栈分级捕获与脱敏恢复。
- [ADR-0033：Live2D 资源 Motion 曲线缓存与 Seek 统一](adr/0033-live2d-resource-motion-curve-cache-seek.md) — 逐帧曲线求值与 Seek 缓存优化。
- [ADR-0034：Live2D 运行时状态清理与淡入来源权威](adr/0034-live2d-runtime-state-purge-and-fade-source.md) — 状态清脏入口与淡入权威源。
