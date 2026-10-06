---
name: "AeonStagery"
description: "温暖而专注的电影化场景制作工作台"
colors:
  light-canvas: "#f4f5f7"
  light-secondary-surface: "rgba(255, 255, 255, 0.92)"
  light-tertiary: "#edeef1"
  light-surface: "#ffffff"
  light-elevated: "#e6e8ec"
  light-text: "#13151a"
  light-text-secondary: "#4b5160"
  light-text-muted: "#8c92a0"
  director-indigo: "#4f46e5"
  partner-indigo: "#6366f1"
  director-indigo-hover: "#4338ca"
  dark-canvas: "#11131a"
  dark-secondary-surface: "rgba(24, 25, 34, 0.92)"
  dark-tertiary: "#191b25"
  dark-surface: "#1d1f2a"
  dark-elevated: "#252735"
  dark-text: "#f1eee9"
  dark-text-secondary: "#aaa4b4"
  dark-text-muted: "#706b7a"
  warm-coral: "#d88c7a"
  cool-stage-slate: "#8fa7c7"
  warm-coral-hover: "#efac98"
  on-accent: "#ffffff"
  semantic-success: "#34d399"
  semantic-warning: "#f59e0b"
  semantic-error: "#ef4444"
  track-dialogue: "#10b981"
  track-character: "#60a5fa"
  track-camera: "#f472b6"
  track-environment: "#fbbf24"
  track-audio: "#a78bfa"
typography:
  display:
    fontFamily: "Outfit, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0"
  headline:
    fontFamily: "Outfit, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "0"
  title:
    fontFamily: "Outfit, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Outfit, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Outfit, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.06em"
  mono:
    fontFamily: "JetBrains Mono, Cascadia Code, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
rounded:
  none: "0px"
  xs: "2px"
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "24px"
  full: "9999px"
  circle: "50%"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "24px"
  3xl: "32px"
  4xl: "40px"
components:
  button-standard:
    backgroundColor: "{colors.light-elevated}"
    textColor: "{colors.light-text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-primary-light:
    backgroundColor: "{colors.director-indigo}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-primary-dark:
    backgroundColor: "{colors.warm-coral}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.light-text-muted}"
    rounded: "{rounded.md}"
    size: "32px"
  field-standard:
    backgroundColor: "{colors.light-tertiary}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
    height: "32px"
  card-standard:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.lg}"
    padding: "16px"
  navigation-top:
    backgroundColor: "{colors.light-secondary-surface}"
    textColor: "{colors.light-text}"
    rounded: "0"
    padding: "0 16px"
    height: "44px"
  validation-pill:
    backgroundColor: "color-mix(in srgb, #f59e0b 10%, #ffffff)"
    textColor: "{colors.semantic-warning}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  timeline-item-dialogue:
    backgroundColor: "{colors.light-secondary-surface}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
---

# Design System: AeonStagery

## Overview

**Creative North Star: "电影制作控制台"**

AeonStagery 的界面像一张为个人创作者准备的电影制作控制台：舞台是视觉中心，时间轴、检查器、播放控制与状态反馈围绕它形成稳定的工作场景。界面保持专业工具应有的信息密度，但不追求冰冷的工程感；柔和表面、温暖主题色和短促反馈让长时间创作更专注。

这套系统以“温暖、专注、创作者友好”为整体语气。组件紧凑、清晰并略带触感，依靠色调分层、细边框、轻微位移和有限阴影表达状态。Light 与 Dark 是平等主题，共享同一套语义角色和交互结构，而不是两套互不相干的视觉身份。

**Key Characteristics:**

- 以黑色舞台和可调整工作面板构成的桌面制作布局。
- 低饱和中性表面搭配稀少但明确的主题强调色。
- 时间、数值与技术状态使用等宽字体和表格数字。
- 对话、角色、镜头、环境与音频拥有稳定的轨道语义色。
- 动效短促克制，并为低性能与减少动态偏好提供降级路径。

## Colors

两套主题保持相同的背景、表面、文字与强调色角色：Light 使用冷静靛蓝，Dark 使用暖光珊瑚。

### Primary

- **导演靛蓝** (`director-indigo`): Light 主题的主操作、焦点和选中状态，清晰但不铺满界面。
- **暖光珊瑚** (`warm-coral`): Dark 主题的主操作与焦点，给深色工作台加入温度。

### Secondary

- **协作靛蓝** (`partner-indigo`): Light 主题的次强调、渐变和并列操作。
- **冷场灰蓝** (`cool-stage-slate`): Dark 主题的次强调，与暖珊瑚形成冷暖分工。

