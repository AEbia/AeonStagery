---
status: accepted
implementation_status: architecture-decided; editor-session-implementation-pending
last_updated: 2026-09-04
supersedes_product_scope: ADR-0027
extends: ADR-0028
---

# Live2D 自定义 Motion 关键帧编辑需求

## 目标定位

从用户角度，这项能力是“自定义一个 Live2D Motion”，不是在所有 Live2D
计算结束后追加一个 Parameter 覆盖层。

- 自定义 Motion 与普通 `playMotion` 属于同一级角色动作。
- Cubism 2.1 是第一优先级；Cubism 3/4/5 在相同抽象下后续接入。
- 主要入口是选中已有 `playMotion` 并选择“自定义动作”。
- 导入或注册 `.mtn` / `.motion3.json` 时仍只创建普通资源 Motion，不自动解析成
  自定义 Motion、不生成 Parameter 轨道，也不改变源文件或既有 `playMotion`。
- “自定义动作”是用户在时间轴上对某个普通资源 Motion 发起的显式内容转换；只有
  执行该命令后，系统才读取源 Motion 并生成可编辑的场景内联关键帧副本。
- 首版不提供空白自定义 Motion；每个自定义 Motion 都必须由已有 `playMotion`
  转换生成，确保所有可编辑轨道都有可靠来源与起始值。
- 转换在原时间轴位置直接替换原 `playMotion` 事件，不新增并存事件。原事件的
  时间、角色、语句关联和进入过渡保留，动作来源改为完整自包含副本；原始 Motion
  仅记录为 `derivedFrom`，Undo 可以恢复原始 `playMotion`。
- 自定义必须是非破坏性的：原始 `.mtn` 或 `.motion3.json` 不被改写。
- 转换结果保存为完整、自包含的关键帧副本。原 Motion 只保留为 `derivedFrom`
  来源信息，不再作为自定义 Motion 的运行时依赖。
- 原 Motion 后续被修改、移动或删除，不得改变已经转换的自定义 Motion。
- 场景中的自定义结果以内联数据保存。“保存到项目动作库复用”只是成熟后的
  扩展方向，不属于首版范围，也不在当前需求中引入新的运行时 Motion 类型。
- 功能范围是 Cubism Parameter Motion。PartOpacity、Drawable、颜色和渲染顺序不在当前范围内。

## 场景语义与身份

- 自定义 Motion 是 `characterPerformance` 中 Motion 来源的一种，不是新的场景
  语句族，也不是独立的 Parameter Clip。
- `characterPerformance` 的 Motion 输出必须能够区分普通资源 Motion 与内联自定义
  Motion；二者是同一个 Motion 输出的互斥来源，不能在同一输出中并存或叠加。
- 场景持久化中的 `params.motion` 表示完整的 Motion 输出，并使用 `kind` 判别其来源；
  普通资源 Motion 保存为 `{ kind: "resource", key, fadeInSeconds? }`，内联自定义
  Motion 保存为 `{ kind: "custom", durationSeconds, fadeInSeconds, derivedFrom, tracks }`。
  进入过渡和
  时长等 Motion 专属配置也属于这个对象，不属于整个 `characterPerformance`。
- `target` 以及 Expression、LookAt、Blink 输出继续是 `params.motion` 的同级字段。
  最终 v4 不再把 `durationSeconds` 作为 `characterPerformance.params` 的顶层公共字段，
  也不在 Motion 输出或角色表演的其他位置保存 `loop` 或 `priority`。
- 普通资源 Motion 不继续以裸字符串作为新场景的规范写入格式，也不使用
  `string | object` 作为长期数据契约。v4 codec 只接受判别联合的规范形状；
  旧 `motion: "motion-key"` 与无 `kind` 的 `{ key, fadeInSeconds? }` 只由显式的
  v3→v4 加载时迁移处理，不进入 codec 解析器本身。该迁移在严格 v4 校验之前运行，
  把两种旧形状改写为 `{ kind: "resource", key, fadeInSeconds? }`，改写结果再按
  v4 规则完整校验；codec 对旧形状不宽容、不规范化，保存时以规范 v4 形状落盘。
- `kind` 是 Motion 来源的唯一判别字段。解析、编译和验证必须穷尽 `resource` 与
  `custom` 两种来源，不能再通过是否存在关键帧等可选字段隐式猜测来源类型。
- 自定义 Motion 必须保存 `derivedFrom: { key, fadeInSeconds?, fadeOutSeconds? }`。
  这里只记录转换时的模型内逻辑 Motion key 与源淡入、淡出值，不保存 Motion 文件
  路径、模型路径或内容指纹，也不构成运行时依赖。
- 自定义 Motion 直接内联 Parameter `tracks`，不使用旧 Parameter Clip 的
  `source.animation` 包装，也不保存 `animation.id`、`animation.name`、`blendMode`、
  `weight` 或 `endBehavior`。旧实现中不携带 Clip 语义的纯关键帧求值算法可以复用，
  但旧场景类型不能作为新的持久化契约。
- 最终 v4 的 Parameter 轨道原生支持 `linear`、`bezier`、`stepped` 与
  `inverseStepped` 四种分段。Cubism 2.1 转换只生成 `linear`，但 v4 codec、验证和
  求值器必须穷尽全部四种，未来接入 Cubism 3/4/5 不因曲线类型本身升级 schema。
- 分段保存在其起始关键帧的 `segment` 字段上，描述从当前关键帧到下一关键帧的
  曲线；最后一个关键帧不保存 `segment`。Bezier 分段保存两个控制点，并使用 Motion
  局部秒数和值的绝对坐标，不使用旧 Parameter Animation 的归一化
  `inTangent` / `outTangent`：

  ```ts
  type CustomMotionSegment =
    | { type: "linear" }
    | {
        type: "bezier";
        controlPoints: readonly [
          { time: number; value: number },
          { time: number; value: number },
        ];
      }
    | { type: "stepped" }
    | { type: "inverseStepped" };

  interface CustomMotionKeyframe {
    time: number;
    value: number;
    segment?: CustomMotionSegment;
  }
  ```

- 统一 Bezier 求值器使用控制点的实际绝对时间坐标。Motion3
  `Meta.AreBeziersRestricted: false` 的控制点时间和值原样进入该结构；值为 `true` 时，
  Cubism SDK 本身忽略控制点时间并按起止时间线性推进，因此转换保留两个控制点值，
  但把其时间规范为分段时长的 `1/3` 与 `2/3` 绝对位置。这样无需持久化 Motion3
  专属求值标记，也能保持源 Motion 的运行曲线。

- 规范轨道中的每个非末尾关键帧都必须显式保存 `segment`，即使它是线性分段；
  末尾关键帧必须省略 `segment`。codec 不把缺失分段默认为线性，也不忽略末点上的
  多余分段。
- 每条轨道至少有一个关键帧，首点必须位于 `F0`；关键帧必须按 `time` 严格递增，
  时间有限、非负且不超过自定义 Motion 的 `durationSeconds`，同一时间不允许重复；
  关键帧值及 Bezier 控制点的时间和值也必须为有限数字。codec 对乱序、重复、时间
  越界或非有限数据直接报错，不在加载时排序、合并或钳制。
- Bezier 控制点遵守 cp 顺序契约：每个控制点的时间必须落在其分段区间
  `[起点关键帧.time, 下一关键帧.time]` 内，且第一个控制点的时间不得超过第二个
  （`cp1.time <= cp2.time`）。这保证 x(t) 轴单调，运行时求根求解器（网格扫描 +
  二分）确定性收敛；编辑器拖帧被钳制在相邻关键帧之间，关键帧时间变更路径对
  相邻 Bezier 分段做无损 de Casteljau 再分割以维持该契约，越出旧分段范围的
  遗留控制点回退为线性分段，绝不持久化乱序控制点。求值器仍对乱序数据（历史
  文档、手工编辑）做多根扫描，选取最接近线性猜测的根，避免收敛到错误根。
