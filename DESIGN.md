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
  light-on-accent: "#ffffff"
  dark-on-accent: "#13151a"
  semantic-success: "#34d399"
  semantic-warning: "#f59e0b"
  semantic-error: "#ef4444"
  light-success-text: "#34d399"
  light-warning-text: "#f59e0b"
  light-error-text: "#ef4444"
  dark-success-text: "#34d399"
  dark-warning-text: "#f59e0b"
  dark-error-text: "#ef4444"
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
    textColor: "{colors.light-on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-primary-dark:
    backgroundColor: "{colors.warm-coral}"
    textColor: "{colors.dark-on-accent}"
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
    textColor: "{colors.light-warning-text}"
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

项目主页采用“片场入口”：232px 常驻命令栏承载品牌、四个以 tooltip 提供说明的主命令和素材来源，外壳最大宽度 1440px，右侧主区自适应剩余空间。命令栏以无框行和低饱和的新建入口保持安静，主强调色优先留给舞台上的继续制作 / 首次创建按钮；进入新建流程后对应命令才使用实色选中态。主区先呈现可交互的立体项目分镜台，再展示可搜索的最近项目与模板包。≥1100px 时最近项目和模板包约按 62% / 38% 并排，960–1100px 时上下堆叠，<960px 的桌面窄窗将命令栏改为顶部横向命令条，素材来源通过网格区域移到主区底部并保持可滚动和教程可聚焦。新建项目、模板能力与协作子流程复用同一外壳，采用与首页同底色的开放式布局，移除外层卡片、阴影与模糊；页面标题使用 28–40px、600 字重，辅助说明收进标题旁的 tooltip，并优先用一句话表达，面包屑和单一返回入口承载层级导航。表单左对齐、最大宽度 880px，分区通过 24–28px 留白与细分隔线组织；模板能力页沿用相同分区，协作入口使用纵向无框菜单，协作子页使用带下划线的模式切换。内容区不小于 720px 时，以 152px 分区标题栏与 32px 栏间距对齐右侧控件；窄窗切为单列。项目、画布、模板与角色、WebGAL 导入分别成组；协作表单按项目信息、房间设置、连接信息和本地工作区组织。常规字段高 42px，主操作高 44px；文件选择使用图标、截断路径和选择按钮组成的紧凑区域，阅读速度与衔接选项采用分段控件。模板和角色列表统一选中态，角色整行可选择；模板能力配置提供完成入口并保留草稿。根据实际字段区宽度折叠双列表单与文件操作。当前命令使用 `aria-current="page"` 和细边轨标记。工作台在 1199px 以下让 AI 面板转为覆盖层，在 1024px 和 960px 以下逐步压缩工具栏信息；窄窗中的复杂列表和教程选择改为单列。这里的“窄窗”仅指可缩放的桌面 PC 窗口，不延伸为手机或平板适配。响应策略是保住舞台、当前任务和图标操作，再折叠辅助文案；移动端、平板端和触摸优先布局不在当前设计承诺范围内。

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
| `--radius-2xl` | `24px` | 英雄/向导 | 项目主页欢迎区、全屏居中引导大卡片 |
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
   非日常紧凑编辑流的项目欢迎页与引导界面，提供更柔和、更具沉浸感的欢迎视效。
7. **Pill & Circular Affordances (`--radius-pill`, `--radius-switch`: `9999px`, `--radius-circle`: `50%`)**:
   用于表示状态切换、完全自包围的胶囊指示器，以及纯几何正圆按钮。

### Named Rules

**The Radius Follows Scale Rule.** 控件尺寸越小，圆角半径越收敛；容器层级越高，圆角越柔和。严禁在紧凑工作区面板中使用大圆角，也不得把普通矩形容器做成无意义的胶囊状。

**The Concentric Radius Rule (同心圆角嵌套法则).** 当带圆角的容器内嵌套子元素时，内外圆角必须保持视觉同心。子元素圆角按公式计算或对齐下级 Token：
$$R_{\text{inner}} = \max(R_{\text{outer}} - \text{Padding}, 0)$$
- 例：外层卡片 $R = 12\text{px}$ (`--radius-lg`)，内边距 $\text{Padding} = 8\text{px}$ 时，内层项目圆角为 $\max(12 - 8, 0) = 4\text{px}$ (`--radius-sm`)，严禁内层元素半径大于外层产生视觉外凸畸变。
- 例：外层对话框 $R = 16\text{px}$ (`--radius-xl`)，内边距 $\text{Padding} = 12\text{px}$ 时，内层卡片使用 $4\text{px}$ 或 $8\text{px}$ (`--radius-sm` / `--radius-md`)。
- 实现时按上述公式计算内层圆角，并优先对齐下级 Token。

## Components

### Project Storyboard

项目主页以真实最近项目组成“立体分镜台”，最多六个项目分镜和一个新建入口。分镜台占据主区整个宽度，当前项目位于前景，两侧项目沿横向、深度和角度展开。项目封面使用项目名称和路径生成的几何，以 Light / Dark 的强调色与配对前景色表达；默认 `AeonStagery Project YYYY-MM-DD` 名称提取月日作为大字、年份与附加后缀作为辅文，自定义名称直接排版，避免首字母重复。封面不虚构截图、轨道或场景数据；分镜台下方不设置说明性 caption。下方独立展示当前项目大标题、上次打开时间、路径与继续制作按钮。