### Tertiary

- **语义绿、琥珀与红** (`semantic-success`, `semantic-warning`, `semantic-error`): 仅表达成功、警告和错误，不替代主题强调色。
- **轨道语义色** (`track-dialogue`, `track-character`, `track-camera`, `track-environment`, `track-audio`): 通过窄边轨、块色调和图形反馈帮助快速扫描时间轴。

### Neutral

- **Light 冷白工作台** (`light-canvas`, `light-secondary-surface`, `light-tertiary`, `light-surface`, `light-elevated`): 以轻微冷灰差异区分画布、半透明固定栏、三级背景、表面和抬升层。
- **Dark 深墨工作台** (`dark-canvas`, `dark-secondary-surface`, `dark-tertiary`, `dark-surface`, `dark-elevated`): 以蓝紫倾向的近黑层次托住暖色强调。
- **主题文字对** (`light-text`, `dark-text`): 保持主要信息高对比；Muted 令牌只用于辅助信息、元数据和未激活状态。

### Named Rules

**The Dual Theme Rule.** Light 与 Dark 共享相同语义层级；新增组件必须通过现有 CSS 变量适配两套主题，不能把某套主题的字面颜色写死为系统默认。

**The Semantic Rail Rule.** 轨道类别色用于定位和分组，优先出现在窄边、标记与小面积块色中；不要把整块工作区染成类别色。

## Typography

**Display Font:** Outfit（回退至 Noto Sans SC、Microsoft YaHei 与 system-ui）

**Body Font:** Outfit（回退至 Noto Sans SC、Microsoft YaHei 与 system-ui）

**Label/Mono Font:** JetBrains Mono（回退至 Cascadia Code 与 monospace）

**Character:** Outfit 提供圆润但克制的现代工作台质感，中文回退保持清晰和稳定。JetBrains Mono 只承担时间码、数值、路径、状态和技术元数据，让创作内容与控制信息一眼分离。

### Hierarchy

- **Display**（600，30px，1.1）: 项目启动页等少量入口标题，不进入紧凑编辑面板。
- **Headline**（800，17px，1.15）: 检查器详情标题、模态主标题和关键对象名称。
- **Title**（800，15px，1.35）: 面板、分区和卡片标题。
- **Body**（400，13.5px，1.5）: 编辑器正文与通用控件；局部密集控件可降至 12–12.5px。
- **Label**（600，10.5px，0.06em）: 短字段标签、分组眉题和状态说明；大写只用于短标签。
- **Mono**（500，11px，1.4）: 时间码、坐标、路径、计数和诊断值，并启用表格数字。

### Named Rules

**The Numbers Stay Tabular Rule.** 任何会连续变化或纵向比较的时间与数值都使用等宽字体或表格数字，避免播放和拖动时产生水平跳动。

## Layout

主工作区是占满窗口的固定桌面编排：顶部工具栏高 44px，底部状态栏高 28px，中间以舞台为视觉中心，右侧检查器和底部时间轴由 4px 拖拽分隔条调整。默认检查器宽 380px、详情宽 360px、时间轴高 300px；面板内容使用 4–16px 的紧凑间距，入口页与模态场景才使用 18–40px 的宽松节奏。

启动页内容限制在 920px 内，操作入口通过 `auto-fit` 网格从多列自然收缩。工作台在 1199px 以下让 AI 面板转为覆盖层，在 1024px 和 960px 以下逐步压缩工具栏信息；窄窗中的复杂列表和教程选择改为单列。这里的“窄窗”仅指可缩放的桌面 PC 窗口，不延伸为手机或平板适配。响应策略是保住舞台、当前任务和图标操作，再折叠辅助文案；移动端、平板端和触摸优先布局不在当前设计承诺范围内。

**The Stage Stays Central Rule.** 新面板和临时工具不得永久挤走舞台；优先停靠、可调整或在窄窗中短暂覆盖，并保留明确关闭入口。

## Elevation & Depth

系统先用背景色调、半透明表面和细边框建立层级，再用阴影强调弹层、模态、悬浮状态与正在拖动的对象。普通面板和静态卡片在休止状态保持轻量；菜单、对话框、启动页表面和高优先级浮层使用更明确的环境阴影。高性能模式允许模糊和微抬升，低性能模式关闭大部分模糊、阴影和位移动效。

### Shadow Vocabulary