- 关键帧唯一性按精确的 Motion 局部秒数判断，不按所在场景帧区间分桶。Motion3
  原生子帧点或修改场景帧率后形成的小数帧点即使落在同一场景帧区间内也可以共存；
  codec 只拒绝完全相同的时间。
- codec 不使用当前目标模型的 Parameter `min/max` 校验、拒绝或改写关键帧及控制点
  的原始目标值。模型范围不是场景持久化契约；同一数据可以随角色模型或资源更新
  重新解析范围，超范围值只在编辑交互、预览与播放阶段处理。
- 同一自定义 Motion 中 `parameterId` 必须唯一，不能用两条同名轨道表达隐式覆盖。
- 自定义 Motion 必须至少包含一条 Parameter 轨道；codec 拒绝空 `tracks`。
- `parameterId` 是目标角色范围内的统一 Parameter 身份，不保存主体或子模型位置。
  运行时必须把轨道值写入该角色中所有包含同一 ID 的具体模型；只存在于脸、手臂等
  子模型的 ID 也能独立成为轨道，不能因为主体模型不存在该 ID 而忽略。
- 每条轨道持久化大小写精确的 `parameterId`、可选的逐轨道进入过渡覆盖与
  `keyframes`：

  ```ts
  interface CustomMotionTrack {
    parameterId: string;
    fadeInSeconds?: number;
    keyframes: CustomMotionKeyframe[];
  }
  ```

- `track.fadeInSeconds` 是 Motion3 Parameter 曲线级 `FadeInTime` 对应的实际运行语义，
  不是显示或拟合元数据。省略时使用自定义 Motion 外层的 `fadeInSeconds`；显式 `0`
  表示该 Parameter 立即采用自身曲线。该值必须有限并满足
  `0 <= track.fadeInSeconds <= durationSeconds`。
- 转换后的 `track.fadeInSeconds` 是可创作属性，不是只读来源信息。用户可以修改其
  显式值、设为 `0`，或删除该字段以恢复继承 Motion 外层 `fadeInSeconds`；这些操作
  不改写关键帧或 `derivedFrom`。
- Parameter 显示名、分类、`min`、`max` 和 `default` 不写入自定义 Motion；编辑时
  始终按当前目标模型与可信元数据重新解析。转换拟合使用过的范围只是一次性输入，
  也不成为轨道的持续属性。
- scene schema v3 从未投产；该需求在开发期按 v3 形状实现，随后项目已把
  `SCENE_SCHEMA_VERSION` 提升为 `4`。开发期 v3 文档通过确定性的 v3→v4 加载时
  迁移读取，保存时持久化 v4 形状。
- v4 的规范写入形状只有判别联合的规范形状，codec 不接受旧形状：裸字符串
  `motion: "motion-key"` 与无 `kind` 的 `{ key, fadeInSeconds? }` 记录只在
  `schemaVersion === 3` 文档的 v3→v4 加载时迁移中被改写为 resource 分支。该迁移
  先于严格 v4 校验执行，不进入编译、运行或验证语义；保存（`prepareForSave` 复用
  同一解析器）把文件以规范 v4 形状落盘。未知字段与非法形状仍按严格 codec 报错，
  不在加载时排序、钳制或合并。
- 生产 v2 的 action 文件继续由显式离线迁移（`scripts/migrations/legacy-scene`
  与 `migrate:scene-v2`）改写为
  `motion: { kind: "resource", key: "motion-key" }`；该工具负责 action→statement
  转换与资源 projectize，现在输出 v4 文档。开发期 v3 文档由加载时 v3→v4 迁移
  处理，无需再走离线迁移。
- 普通资源 Motion 不保存时长。v3→v4 迁移先按原 v3 形状计算旧场景结尾
  （角色表演顶层 `durationSeconds`、自定义 Motion 的 `durationSeconds` 与被移除
  Clip 的时长都参与该计算），再把这些贡献并入 `meta.durationSeconds`；并入只增
  不减，避免迁移后场景总长度缩短。
- 最终 v4 不保存 Motion `loop` 或 `priority`。迁移时旧默认值 `loop: false` 与
  `priority: 3` 静默丢弃；遇到非默认值则丢弃并产生迁移警告，说明旧行为已由
  单次 Motion 和确定性的时间轴接管顺序替代。
- 开发期 WIP v3 场景与测试数据中的旧 motion 形状（裸字符串或无 `kind` 对象）
  由 `schemaVersion === 3` 文档的 v3→v4 加载时迁移改写；`schemaVersion` 1/2 与
  未版本化文档仍由普通加载器严格拒绝，必须走离线迁移工具。迁移警告以
  `severity: 'warning'` 的加载结果 issue 呈现，不阻断文档加载。
- 把普通 Motion 转换为自定义 Motion 时，保留原 `characterPerformance` 语句的
  ID、时间、目标角色、语句关联和稳定排序位置；`params.motion` 从 `resource`
  分支替换为 `custom` 分支，并保留适用的 Motion 输出配置。
- 同一 `characterPerformance` 中已有的 Expression、LookAt 或 Blink 输出不因 Motion
  转换而被删除、复制或重建；它们继续保持各自独立的运行语义。
- 旧 `live2dParameterClip` / `applyLive2DParameterClip` 的场景与运行时模型不作为
  自定义 Motion 的承载结构。其帧末覆盖、历史 Clip 累积、混合模式和结束行为均
  不属于本需求定义的 Motion 语义。

## Motion 生命周期与运行顺序

- 自定义 Motion 的关键帧值是绝对目标值，不是相对底层 Motion 的增量。
- 转换保存源 Motion 在模型 Parameter 范围钳制前写入的原始绝对目标值，不把当前
  模型读回的钳制结果烘焙进关键帧。播放与最终预览仍按当时目标模型的范围钳制。
- 从已有 Motion 转换时，源 Motion 文件明确包含的每条 Parameter 曲线都必须实体化为
  可编辑的自定义 Motion 轨道；源 Motion 没有曲线的 Parameter 不由自定义 Motion
  控制，始终保持原样。
- Parameter 所有权按源 Motion 文件是否明确包含对应曲线判断，不按采样值是否发生
  变化猜测，也不把采样期间观察到的其他运行时写入算作源曲线。源文件明确包含但
  数值恒定的 Parameter 仍生成静态轨道。
- Parameter ID 不受内置名称或分类白名单限制。头部、面部、身体、手臂、手、服装、
  位置、旋转、自定义开关以及通过模型绑定间接改变遮挡或显隐的 Parameter，都按同一
  规则转换；名称与分类只影响编辑器展示，不决定轨道所有权。
- `Live2D Parts` 的直接部件透明度或可见性曲线不属于 Parameter 轨道，转换时忽略，
  且不因忽略这些曲线判定整个转换失败。不得把 Parts 透明度曲线伪装成
  `parameterId` 写入自定义 Motion。
- 源 Motion 只有被忽略的 Parts 曲线、没有任何可转换 Parameter 曲线时，“自定义动作”
  命令不适用：保留当前普通 Motion，不生成空的自定义 Motion。这不表示源文件损坏。
- 组合角色的多个具体模型在同一 Motion key 下写入相同 Parameter ID 时，源曲线一致
  则合并成一条角色级轨道；源曲线不同则无法用当前 `{ parameterId, keyframes }` 无损
  表达，整个转换失败。曲线一致性比较钳制前的原始 Motion 目标值，不比较各子模型
  可能因范围不同而产生的读回值；不得按最后遍历到的子模型静默覆盖。
- “自定义动作”转换是原子操作：源 Motion 文件明确包含的每条 Parameter 曲线都必须
  成功生成可编辑轨道。源资源无法读取或解析、无法取得有效时长、隔离求值无法完成，
  或任意源曲线无法产生完整且有限的采样结果时，整个转换失败，不生成部分自定义
  Motion，也不替换当前普通 Motion。
- 源 Motion 未写入某些 Parameter、源曲线数值恒定、曲线复杂度高或缺少可靠的
  Parameter 范围都不是转换失败。复杂曲线无法在所选误差档位下继续精简时，最坏
  保留逐帧采样点；范围缺失时使用既定的轨道幅度与绝对误差下限。源 Motion 包含
  被明确排除的 Parts 透明度或可见性曲线也不是失败。