动效围绕分镜调度展开：首次进入以 1100ms 从纵深叠放展开到各自位置，各分镜相隔 55ms；选中分镜以 850ms 重新排列，悬停最多前移 85px、上提 22px。鼠标驱动整个分镜台最多水平 9°、垂直 5° 的阻尼倾转，静止时分镜台以 9 秒周期上下浮动 12px。标题切换使用短促遮罩揭示。分镜选择不等待开场结束；跨页面导航先完成旧内容的退出，再提交目标视图。

单击两侧分镜选择项目，再次单击中央分镜直接进入项目；中央新建分镜直接进入创建流程。方向键、Home、End 同时移动选择与焦点，采用 roving tabindex。继续制作和页面空白处无修饰键 Enter 均打开当前选中项目；输入法组合、修饰键和模态期间不触发。选择新建分镜时不会误开最近项目。项目重命名或重排通过路径保持选择，移除当前项目后回退到列表首项。打开期间锁定分镜切换与重复打开；返回主页子页面时保留之前选中的分镜。

工具栏可暂停装饰动效；移出视口或窗口隐藏时停止浮动与鼠标动画任务，卸载清理观察器和帧回调。`data-perf="low"` 与 `prefers-reduced-motion: reduce` 下保留静态空间排布、关闭入场、浮动、跟随和位移动效。窄桌面窗口缩小分镜和间距，项目操作移到标题下方，保留键盘切换。

最近项目历史最多保留 50 条，分镜台和列表默认各展示最近 6 条。历史超过 6 条时，列表显示搜索框与“查看全部（N）”入口，并可收起。搜索按名称和路径即时筛选全部已记录历史，显示匹配数与历史总数，结果不受默认 6 条限制；Esc 或清空搜索恢复之前的展开状态。历史不超过 6 条时隐藏搜索入口；已有搜索内容在移除项目后继续保留，方便清空。搜索不改变分镜选择，打开分镜台以外的历史项目也保持当前分镜选择。搜索框内 Enter 不打开项目，用户通过列表项目按钮打开；页面空白处与明确项目操作的键盘行为保持不变。

主页、新建、模板能力和协作各级页面共用退出后进入的导航：旧组件保留 220ms 向侧后方退场，目标组件以 380ms 从侧前方进入；返回反转空间方向。退场期间旧视图不可交互，命令栏的连续导航采用最后一次目标。切换后焦点进入目标标题或继续制作按钮。

主页进入编辑器使用独立的展示生命周期：项目状态变化后主页仍保留 620ms，中央分镜向前推进、周围内容退场，真实编辑器与时间轴从后方接入。编辑器返回时先退场 240ms，再执行现有保存关闭流程，主页以 480ms 回到焦点；关闭失败则恢复编辑器。退出动画保持最终帧，直到 React 提交替换页面后才清理，避免取消动画后旧画面闪回。隐藏窗口、减少动态效果或低性能模式跳过或结束动画，不依赖动画事件才能继续导航。

### Buttons

按钮紧凑、清晰并略带触感，默认高度约 32px，内部间距为 6px 14px，圆角为 8px。

- **Primary:** 使用当前主题的主强调色、`--on-accent` 前景色和较高字重；Light 使用白色，Dark 复用现有深墨色 `#13151a`。默认及悬停状态的文字对比度均须达到 4.5:1（§5.6），播放按钮与实心主题色工具按钮沿用该配对。小型工具栏版本降为 4px 10px 与 4px 圆角。
- **Hover / Focus:** 悬停上移 1px，并增加轻阴影；主按钮出现主题辉光，键盘焦点使用 2px 主题色轮廓并外移 2px。
- **Secondary:** 使用抬升中性色表面、细边框和次级文字色。
- **Icon:** 固定 32px 方形、透明背景，熟悉操作只显示图标并通过 tooltip 或可访问名称说明。
- **Danger:** 保持中性表面，只将文字与边框转为错误色；悬停才加入淡红底色。

### Chips

- **Style:** 验证、协作与状态徽章高度约 18–28px，使用细边框、轻语义底色和 4–8px 圆角；计数类徽章可用胶囊形。
- **State:** 错误、警告、成功严格使用语义色；主题主色只表示选中、焦点或协作编辑状态。
- **Validation Text:** 校验提示分别使用 `--warning-text`、`--error-text`，底色与边框沿用 `--warning`、`--error`。按项目偏好，警告和错误文字分别保留原始琥珀色 `#f59e0b` 与红色 `#ef4444`，明暗主题的文字令牌均为对应语义色的别名。
- **Status Text:** 保存、烘焙与协作状态使用 `--success-text`、`--warning-text`、`--error-text`，文字令牌分别沿用原始绿色 `#34d399`、琥珀色 `#f59e0b` 与红色 `#ef4444`。保存成功文字保留原有 0.7 透明度。播放控制标签、总时长、状态栏元数据与检查器空态指引使用 `--text-secondary`，确保说明文字仍然可读。

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