- **细微边界** (`--shadow-sm`): 卡片悬停、粘性标题和小型状态标签。
- **局部抬升** (`--shadow-md`): 轨道块悬停和较小浮层。
- **浮层结构** (`--shadow-lg`): 菜单、选择器、模态与主要停靠工具。
- **主题辉光** (`--shadow-glow`): 主播放按钮、品牌标记和极少量关键强调。
- **高级浮层** (`--shadow-premium`): 教程聚光、独立工具窗和高优先级临时层。

### Named Rules

**The Layer Before Shadow Rule.** 先用表面色和边框解释结构；只有元素脱离文档层、响应交互或需要抢占注意力时才增加明显阴影。

## Shapes

形状语言以轻度圆角矩形为主，建立明确的**圆角层级系统 (Corner Radius Hierarchy)**。界面遵循比例缩放与嵌套几何原则，杜绝无依据的硬编码数值（如 3px、5px、7px、10px、13px）。

### Radius Token Scale (尺度基元)

| Token | 值 | 角色 | 典型适用场景 |
| --- | --- | --- | --- |
| `--radius-none` | `0px` | 贴合/无圆角 | 窗口边缘贴合面板、分栏拖拽条、顶层全屏舞台框 |
| `--radius-xs` | `2px` | 微型/指示器 | 进度条轨、滑块凹槽、微型刻度、细分割指示、微胶囊 |
| `--radius-sm` | `4px` | 紧凑交互/块 | 时间轴轨道块 (`track-block`)、小标签、KBD 按键、气泡 Tooltip、紧凑小按钮 |
| `--radius-md` | `8px` | 标准控件 | 标准按钮 (`.btn`)、输入框 (`input`)、下拉框、菜单面板 (`menu`)、选项卡 (`tab`) |
| `--radius-lg` | `12px` | 表面/面板 | 内容卡片 (`card`)、检查器面板、悬浮容器 (`popover`)、媒体缩略图 |
| `--radius-xl` | `16px` | 模态/对话框 | 设置弹窗 (`settings-dialog`)、模态遮罩面板、主要工具悬浮窗 |
| `--radius-2xl` | `24px` | 英雄/向导 | 首次运行向导 (`SetupWizard`)、全屏居中引导大卡片 |
| `--radius-full` | `9999px` | 药丸/胶囊 | 状态胶囊 (`pill`)、Toggle 开关槽体、搜索栏外框 |
| `--radius-circle`| `50%` | 正圆 | 播放/录制单点按钮、头像、未读指示点、状态指示球 |

### Semantic Radius Hierarchy (语义层级)

系统建立 7 级语义圆角 Tokens，确保组件意图与外形严格一致：

1. **Micro / Hairline Level (`--radius-indicator`, `--radius-hairline`: `2px`)**:
   仅用于宽度/高度极小（<=6px）的细节指示，如时间轴游标刻度、进度条轨道、滑块凹槽。
2. **Compact Item & Track Level (`--radius-track-block`, `--radius-control-sm`, `--radius-badge`, `--radius-tooltip`, `--radius-tag`: `4px`)**:
   高密度编辑界面的紧凑单元，包括多轨时间轴上的角色/对话/镜头块、状态微标、快捷键提示。
3. **Standard Interactive Controls (`--radius-control`, `--radius-button`, `--radius-input`, `--radius-menu`, `--radius-dropdown`, `--radius-tab`: `8px`)**:
   所有与鼠标/键盘交互的基础表单元素与按钮，视觉触感明确，高度通常为 32–36px。
4. **Surface & Panel Containers (`--radius-surface`, `--radius-card`, `--radius-panel`, `--radius-popover`: `12px`)**:
   承载多组控件的工作台卡片、二级侧栏面板、悬浮浮窗，边框清晰，带有微抬升或描边。
5. **Modal & Dialog Windows (`--radius-dialog`, `--radius-modal`, `--radius-window`: `16px`)**:
   高层级桌面浮动窗口与模态对话框，具备独立的关闭行为和深层阴影。
6. **Hero & Onboarding (`--radius-hero`: `24px`)**:
   非日常紧凑编辑流的引导页面与新用户向导，提供更柔和、更具沉浸感的欢迎视效。
7. **Pill & Circular Affordances (`--radius-pill`, `--radius-switch`: `9999px`, `--radius-circle`: `50%`)**:
   用于表示状态切换、完全自包围的胶囊指示器，以及纯几何正圆按钮。

### Named Rules

**The Radius Follows Scale Rule.** 控件尺寸越小，圆角半径越收敛；容器层级越高，圆角越柔和。严禁在紧凑工作区面板中使用大圆角，也不得把普通矩形容器做成无意义的胶囊状。