- 普通 Motion 与自定义 Motion 都只执行一次，不提供场景级循环配置。源资源或
  SDK 中的循环设置不得使场景 Motion 自动重播。
- Motion 到达尾帧后保持最后姿态，与普通 `playMotion` 的结束表现一致。
- “保持”不是永久叠加：同一角色后续开始新的普通 Motion 或自定义 Motion 时，
  新 Motion 完全接管并释放旧自定义 Motion 的 Parameter 控制权。
- 新 Motion 的首关键帧保留该 Motion 自己的真实起始值，不自动改写为上一帧姿态，
  也不生成一批与上一帧相同的伪首帧关键帧。
- 上一姿态到新 Motion 的平滑交接由语句块级进入过渡完成。过渡期间按权重混合
  交接点姿态与新 Motion 曲线；过渡结束后完全采用新 Motion 曲线。
- 转换完成后保留源 Motion 的 `fade_in`；它作为自定义 Motion 语句块的进入过渡
  配置，可被用户单独调整，不写入 Parameter 关键帧。
- 场景中的规范字段名为 `fadeInSeconds`，表示非负秒数。它是普通资源 Motion 与
  自定义 Motion 共有的 Motion 输出配置，不使用更泛化的 `transitionSeconds`。
- 自定义 Motion 必须满足 `0 <= fadeInSeconds <= durationSeconds`，保证进入过渡在
  该 Motion 输出的语句生命周期内完成；codec 对超出时长的进入过渡直接报错。
  普通资源 Motion 没有持久化时长，只校验 `fadeInSeconds` 为有限非负数。
- 自定义 Motion 中每个显式 `track.fadeInSeconds` 也必须在 `durationSeconds` 内完成；
  codec 对负数、非有限值或超出时长的逐轨道进入过渡直接报错。
- 全局与逐轨道进入过渡都使用 Cubism SDK 的正弦权重
  `0.5 - 0.5 * cos(progress * PI)`，其中 `progress` 在 `[0, 1]` 内钳制；首版不把
  淡入当作线性权重，也不提供另一套自定义 easing。
- 自定义 Motion 的进入过渡可以被用户调整为长于源 `fade_in`；过渡时长与关键帧
  时间轴独立，只改变新旧 Motion 的混合权重，不移动、缩放或生成 Parameter
  关键帧，但不能超过自定义 Motion 自身的 `durationSeconds`。
- 进入过渡也可以被缩短为 `0`；这表示在 Motion 事件时刻直接由新 Motion 接管，
  同样不改变任何关键帧数据。
- 源 Motion 的 `fade_out` 只作为 `derivedFrom` 来源信息保留，不参与自定义 Motion
  的自动释放或尾帧处理；自定义 Motion 仍保持尾帧，直到后续 Motion 接管。
- 自定义 Motion 外层的 `fadeInSeconds` 是当前可编辑的进入过渡；
  `derivedFrom.fadeInSeconds` 和 `derivedFrom.fadeOutSeconds` 是转换时读取到的可选
  源值，后续编辑外层进入过渡不得改写来源信息。
- Motion3 Parameter 曲线显式声明 `FadeInTime` 时转换为对应轨道的
  `fadeInSeconds`；未声明或值小于 `0` 时轨道省略该字段并继承外层进入过渡。曲线级
  `FadeOutTime` 不进入轨道，因为自定义 Motion 不执行源淡出并保持尾帧。
- 用户后续可以编辑或移除逐轨道进入过渡覆盖；移除表示重新继承当前外层
  `fadeInSeconds`，不是恢复转换时的源值。
- Motion 在场景中按“开始事件”存在，而不是按源文件可解析出的时长划定一个必须
  独占的结束区间。普通 `playMotion` 可能没有可靠的源时长；自定义 Motion 的
  `durationSeconds` 同时表示该 Motion 输出的语句生命周期与关键帧编辑范围，但
  不表示它何时释放控制权。
- 普通资源 Motion 不保存编辑范围；时间轴需要显示其视觉长度时，可以使用运行时
  能够解析出的源时长作为派生信息，但不得写回场景或改变接管语义。
- 自定义 Motion 必须保存一个有限且大于 `0` 的编辑范围，用于约束关键帧放置、
  裁剪与延长。该值规范写为 `durationSeconds`，也是自定义 Motion 输出的语句生命周期；
  生命周期结束后继续保持尾帧，直到后续 Motion 接管。
- 后开始的普通 Motion 或自定义 Motion 接管前一个 Motion；首版不做两个 Motion
  的参数混合。即使事件在几何时间上交错，也不因“重叠”本身禁止编辑。
- 同一时间点存在多个 Motion 事件时，按时间轴稳定顺序决定接管者，并向用户
  发出顺序/接管警告。
- 接管顺序冲突只通过拖动 Motion 事件到不同时间解决；不增加额外的接管顺序、
  隐藏优先级或同帧排序字段。
- SDK Motion priority 只允许作为运行时适配器内部的强制接管机制，并统一使用足以
  让当前事件接管的值；它不属于场景数据，也不得改变时间轴已经决定的接管者。
- 同帧或接管顺序问题由现有剧本问题检测/验证系统负责提示；自定义 Motion 编辑器
  不新增交叠标记、接管提示条或专用冲突面板。
- 普通 Motion 与自定义 Motion 必须共用同一套交接语义。从普通 `playMotion`
  转换时继承源动作的 Fade In 设置。
- 转换后默认继承源 Motion 的进入过渡；用户可在 Motion 语句块上调整，设置为
  `0` 表示直接切换。源 Motion 未声明时沿用普通 Motion 的 `500ms` 默认值。
- 普通资源 Motion 的 `fadeInSeconds` 可省略；省略时先读取源 Motion 的 `fade_in`，
  源也未声明时使用 `0.5s`。自定义 Motion 必须显式保存最终生效的
  `fadeInSeconds`，转换后不再重新读取源资源。
- 本需求不包含 Motion 循环播放、循环创作或循环接缝工具。
- 自定义 Motion 必须在 Motion 求值阶段工作；呼吸、眨眼、口型和 physics 继续
  在其正常阶段运行，不烘焙进 Motion 关键帧。
- Motion 本身可以并且通常会驱动眼睛、眉毛、嘴型等面部 Parameter；这些源
  Motion 曲线必须和身体 Parameter 一样转换为可编辑轨道。
- Motion3 中 `Target: "Model"` 的 `EyeBlink` 与 `LipSync` 是源 Motion 自身的效果
  曲线，不属于独立运行时眨眼或实时口型。转换时必须按当前模型声明的效果目标展开：
  `EyeBlink` 与目标眼睛 Parameter 曲线相乘，`LipSync` 与目标嘴部 Parameter 曲线
  相加；目标 Parameter 已有直接源曲线时，先按 Cubism SDK 规则组合，再生成一条
  自包含的最终 Parameter 轨道。
- Motion3 的 `Model Opacity` 与 `PartOpacity` 都属于直接透明度变化，转换时忽略，
  不生成 Parameter 轨道。
- Expression 是位于 Motion 之上的独立覆盖/混合层。转换 Motion 时不采样当前
  激活的 Expression，但舞台与只读最终值必须呈现 Expression 叠加后的结果。
- 编辑 Motion 时始终保持完整 Expression 叠加预览，不提供“仅预览 Motion”的
  静音开关。
- Expression 生命周期继续由独立的 `setExpression` 语句控制；播放普通 Motion
  或自定义 Motion 不自动改变 Expression。
- 从一个 Expression 切换到另一个 Expression 时，后者直接替换前者，并沿用
  Expression 资源及 Cubism SDK 队列的原生淡入淡出语义。Cubism 2.1 资源未声明
  `fade_in` 或 `fade_out` 时沿用当前运行时的 `500ms` 默认值。
- 首版不在 `setExpression` 语句块上增加独立的淡入、淡出或交叉淡化参数。
- `default` 是一个特殊的 Expression 释放语义：执行后停止 Expression 对参数的
  覆盖，把控制权交还给当前 Motion。它不应被当作一个普通可编辑的表情覆盖层。
- 执行 `default` 时，当前 Expression 按自身 `fade_out` 渐退；渐退期间与当时
  正在运行的 Motion 实时混合，结束后完全释放给 Motion。没有活动 Expression
  时，`default` 不产生运行时变化。
- 模型没有名为 `default` 的资源时，运行时仍应把该语义映射到对应的默认/重置
  Expression API；模型有 `default` 资源时，也按“交还给 Motion”语义处理。
- Preview、Seek、Bake 和 Export 必须使用同一 Motion 求值语义。

这要求替换当前“Parameter Clip 在帧末通过 `injectedParams` 重写参数”的运行方式。
当前实现还会累积历史 Parameter Clip；这也不符合“最新 Motion 接管”的规则。

## 从已有 Motion 生成可编辑曲线

### Cubism 2.1

- 复用现有 Seek 系统的 motion-only 推进能力，从 Motion 开始顺序推进到结束。
- 采样时只运行 Motion Queue，不运行独立 Expression、呼吸、眨眼、口型或
  physics。Motion 文件自身包含的面部 Parameter 曲线属于 Motion Queue，必须采样。
- `.mtn` 中普通 Parameter 曲线不按 ID 名称筛选；手臂、手、服装、自定义开关以及
  通过 Parameter 间接控制遮挡或显隐的曲线都必须采样。`VISIBLE:` 等直接 Parts
  透明度或可见性曲线从自定义 Motion 转换中排除。
- Cubism 2.1 没有 Motion3 的 `Target: "Model"` 效果曲线；眼睛、嘴部及其他面部动作
  按普通 Parameter 曲线处理，不适用下述 Model 效果展开规则。
- 排除 Parts 曲线后没有任何 Parameter 曲线时停止转换，保留普通 Motion，不进入
  空白轨道编辑状态。
- 转换采样时必须在隔离的 Motion 实例上将源 `fade_in` 和 `fade_out` 设为 `0`，
  读取权重为 100% 的纯 Motion 曲线，避免把淡入烘焙进关键帧后又由语句块重复
  执行。该实例不得污染普通播放使用的 Motion 缓存；源 `fade_in` 仍单独保留为
  语句块进入过渡，源 `fade_out` 仍只保留为来源信息。
- 先枚举源 Motion 文件明确包含的 Parameter 曲线，再在每个场景帧追踪 motion-only
  求值向这些 Parameter 提交的、尚未按模型范围钳制的绝对目标值，并逐条生成可编辑
  轨道；不读取或实体化无关 Parameter。追踪不得包含 Motion 之外的更新阶段，也不得
  用 core model 更新后的读回值替代 Motion 写入值。
- 对组合角色分别采样每个实际播放该 Motion key 的具体模型。只存在于子模型的
  Parameter 仍进入结果；多个具体模型对同一 ID 的采样曲线一致时合并，不一致时按
  角色级 Parameter 冲突使转换失败。
- 源 Motion 显式写入但动作期间数值不变的静态轨道至少保留 `F0` 与动作结束边界
  关键帧。源 Motion 在 `F0` 写入的原始目标值就是该轨道的起始值，不从模型默认值、
  上一场景 Motion 或钳制后的模型读回值猜测。
- 源资源无法读取或解析、运行时无法取得有限且大于 `0` 的源 Motion 时长、隔离的
  motion-only 求值无法完成，或任意源 Parameter 曲线产生 `NaN` / `Infinity` 等非有限
  采样值时，转换失败；不得跳过失败曲线后保存残缺副本。
- Cubism 2.1 的源曲线指向当前目标模型不存在的 Parameter，导致运行时无法求出该
  曲线时，也属于无法取得完整采样结果，整个转换失败。
- 转换副本的采样范围以模型运行时实际解析出的源 Motion 时长为准，从 `F0` 采样
  到源 Motion 尾帧；不使用下一个 Motion 事件或场景结束时间推断源时长。
- 转换失败时不生成不完整副本，当前普通 Motion 及场景文档保持不变。
- 转换时忽略迁移输入中原 `playMotion` 的 `durationSeconds`：它不参与采样、不截断
  曲线，也不作为自定义 Motion 的编辑范围依据。自定义 Motion 保存完整源 Motion，
  初始 `durationSeconds` 取源 Motion 实际解析时长与有效 `fadeInSeconds` 的较大值。
- 当有效 `fadeInSeconds` 长于源曲线时，只延长尾值保持区以容纳完整进入过渡；
  Parameter 关键帧仍生成到源曲线末端，不在延长后的生命周期末端追加伪关键帧。
- Cubism 2.1 首版不直接解析 `.mtn` 内部关键点；统一以 motion-only Seek 的实际
  运行结果逐帧采样并自适应拟合。只有未来能够证明直接解析与运行时结果完全
  等价时，才可把解析作为优化路径，且不得改变转换输出语义。

### Cubism 3/4/5

- 后续直接解析 `.motion3.json` 的 Parameter 目标曲线，精确保留原生 Linear、
  Bezier、Stepped 和 Inverse Stepped 分段、源关键点及其运行曲线。直接
  `PartOpacity` / Parts 可见性曲线不生成自定义 Motion 轨道。
- 同时解析 `Target: "Model"` 的 `EyeBlink` 与 `LipSync` 曲线，并根据当前目标模型
  配置的效果 Parameter ID 展开。展开结果与同 ID 的直接 Parameter 曲线按 SDK
  乘法/加法顺序组合后，保存为一条普通 Parameter 轨道；转换后不再保留 Model
  效果曲线或依赖目标列表。
- 组合结果通常不能继续用一条原生三次 Bezier 精确表示。受 Model 效果影响的轨道
  按 `scene.meta.fps ?? 60` 求出每个场景帧的组合后原始目标值，保存为逐帧 Linear
  关键帧；不对这些展开轨道自动精简。未受影响的直接 Parameter 轨道仍保留其原生
  分段结构。
- `Target: "Model"` 的 `Opacity` 与 `Target: "PartOpacity"` 一并忽略。
- 这些分段使用最终 v4 已定义的统一轨道结构，不引入另一套 Motion3 专用场景数据。
- 原生 Motion3 曲线不经过逐帧采样、自适应拟合或密度选择；转换结果必须与源
  曲线结构一致。
- Motion3 Bezier 控制点写入统一分段结构的绝对 `time` / `value`，不转换成归一化
  切线句柄。非受限 Bezier 原样保存控制点；`AreBeziersRestricted` 为 `true` 时按
  SDK 实际求值语义把控制点时间规范为分段的 `1/3` 与 `2/3`，不保留原本被 SDK
  忽略的控制点时间。
- Motion3 Parameter 曲线显式声明的 `FadeInTime` 写入对应
  `track.fadeInSeconds`；未声明或值小于 `0` 时继承 Motion 输出全局淡入，不把负值
  写入场景。逐曲线 `FadeOutTime` 不保存，也不烘焙进关键帧。
- Motion3 转换后的初始 `durationSeconds` 取文件 `Meta.Duration`、外层
  `fadeInSeconds` 与所有显式 `track.fadeInSeconds` 的最大值。`Meta.Duration` 必须
  有限且大于 `0`；进入过渡更长时只延长尾值保持区，不生成伪关键帧。
- 当前 AeonStagery 没有消费 Motion3 `UserData` Motion 事件；转换忽略这些事件，不把
  底层库的 `motion:<value>` 发射扩展为场景字段。未来若产品引入 Motion 事件语义，
  必须另行定义普通 Motion 与自定义 Motion 的共同契约。
- 接入 Cubism 3/4/5 原生创作时，曲线编辑器应支持其原生分段类型和控制点编辑，
  不把 Bezier 或阶梯分段压成线性关键帧。

### Cubism 2.1 关键帧生成密度