**The Concentric Radius Rule (同心圆角嵌套法则).** 当带圆角的容器内嵌套子元素时，内外圆角必须保持视觉同心。子元素圆角按公式计算或对齐下级 Token：
$$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 0)$$
- 例：外层卡片 $R = 12\text{px}$ (`--radius-lg`)，内边距 $\text{Padding} = 8\text{px}$ 时，内层项目圆角为 $\max(12 - 8, 0) = 4\text{px}$ (`--radius-sm`)，严禁内层元素半径大于外层产生视觉外凸畸变。
- 例：外层对话框 $R = 16\text{px}$ (`--radius-xl`)，内边距 $\text{Padding} = 12\text{px}$ 时，内层卡片使用 $4\text{px}$ 或 $8\text{px}$ (`--radius-sm` / `--radius-md`)。
- TypeScript 提供辅助函数 `getNestedRadius(outerPx, paddingPx)` 进行精确计算。

## Components

### Buttons

按钮紧凑、清晰并略带触感，默认高度约 32px，内部间距为 6px 14px，圆角为 8px。

- **Primary:** 使用当前主题的主强调色、白色文字和较高字重；小型工具栏版本降为 4px 10px 与 4px 圆角。
- **Hover / Focus:** 悬停上移 1px，并增加轻阴影；主按钮出现主题辉光，键盘焦点使用 2px 主题色轮廓并外移 2px。
- **Secondary:** 使用抬升中性色表面、细边框和次级文字色。
- **Icon:** 固定 32px 方形、透明背景，熟悉操作只显示图标并通过 tooltip 或可访问名称说明。
- **Danger:** 保持中性表面，只将文字与边框转为错误色；悬停才加入淡红底色。

### Chips

- **Style:** 验证、协作与状态徽章高度约 18–28px，使用细边框、轻语义底色和 4–8px 圆角；计数类徽章可用胶囊形。
- **State:** 错误、警告、成功严格使用语义色；主题主色只表示选中、焦点或协作编辑状态。

### Cards / Containers

- **Corner Style:** 普通卡片使用 12px，紧凑列表项和工具容器使用 4–8px。
- **Background:** 从当前主题的 canvas、surface 与 elevated 三层中选择，不创建临时近似色。
- **Shadow Strategy:** 静态卡片主要依赖边框；悬停使用细微阴影，弹层使用结构阴影。
- **Border:** 1px 低对比边框；选中或校验状态才提升为主题或语义色。
- **Internal Padding:** 紧凑项 8–12px，标准卡片 16px，主要模态 20–28px。

### Inputs / Fields

- **Style:** 文字输入使用三级背景、1px 边框、4px 圆角和 7px 10px 内间距；自定义选择器使用 8px 圆角与至少 32px 高度。
- **Focus:** 边框切换为当前主题主色，并增加 2px 主题辉光。
- **Error / Disabled:** 错误使用语义红的低浓度表面；禁用态降低到约 40–62% 不透明度并移除位移反馈。

### Navigation

顶部栏高 44px，以品牌、项目、状态、视图、输出和更多操作分组；组间使用低对比分隔线。主命令保留文字，熟悉工具采用 32px 图标按钮；窗口变窄时先隐藏项目名、徽章与重复图标，再压缩按钮内距。

### Timeline Action Item

时间轴动作项使用 8px 圆角、10px 12px 内间距和 3px 类别左边轨。时间码使用等宽字体，标题与描述截断，操作按钮只在悬停、激活或键盘焦点进入时出现。选中状态由主题色边框和轻辉光表达，协作状态使用内描边，不能只依赖颜色名称文本。

## Do's and Don'ts

### Do:

- **Do** 通过 `--bg-*`、`--text-*`、`--accent-*`、`--border-*` 和 `--shadow-*` 变量实现 Light 与 Dark 两套主题。
- **Do** 保持舞台、检查器和时间轴之间清晰、可调整的工作区关系。
- **Do** 将轨道类别色限制在左边轨、标记、小面积块色和相关反馈中。
- **Do** 为时间码、坐标、路径和连续变化数值使用等宽字体或表格数字。
- **Do** 为 hover、focus-visible、active、disabled、error 和协作编辑提供可区分状态。

### Don't:

- **Don't** 用大面积主题色、辉光或类别色淹没黑色舞台和中性工作表面。
- **Don't** 把所有容器做成悬浮卡片或胶囊；页面区段与固定工作面板保持结构化、低装饰。
- **Don't** 用装饰性动效干扰拖动、播放、定位和连续编辑；所有动效都必须支持 reduced-motion 与低性能降级。
- **Don't** 在紧凑面板中使用启动页尺度的标题或宽松留白。