- Cubism 2.1 的逐帧 Seek 结果是曲线重建输入，不默认把每个采样帧直接暴露为
  一个可编辑关键帧。
- 先从原始采样点构建不额外平滑的连续基准曲线，避免拟合过程先行改变源动作。
- 强制保留 `F0`、Motion 末端、采样中明确的突变边界，以及显著度超过当前误差阈值的
  有效极值；不把采样噪声形成的所有微小极值都设为强制点。
- 计算基准曲线的局部复杂度，按等复杂度间隔生成初始候选点，再使用 2.1 编辑器
  最终输出的线性关键帧重建曲线。
- Cubism 2.1 的自动候选点只能选取原始 Seek 的整数场景帧，不在两个采样帧之间
  自动生成子帧时间。Cubism 3/4/5 原生关键点则保留源文件中的精确时间。
- 用全部原始采样点检查拟合结果的最大误差 `E_max`。未达标时在当前最大误差处
  加点；达标后逐个尝试删除影响最小的非强制点，直到继续删除会超过 `E_max`。
- 每个拟合档位先计算允许的绝对最大误差
  `allowedError = max(errorRatio * scale, 0.001)`。能读取可靠且非零的 `min/max` 时，
  `scale = max - min`；读不到时，`scale` 使用该轨道全部原始采样值的实际运动幅度。
  `0.001` 是所有拟合档共用的绝对容差下限，避免把浮点抖动当成有效动作；静态或
  近静态轨道不得因归一化分母过小生成大量关键帧。
- 转换 UI 提供 `精简`、`标准`、`精细`、`逐帧` 四档关键帧密度，默认选择
  `标准`。`精简`、`标准`、`精细` 的 `errorRatio` 分别为 `5%`、`2%`、`0.5%`；
  普通用户只看到档位名称，不直接编辑误差数值。`逐帧`跳过拟合，保留每个场景帧
  的采样点。
- 密度档位作用于整个 Motion，不提供逐 Parameter 密度设置。所有轨道共用同一
  误差档位，自适应算法按各自复杂度生成不同数量的关键帧。
- 拟合档位的输出点数自适应变化：简单轨道可能只有 `2-5` 个点，普通轨道通常
  以 `20` 个以内为目标，复杂轨道允许超过 `20` 个以满足 `E_max`，不把 `20`
  作为硬上限，也不提供固定最大关键帧数选项。
- 密度是一次性的曲线生成参数，不是转换后持续作用于关键帧的实时属性。转换
  确认前可以切换档位、预览结果并查看生成的关键帧数量。
- 三个误差比例、绝对容差下限和拟合步骤属于版本化的内部转换算法契约。后续调参
  必须递增拟合算法版本并更新确定性测试，但算法版本和本次密度档位不持久化为
  自定义 Motion 的持续属性；既有自包含关键帧不会因版本升级自动变化。
- 转换完成后不显示会自动重拟合的密度滑杆。更换密度必须显式执行“从源 Motion
  重新生成”，并在执行前提示当前全部关键帧及手工编辑都会被替换；源 Motion
  不可用时不能重新生成，但现有自包含 Motion 仍可正常编辑和播放。
- “从源 Motion 重新生成”只在当前目标角色模型中显式解析 `derivedFrom.key`；找不到
  对应 Motion 时禁止重新生成，不用路径或内容指纹猜测其他来源。
- 重新生成是源派生内容的整体原子替换：删除当前全部轨道、关键帧、手工逐轨道
  `fadeInSeconds`、裁剪和延长结果，再按新源内容与本次选择的密度档位生成完整轨道；
  不尝试把旧关键帧、旧轨道或旧逐轨道淡入合并进新结果。
- 重新生成刷新 `derivedFrom.fadeInSeconds` / `fadeOutSeconds`，并把
  `durationSeconds` 重置为新源时长、当前外层 `fadeInSeconds` 与新生成的显式
  `track.fadeInSeconds` 的最大值。当前外层 `fadeInSeconds` 始终保留，因为它是用户
  独立创作的 Motion 输出进入过渡，不是源曲线生成结果。
- 重新生成保留原角色表演的 statement / companion 身份、场景时间、目标角色、稳定
  排序位置以及同实体的 Expression、LookAt 与 Blink。单机模式下整体形成一条 Undo
  记录；协作模式下提交前必须持有该角色表演实体的编辑租约。
- 重新生成预览、取消或任意轨道转换失败都不得修改当前自包含 Motion；只有完整新结果
  通过校验后才一次性替换。
- 时间轴显示实际生成的关键帧，不在低缩放级别用“密度带”替代关键帧菱形。
- 用户手动编辑过的点不得被后台自动简化。

## 编辑会话架构（2026-09-04）

关键帧编辑采用 ADR-0028 定义的应用级 `CustomMotionEditing` 深模块。它是关键帧
写入的唯一 UI seam：轨道区、曲线区、Inspector 和动作菜单只提交会话内的编辑意图，
不直接调用 `CustomMotionEditLeaseGate`、`CustomMotionKeyframeEditCommand` 或
`SemanticAuthoringApplicationService`。`CustomMotionAuthoring` 只可作为转换流程的
内部协调器，不能继续承担一层“每批 acquire、finally release”的公开 facade。

会话有一个不透明代际句柄和四种可观察阶段：`pending`、`held`、`readonly`、
`closed`。展开编辑器立即创建会话并申请编辑权；关闭、折叠、切换 Motion、关闭场景
或退出协作立即结束会话并释放租约。一个客户端同一时间只允许一个会话、一个临时
候选和一个提交中的交互。

编辑器把一次拖动、连续数值输入或离散批处理表示为一个 edit intent：

- `preview(intent)` 只从当前已提交 Motion 计算临时候选，舞台、曲线和 Inspector
  都读取同一候选；它不改变 DocumentStore、协作状态、脏标记或 Undo。
- `commit()` 只提交当前候选；取得租约后在同一 `authorTransaction` 内重新解析目标、
  校验 Motion 结构版本并原子替换，恰好产生一条 Undo。pending 时最多等待当前这一
  个提交，不缓存后续手势。
- 租约被拒绝、超时、丢失，或目标删除、场景替换、Motion 被其他状态改写时，候选
  立即丢弃；编辑器进入只读或结束状态，不自动 rebase、覆盖远端变化或静默重试。
  关闭或切换会先禁止新提交；已经进入 authoring transaction 的提交完成后才释放
  租约，尚未进入事务的 pending 提交直接丢弃。

编辑意图不把持久化秒数或租约 token 暴露给 UI。关键帧引用只在当前会话有效；新增
和主动移动使用整数 `frame`，由会话按打开时的 `scene.meta.fps ?? 60` 转成秒，
而 value-only 修改使用引用对应的精确原时间。已有 Cubism 3/4/5 子帧点及其 Bezier
控制点在未主动移动时逐位保留；修改场景 fps 只取消当前临时候选并刷新帧显示，不
重写已保存的秒值。`CustomMotionKeyframeEdit`、F0/Bezier 修复、碰撞处理和严格
codec 校验留在会话实现内，所有视图共用这一实现。

提交前的目标复核采用严格的 `sceneId + locator + custom-motion fingerprint`。
只要任一项不匹配就放弃候选，不进行字段级合并；同一实体的 Expression、LookAt 或
Blink 只有在其自身合法 authoring 事务中变化时才由当前文档保留，不能被 Motion
会话用旧快照覆盖。

普通 Motion 转换和 `derivedFrom` 重新生成仍是确认式短事务，不属于展开会话的预览。
成功后若立即展开编辑器，转换事务把已取得的内部租约 ownership handoff 给会话；
否则转换完成、取消或失败后立即释放。该转交不产生第二次 acquire，也不把租约
能力暴露给 React。

### 实现迁移边界

实现按以下顺序迁移，保持当前纯求值与 codec 行为不变：先建立会话和内存 authority
Adapter 的契约测试，再把现有协作 gate 接入 production Adapter；随后由 composition
root 创建单例会话，TrackArea 只负责放置编辑器，Inspector/菜单只调用 `open`，
最后移除 `EditorStore.customMotionEditorActionId`、编辑器本地 preview 和固定
`0.05s` 时间换算。旧的逐批租约测试改为会话接口测试，纯 `customMotionKeyframeEdits`
测试继续保留为内部规则测试；转换命令仍作为独立的确认式转换模块，不与会话生命周期
混合。

## 主时间轴呈现

- 自定义 Motion 仍是主场景时间轴中的一个角色 Motion 片段。
- 默认折叠，只显示 Motion 片段。
- 同一角色存在多个自定义 Motion 时，Parameter 轨道区只展开当前选中的
  自定义 Motion；其他 Motion 保持折叠。切换 Motion 选择时，轨道区随之切换，
  不同时展示或合并多个 Motion 的同名 Parameter 轨道。
- 主时间轴把同一角色的 Motion 作为动作事件序列呈现；不要求普通 Motion 先
  解析出结束时间才能编辑或转换。
- Motion 语句块单独呈现进入过渡时长；进入过渡不是 Parameter 关键帧数据的一部分。
- 进入过渡可通过语句块起点的过渡区域或手柄调整；调整它不得移动、生成或删除
  Parameter 关键帧。
- 展开后显示转换阶段已生成的全部可编辑 Parameter 轨道，包括数值保持不变的
  源写入静态轨道；不显示源 Motion 未写入的 Parameter 或可编辑的空轨道。
- 提供两种同步视图：
  - “关键帧”视图紧凑显示全部 Parameter 和关键帧菱形。
  - “曲线”视图为当前选中的单个 Parameter 提供独立且足够高的放大编辑区，
    显示数值曲线与可拖动曲线点；它不是把每个 Parameter 的曲线挤在一条矮行中。
- 曲线视图中，其他 Parameter 只保留为切换当前编辑对象的列表，不同时绘制多条
  矮曲线。切回关键帧视图后重新显示全部 Parameter 的紧凑轨道总览。
- 两种视图编辑同一份 Motion 数据，不产生两套副本。
- 关键帧增删与导航使用 Motion 展开区内的“当前 Parameter 工具栏”，不在每条
  紧凑矮轨道上重复放置一组控件。点击 Parameter 行后，该行成为当前轨道。
- 当前 Parameter 工具栏提供“上一个关键帧、当前帧关键帧开关、下一个关键帧”
  三个图标按钮，并在关键帧视图和曲线视图中保持相同位置和行为。
- 播放头处没有关键帧时，菱形开关以当前曲线值无损插入；已有关键帧时删除该点。
  `F0` 的删除操作禁用并说明强制起点原因。Inspector 修改数值仍可按既定规则
  自动插入或更新关键帧。

## Parameter 名称与分类

Parameter 面板必须面向动作制作者，不要求用户理解原始 Parameter ID。

名称解析与分类只决定显示方式。任何无法识别、名称特殊或不在常见 Cubism 别名表中的
源 Parameter 仍必须生成轨道，不得因归入“其他参数”而被转换器忽略。

显示信息按以下优先级解析：

1. 模型提供的名称与分类。
2. 项目已有的模型 Parameter 说明数据。
3. 内置的常见 Cubism Parameter 别名表。
4. 基于名称关键词、方向和左右侧的启发式匹配。
5. 无法识别时归入“其他参数”，显示清理后的名称，并以次要信息或 Tooltip
   保留原始 Parameter ID。

至少应尝试映射到头部、眼睛、眉毛、嘴部、身体、手臂与手、头发与服装、
配件、物理相关和其他参数等用户可理解的分类。

当前明确跳过“用户修改名称/分类并保存项目级映射”的功能。

## 选择、播放头与 Inspector

- 关键帧选择和 Parameter 轨道选择是两个不同状态。
- 进入曲线视图时直接清除全部关键帧选择，不从关键帧总览保留当前轨道或其他
  轨道的选择。曲线视图中切换 Parameter 时也清除关键帧选择；切回总览时不恢复。
- 播放过程中允许查看曲线、舞台以及随时间变化的 Motion 值和最终值。
- 用户在播放中开始拖动关键帧、滑杆或数值控件，或者执行添加、删除等任何
  关键帧写操作时，系统先在当前整数场景帧暂停播放。编辑器展开时已经开始申请协作
  编辑权；pending 期间只允许临时预览，取得编辑权后才提交修改。
- 关键帧写入期间播放头保持不动；操作结束后不自动恢复播放。点击某个关键帧
  进入编辑时同样暂停，并把播放头定位到该关键帧。
- 非曲线视图的 Inspector 数值控件与曲线视图必须共用同一个 Parameter 范围解析
  结果，包括 `min`、`max` 和 `default`；两种视图不得分别推断范围。
- Inspector 现有数值控件的边界与曲线视图纵轴都使用同一 `min-max`，曲线视图
  同时标出 `default` 基准线。垂直拖动和数字输入都钳制到该范围，切换视图不
  改变范围语义。
- 上述钳制只适用于模型或可信元数据能够提供可靠 `min/max` 的 Parameter。
- 模型无法提供可靠范围时，不为 Parameter 发明可编辑上下限；任何有限数值都可
  输入和保存。Inspector 与曲线视图仍必须共同使用同一套“范围未知”语义。
- 范围未知时，曲线纵轴按当前 Motion 中该轨道自身的最低值和最高值确定，并在
  上下两端增加少量显示留白。这个纵轴只是视图范围，不限制关键帧数值。
- 范围未知的静态轨道进入曲线视图时，以当前值为中心提供一个最小可编辑纵轴
  高度，避免最低值与最高值相同而无法垂直拖动。
- 范围可靠时，Inspector 同时提供使用完整 `min-max` 的滑杆和项目现有的
  `InlineNumericInput`：滑杆负责高效快速调整，现有数值控件负责拖拽与精确输入，
  两者读写同一个 Motion 值并同步更新。
- 范围未知时不显示伪造边界的滑杆，只使用现有 `InlineNumericInput`。该控件保持
  当前交互：点击进入精确数字输入，水平拖拽连续调整，拖动期间发送临时预览值，
  松手后提交最终值，并保留现有键盘步进能力。
- 范围可靠时向滑杆和现有数值控件提供统一 `min/max` 并按该范围校验；范围未知
  时不向现有数值控件传入人为边界，允许输入和拖拽到任意有限数值。
- `InlineNumericInput` 和滑杆共用自适应 `step`：以当前统一范围或范围未知时的曲线
  显示跨度为基准，使约 `500px` 的拖动覆盖当前数值跨度，并将步进规整为
  `1 / 2 / 5 x 10^n`，最低拖动精度为 `0.001`。
- 范围未知的静态轨道使用其最小显示跨度计算步进。保留现有控件的 `Shift` 五倍
  粗调行为；直接键入精确数值时不强制对齐步进。
- 选中 Cubism 2.1 关键帧时，Inspector 只编辑该关键帧的时间和绝对值，不提供
  Bezier 控制柄、切线或插值类型编辑。
- 移动播放头后清除关键帧选择，但保留 Parameter 轨道选择。
- 此时 Inspector 显示播放头位置的求值结果；编辑数值会在播放头处自动创建
  或更新该已生成轨道的关键帧并选中它。
- 一次滑杆或现有数值控件的拖动，以及一次连续数值输入，只生成一次可撤销操作。
- Inspector 与舞台预览必须同步显示完整运行管线的最终结果。
- Inspector 同时显示两个明确区分的值：
  - `Motion 值`是关键帧实际保存的数据，可以编辑。
  - `最终值`是完整运行管线求值后的当前结果，只读显示。
- 修改 Motion 值后立即重新求值并刷新舞台与最终值。Physics 等有状态系统不要求
  从最终值反解 Motion 值。
- 当当前 Parameter 同时受到 Expression 影响时，Inspector 显示被动状态提示，
  例如 `Expression：覆盖中`；该提示只解释最终值来源，不提供关闭 Expression、
  切换预览层或“仅预览 Motion”的控制。
- 选中多个关键帧时，Inspector 不显示可编辑的单点时间和值，也不把任一点伪装
  成整组当前值；改为显示已选数量、涉及的 Parameter 数量和起止帧。
- 多选全部来自同一 Parameter 时，摘要额外显示该组 Motion 值的最低值和最高值。
  Inspector 保留复制、剪切和删除命令；剪切和删除只作用于非 `F0` 点，整组时间或
  数值调整通过既定拖动完成。
- 选择重新变为单个关键帧时，Inspector 恢复单点时间和值编辑。

## 新增与编辑关键帧

- 在已有曲线上点击“添加关键帧”时，先计算该时刻的现有曲线值，再无损分割
  原线段；插入操作本身不得改变动作。
- 在当前帧没有关键帧时直接修改数值，等价于“在已有曲线上无损插入后修改”，
  并合并为一次撤销。
- 允许用户把曲线的第一编辑关键帧移动到 `F0` 之后；移动后在 `F0` 保留一个
  等值起点关键帧，保证动作从零时刻开始始终有定义且不产生突跳。
- 关键帧拖动只改变曲线内部关键帧时间，不改变整个 Motion 语句块的起始时间。
- 每条已生成轨道必须保留 `F0` 边界关键帧。`F0` 不参与删除或剪切；仅选中 `F0`
  时对应命令禁用，多选包含 `F0` 时只处理其他点并提示起点受保护。若要改变动作
  起始值，应直接编辑 `F0`。
- 用户把 `F0` 关键帧拖到后续帧时，原关键帧可成为内部关键帧，但系统必须在
  `F0` 自动留下同值边界点；该操作只调整动作内部节奏，不移动 Motion 事件。
- 转换生成时保留源 Motion 的末帧采样点，以保证初始转换结果保真；该点在用户
  编辑后不是强制边界，可以被删除或向前移动。
- Motion 编辑范围独立于最后一个关键帧。最后一个剩余关键帧之后保持其值直到
  编辑范围结束；延长 Motion 时继续保持尾值，不自动在新末端生成关键帧。
- 同一 Parameter 轨道的同一精确时间只允许一个关键帧。原生子帧点可以在同一场景
  帧区间内共存；拖动时可以经过已有点，但不能落在已被占用的精确时间。
- 松手时若目标整数帧时间已有关键帧，拖动点落到最近的可用整数帧；系统不自动覆盖、
  合并或删除任一关键帧。若用户要替换目标点，应先删除它或直接编辑其值。
- 首版支持同时选择多个关键帧：`Shift + 点击`增减选择，关键帧区域支持框选，
  且一次选择可以跨越多个 Parameter 轨道。
- 水平拖动任一已选关键帧时，全部选中点保持彼此的相对时间间距整体移动；
  `Delete` 一次删除全部选中的非 `F0` 点，各轨道的 `F0` 始终保留。
- 多选整体移动时，所有选中点使用同一个整数帧偏移量。任一点即将与其轨道上
  未选中的关键帧冲突，或即将移出 Motion 编辑范围时，整组停在最近的合法偏移量；
  不允许各点分别避让、覆盖或丢弃，以保持跨轨道的相对时序不变。
- 若选中的 `F0` 被整体向后移动，仍按既定规则在该轨道留下同值 `F0` 边界点；
  自动留下的新边界点不加入当前选择。
- 多选不提供按比例拉伸关键帧时间，也不支持跨 Parameter 批量修改数值；不同
  Parameter 的范围和语义不能被当作同一数值批量处理。
- 在曲线视图内多选同一 Parameter 的多个关键帧后，可以整体二维移动；所有点
  保持彼此的时间差和值差。水平方向继续遵循整组碰撞和编辑范围约束。
- 同轨多选整体垂直移动时，存在可靠 `min/max` 则由最先碰到数值边界的点限制
  整组偏移；范围未知时不限制偏移，并按既定规则平移和重新适配纵轴。
- 曲线视图的同轨多选继续支持 `Shift` 主方向锁定；该能力不扩展为跨 Parameter
  批量修改数值。
- 首版支持在当前自定义 Motion 内复制、剪切和粘贴所选关键帧。粘贴时把所选
  内容中最早的关键帧对齐播放头，并保持各点的 Parameter 轨道归属与相对时间。
- 粘贴预览若有任一点与已有关键帧冲突或超出 Motion 编辑范围，则整次粘贴不
  执行，不自动覆盖或只粘贴其中一部分。剪切和粘贴分别形成一条撤销记录。
- 复制可以包含 `F0`；被复制的 `F0` 粘贴到其他时间后只是普通关键帧，不携带强制
  边界身份。剪切只把非 `F0` 点写入剪贴板并从原轨道移除，受保护的 `F0` 不参与
  该次剪切。
- 不允许跨自定义 Motion 复制粘贴关键帧，也不提供粘贴时的 Parameter 轨道重映射。
- 在曲线视图的放大编辑区中，拖动单个关键帧点可以同时修改时间和值：水平位置
  始终吸附整数场景帧，垂直位置修改 Motion 值；仅在存在可靠模型范围时钳制，
  范围未知时不施加人为数值上下限。
- 斜向拖动可同时改变时间和值；按住 `Shift` 时锁定拖动开始后最先形成的主方向，
  便于只修改时间或只修改数值。紧凑关键帧视图仍只允许水平拖动。
- 曲线点拖动期间只更新本地临时预览，舞台和只读最终值实时刷新；松手时一次性
  提交并形成一条撤销记录，不为每次指针移动写入场景历史。
- 对范围未知的 Parameter，垂直拖动到曲线区顶部或底部后，纵轴沿该方向平移，
  允许数值继续增减；拖动期间保持每像素对应的数值变化量稳定，不反复缩放曲线。
- 范围未知的拖动提交后，再按该轨道新的最低值和最高值加留白重新适配纵轴。
  有可靠模型范围的 Parameter 不扩展纵轴，拖动在真实 `min/max` 处停止。
- 插入已有线段时继承并保留原线段的插值类型；在原生 Motion3 的 Bezier 分段中
  插点时还必须无损分割控制点。
- 在曲线末尾追加或从空白创建时，默认使用线性插值。
- Cubism 2.1 拟合结果只使用线性插值。长时间不变或近似不变的区间由自适应
  拟合自动删除中间冗余点，不从离散采样值猜测源 Motion 是否具有保持语义；
  首版不提供插值类型切换。
- Cubism 3/4/5 原生编辑后续支持源格式已有的 Linear、Bezier、Stepped 和
  Inverse Stepped，以及对应控制点编辑。

## 时间基准

- 关键帧编辑以 `scene.meta.fps` 为权威帧率；该字段省略时使用 `60fps`。不为自定义
  Motion 再保存一份独立帧率。
- UI 主要显示帧号，并在 Inspector 同时显示秒数。
- Cubism 2.1 的新建、拖动和时间输入始终落在整数场景帧，不提供关闭吸附或
  创建子帧关键点的功能；`60fps` 是首版足够的编辑精度。
- Cubism 3/4/5 原生导入若包含非整帧时间，内部仍原样保留以保证源曲线保真；
  这不作为用户可新建的子帧功能。同一场景帧区间内可以显示多个不同精确时间的
  原生点，UI 使用小数帧位置区分；用户主动移动任一点时才吸附到整数场景帧。
- 数据内部继续以秒保存，避免破坏现有时间线与场景数据契约。
- 修改 `scene.meta.fps` 时，现有自定义 Motion 的 `durationSeconds`、关键帧时间与
  Bezier 控制点时间均保持秒值不变，不批量重定时、取整或吸附。换算后落在新帧率
  小数帧的点由 UI 如实显示；用户主动移动后才吸附到新帧率的整数帧。
- Cubism 2.1 采样按场景帧率执行；源 Motion 有不同帧率时按时间换算，
  不改变动作时长。

## Motion 裁剪

- 不提供按比例缩放关键帧时间的功能。
- 自定义 Motion 的 `durationSeconds` 不能缩短到当前外层 `fadeInSeconds` 或任一显式
  `track.fadeInSeconds` 以下；终点手柄在其中最大值处停止，系统不自动缩短任何进入
  过渡。用户必须先主动减小对应淡入，才能继续缩短 Motion。
- 缩短 Motion 片段是破坏性裁剪，范围外的关键帧直接删除。
- 拉回原长度不会恢复关键帧，只能通过 Undo 恢复。
- 延长 Motion 片段只延长尾帧保持区间，或为新增关键帧提供空间。
- 如果裁剪点位于两个关键帧之间，先按原曲线在裁剪点自动创建边界关键帧，
  再删除范围外关键帧，以保持保留区间的画面不变。
- 左侧裁剪沿用现有时间轴起点手柄语义：保持原右端场景时间不变，把承载该 Motion
  的整个 `characterPerformance` 源实体后移裁剪量，并把自定义 Motion 的
  `durationSeconds` 缩短相同数值。顶层语句修改 `statement.time`；对话 companion
  修改其相对锚点的 `offset`。
- 因角色表演只有一个场景时间，同一实体中的 Expression、LookAt 与 Blink 也随左裁剪
  一起后移。UI 在拖动预览和提交前明确显示这些输出的联动；首版不在裁剪时隐式拆分
  语句。需要独立时间时，用户应先把 Motion 创作为单独的角色表演。
- 左侧裁剪对每条 Parameter 轨道在裁剪点求值并建立新的 `F0` 边界关键帧，删除更早
  的点，再把保留关键帧及 Bezier 控制点时间整体减去裁剪量；关键帧间距和值不缩放。
- 左侧裁剪不自动修改外层或逐轨道 `fadeInSeconds`，新的 Motion 事件从后移后的场景
  时间重新执行进入过渡。若缩短后的 `durationSeconds` 将小于任一有效进入过渡，
  起点手柄在合法边界停止，用户必须先主动缩短相应淡入。
- 左裁剪涉及的实体时间、Motion 时长和全部轨道变更作为一条原子 authoring 事务提交，
  单机形成一条 Undo 记录；协作模式要求持有同一角色表演实体的编辑租约。

## 动作库与跨模型兼容

- 首版只保存场景内联的完整关键帧轨道，不保存“基础 Motion + 差异补丁”。
- “保存到动作库”留作成熟后的复用能力；未来只提供动作的最新内容，不设计
  历史版本选择。动作如何从库中进入场景、采用复制还是引用，当前不作定义。
- 未来的复用能力应允许把动作应用到不同 Live2D 模型。
- 目标模型缺失某个 Parameter 时，UI 显示不兼容提示，运行时忽略该轨道，
  其他可匹配轨道继续执行。
- 组合角色中至少一个具体模型包含轨道 ID 时即视为可匹配；轨道值写入所有包含该 ID
  的具体模型，并在必要时触发现有的子模型输入同步。只有整个角色都不存在该 ID 时
  才按缺失 Parameter 处理。
- Parameter ID 存在但关键帧原始目标值超出目标模型范围时，持久化数据保持原值，
  运行时按目标范围钳制并警告。
- 不自动按比例缩放 Parameter 值，也不因一次播放修改原动作资产。

## 未来运行时曲线缓存

- 普通 `playMotion` 在用户界面、场景语义和持久化数据中仍保持为普通 Motion，
  不因后台生成曲线缓存而自动转换成自定义 Motion。
- 未来可以按模型版本、源 Motion 文件指纹、场景帧率和拟合算法版本生成共享的
  隐藏编译曲线缓存，供 Preview、Seek、Bake 和 Export 使用。
- 隐藏缓存是可失效、可重新生成的派生数据，不写入场景业务数据，也不作为用户
  可编辑的自定义 Motion 暴露。
- 只有用户显式选择“自定义动作”并进入关键帧编辑流程时，才将曲线实体化为
  场景内联、完整且自包含的自定义 Motion。
- 该缓存属于未来性能优化方向，不属于首版关键帧编辑的交付范围。

## 多人协作边界

- 首版禁止多个协作者同时编辑同一个自定义 Motion，并把该能力定义为 ADR-0012
  乐观协作规则的范围化例外。取得编辑权的协作者可以修改关键帧；其他协作者只能
  查看和预览该 Motion，但仍可编辑场景中的其他 Motion 或其他语句。
- 用户界面称其为“自定义 Motion 编辑权”，服务端实际租约覆盖承载该 Motion 的整个
  `characterPerformance` 源实体，而不只覆盖 `params.motion`。顶层角色表演使用
  `statement.id` 作为租约身份；对话 companion 使用父 statement ID 与 companion ID
  的组合身份。
- 租约期间，其他协作者也不能修改同一角色表演实体中的 Expression、LookAt 或 Blink；
  当前协作按完整 statement / companion 发布，允许这些同实体字段并发写入会使一方
  静默覆盖另一方的自定义 Motion 内容。其他角色表演实体不受影响。
- 仅选中自定义 Motion、移动播放头和不展开关键帧编辑器的预览属于只读查看，不取得
  独占编辑权。展开关键帧编辑器表示明确进入自定义 Motion 编辑会话，客户端必须立即
  申请目标 `characterPerformance` 源实体的编辑权。
- 普通 Motion 的“自定义动作”采样预览和自定义 Motion 的“从源 Motion 重新生成”
  预览仍是只读操作；用户确认把预览结果写入场景前，客户端必须先取得目标
  `characterPerformance` 源实体的编辑租约。确认后若直接展开转换结果的关键帧编辑器，
  已取得的租约转交给该编辑会话并持续持有；未进入编辑会话、转换或重新生成失败、
  取消时不提交场景变更，并立即释放仅为该确认流程取得的租约。
- 展开关键帧编辑器后的租约申请尚未完成时，客户端可以产生不写入场景、不形成撤销
  记录且不发布协作状态的临时预览。任何关键帧、数值、时长、淡入或其他场景写入必须
  等到编辑权取得后执行；申请被拒绝、超时，或目标实体在 pending 期间失效时，必须
  丢弃临时预览。没有有效租约的同实体提交必须由服务端拒绝并触发客户端同步最新协作
  状态。
- 若其他协作者已持有编辑权，本次写操作不执行；界面切换为只读状态并显示当前
  编辑者。编辑权不能只依赖 Presence 提示，必须由服务端裁定唯一持有者，避免
  多个客户端同时抢占成功。
- 取得编辑权后，在当前关键帧编辑器展开期间持续持有，不因普通空闲自动释放，也不在
  每次关键帧操作结束后反复释放和申请。编辑器在租约 pending 或 denied 状态下保持
  只读；取得编辑权后才启用会产生场景写入的操作。
- 切换到另一个 Motion、折叠并退出当前关键帧编辑、关闭场景或退出协作时，
  客户端必须主动释放编辑权。
- 客户端持有编辑权期间必须定期向服务端续租。断网、进程崩溃、系统休眠或其他
  原因导致无法续租时，服务端在短暂超时后自动释放；首版以约 `30s` 为默认失联
  超时，可作为实现配置调整，但不向普通用户暴露。
- 首版不做逐 Parameter、逐轨道或逐关键帧的并发合并。
- 协作会话继续沿用现有全局规则，不提供 Undo/Redo。

## 明确不做

- 不改写原始 `.mtn` 或 `.motion3.json`。
- 不提供从空白 Parameter 轨道新建自定义 Motion 的入口。
- 不把呼吸、眨眼、口型和 physics 烘焙进 Motion 曲线。
- 不保存或创作 Motion3 `UserData` Motion 事件。
- 不把多个自定义 Motion 默认叠加为永久 Parameter 覆盖层。
- 不支持 Motion 循环创作与循环接缝修复。
- 不支持按比例缩放关键帧时间。
- 不支持用户维护 Parameter 名称与分类映射。
- 不静默缩放跨模型的 Parameter 数值。
- 首版不实现动作库保存、引用或共享编辑。
- Cubism 2.1 首版不提供 Bezier 控制柄、切线或插值类型编辑。
- Cubism 2.1 首版不提供子帧关键点创建或编辑。
