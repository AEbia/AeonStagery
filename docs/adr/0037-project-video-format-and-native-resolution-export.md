# ADR-0037: Project Video Format and Native Resolution Export

- Status: Accepted
- Date: 2026-10-19

## Context

导出窗口固定为 1920×1080、60 fps，舞台、角色、字幕和交互坐标也分别使用固定尺寸。仅增加编码器宽高会改变可见区域，或把已有低分辨率帧放大。项目需要横屏、竖屏、方形构图，同时允许低清编辑预览和高分辨率导出。

## Decision

- Project Metadata v2 增加可选 `videoFormat: { width, height, fps }`，宽高代表输出像素。缺省为 1920×1080、60 fps。普通旧项目编辑不补写该默认字段；用户保存画布设置时才写入。依照 ADR-0031，已知字段校验、未知字段保真，不提升 schema epoch。
- 项目画布的逻辑坐标保留项目宽高比，短边固定为 1080 个创作单位。因此 1080p 与 4K 的 16:9 项目都使用 1920×1080 逻辑坐标。相同比例的分辨率调整不会改变字体、人物位置或镜头构图。
- 预览质量是独立的本机运行时选项（1、1/2、1/4），乘以项目像素密度。它不改写项目设置，也不限制导出清晰度。原分辨率指项目像素，不再额外乘显示器 DPR。
- 导出默认跟随项目，可覆盖宽、高、fps。画面比例变化时显式选择完整画面留边（默认）或填满画面居中裁切，统一保持比例。舞台外内容不进入留边。
- 导出按目标像素密度重新渲染，提升文字与显式滤镜的采样分辨率；RawPixels 读取本次绘制的 RenderTexture，不再通过提取容器隐式重绘。导出成功、失败或取消后都恢复预览逻辑尺寸、像素密度和临时状态。
- 项目 fps 决定编辑器逐帧步长与自定义动作编辑/转换采样。导出 fps 决定逐帧求值时间间隔。时间线持续以秒表达，改 fps 不重定时已有动画；实时播放仍由实际时间推进。
- 分辨率与 fps 在创建项目时选择，后续从独立的画布设置入口修改，不放在全局设置中。画布运行时配置与场景重载统一由 `SemanticDocumentCoordinator` 的投影队列管理；设置保存等待当前场景重载完成，重载或持久化失败恢复原运行时配置并向调用方返回错误。运行时重载不创建场景文档版本或撤销记录。
- 输出宽高限制为 16–8192 的偶数，兼容常用视频编码的色度采样要求；fps 为 1–240，允许小数。底层编码器的具体能力仍由导出错误报告。
- 图片对白模板仍以 1920×1080 设计面保存。运行时横向重排面板及正文宽度，并保留顶部或底部依附；不改写模板源数据或缩放字形。

### 编码质量与回退（2026-10-20）

- 导出分离编码标准（H.264 / HEVC / VP9 / AV1）与编码实现（自动 / WebCodecs / FFmpeg）。默认均衡质量、目标码率控制；主码率同时用于原生编码和 FFmpeg 回退，避免可见参数被隐式 CRF 忽略。编码方式始终可见；只有明确选择 FFmpeg 时展示 FFmpeg 质量控制、编码器与速度，CRF 与目标码率输入互斥。自动 / WebCodecs 仅在支持中转的标准下提供中转设置。切换编码标准或编码方式保留质量预设，切换容器优先保留兼容标准。绿幕字幕开放质量控制但固定 H.264 / FFmpeg 软件编码；透明字幕保留固定 ProRes 管线。设置只作用于本次导出，不进入项目或场景 schema。
- 视频容器支持 MP4（H.264 / HEVC / AV1）、WebM（VP9 / AV1）与 MKV（H.264 / HEVC / VP9 / AV1）。MKV 默认 H.264，音频使用 AAC；容器与编码标准的兼容列表由界面和导出校验共用。透明字幕仍使用 MOV + ProRes 4444。
- WebCodecs 针对当前标准、尺寸、帧率和码率探测原生配置，采用 `latencyMode: quality`。H.264 / HEVC 输出 Annex B，VP9 / AV1 封装为带有理时间基的 IVF；FFmpeg 在接收编码流时复制视频流并同步混音、封装。若帧时间戳不连续或输出帧数不完整，视为编码能力失败，不能静默产生错误时间轴。
- 均衡模式的回退顺序为目标标准原生编码 → 高码率 H.264 流式捕获并转码 → RawPixels 单次编码。高画质默认跳过 H.264 中转；用户可在高级设置覆盖。H.264 中间流直接经 IPC 送入同一个 FFmpeg 进程转码与混音，不生成整段中间 MP4；中间码率默认是同尺寸、帧率 H.264 高画质推荐值的两倍，独立于最终目标码率。
- 原生 WebCodecs 使用目标码率；导出面板明确选择 FFmpeg CRF 后采用以下预设：均衡 x264 20 / x265 24 / VP9 32 / AV1 32，高画质分别为 18 / 20 / 28 / 28。切回自动 / WebCodecs 后，提交给导出与大小估算的配置统一使用主码率，隐藏的 CRF 不参与回退。API 调用省略 `encoding.rateControl` 时仍保留原有 CRF 默认值。CRF 只作用于执行该参数的编码阶段，不恢复中间流已丢失的信息，不同标准的数值不能直接比较。软件速度默认 x264 / x265 medium、VP9 cpu-used 2、AV1 cpu-used 6。
- RawPixels、流式转码和兼容文件转码共用视频参数构建逻辑；音频滤镜与时长限定共用同一参数构建逻辑。码率在后端保留小数 Mbps。FFmpeg 编码器默认“自动”（`encoding.ffmpegEncoder` 省略或为 `auto`）：目标码率模式按同标准的 NVENC → AMF → QSV → Media Foundation 顺序尝试能力列表中的硬件实现，再回退软件编码；能力查询失败或未提供时直接使用软件编码。编译支持不保证本机驱动可用，初始化或编码失败时继续下一候选。手动选择仍只尝试指定实现及软件回退。此选择同时作用于 WebCodecs 不可用后的 RawPixels 路径和 H.264 中转后的 FFmpeg 转码；流式转码无法重放输入文件，运行中失败需要从起点重新捕获。CRF 请求由支持它的软件编码器执行，字幕导出的固定软件管线不参与自动硬件选择。已有 `codec/backend/bitrateMbps` 调用仍兼容，新 `encoding` 设置优先。
- 原生目标编码路径直接复制视频流并同步混音；RawPixels 同步编码与混音。三条路径均不保留整段视频中间文件。已知帧数、帧率时通过 `-t` 限定混音长度，不同时使用 `-shortest`，避免 FFmpeg 7 在含重排或延迟包的短 MP4 中截掉尾帧。最终 MP4 启用 faststart；关键帧间隔约为两秒。
- Electron 主进程为每次捕获分配独立任务，视频写入目标目录内带随机任务标识的临时输出（保留格式扩展名以正确选择封装器），FFmpeg 正常关闭且空间复查通过后通过同目录重命名替换目标文件。失败、取消与渲染进程退出时先等待 FFmpeg 关闭，再清理任务文件；不删除原有目标文件。最终输出保留 faststart。任务归属记录位于系统临时目录的 `aeonstagery-export/tasks/<uuid>`，记录应用与 FFmpeg PID；启动时只回收两者均确认退出的合法任务，删除失败保留记录以便重试。无归属记录的历史临时文件不自动删除。
- 开始写入前检查输出所在文件系统可用空间；有明确目标码率及帧数时，以预计视频与音频大小的 1.2 倍加 64 MiB 安全余量检查。CRF 大小不确定，仅检查 64 MiB 安全余量，不把目标码率视为确定大小。任务记录目录也检查余量。运行中每两秒检查输出卷，FFmpeg 关闭后发布前再次检查；不足时按输出错误终止，不触发编码回退。空间检查不是磁盘配额，检查间隔内的突发耗尽仍由 FFmpeg I/O 错误报告。
- 每个编码候选只尝试一次；捕获中途失败时等待旧流关闭，恢复舞台并从导出起点重新捕获。用户取消、渲染错误和输出写入错误不触发兼容回退。透明字幕始终通过 RawPixels + ProRes 4444 保留 Alpha，不能经过 H.264 中转。

## Consequences

- 高分辨率渲染可以保留素材已有的细节，不能创造低分辨率背景或 Live2D 贴图里不存在的信息。
- 项目画布配置存储在本地 `project.json`，当前协作协议仅共享场景，不同步项目画布设置。协作参与者需使用相同的项目画布设置。
- 旧场景 `meta.resolution` / `meta.fps` 保持兼容读取，编辑器当前画布与默认帧率以项目设置为准，不向场景文档复制第二份项目设置。
- 单个编辑器窗口只有一个活动舞台；运行时尺寸通过统一 live bindings 提供。场景编译继续保持纯粹，不依赖活动舞台。旧编译点光源设计坐标在渲染边界适配。

## Implementation alignment

- 格式、校验与输出映射：[`src/api/types/video-format.ts`](../../src/api/types/video-format.ts)
- 项目兼容读写：[`src/services/project/ProjectMetadataCodec.ts`](../../src/services/project/ProjectMetadataCodec.ts)、[`src/services/io/ProjectWorkspaceService.ts`](../../src/services/io/ProjectWorkspaceService.ts)
- 舞台尺寸与生命周期：[`src/engine/StageDimensions.ts`](../../src/engine/StageDimensions.ts)、[`src/engine/StageManager.ts`](../../src/engine/StageManager.ts)、[`src/engine/Bootstrapper.ts`](../../src/engine/Bootstrapper.ts)
- 舞台持有的场景光照、角色淡入与轮廓光、对象合成和目标后处理滤镜使用 `resolution: 'inherit'`，跟随当前渲染目标的像素密度；仅提高根画布分辨率会让默认密度为 1 的父容器滤镜先降采样整个子树。回归见 [`StageFilterResolution.test.ts`](../../src/__tests__/StageFilterResolution.test.ts)，通过真实 Pixi 滤镜范围计算覆盖 4K 与低清预览切换。
- 原生像素捕获：[`src/engine/export/FrameCaptureEngine.ts`](../../src/engine/export/FrameCaptureEngine.ts)
- 文件大小预估：[`ExportAdapter.estimateSize`](../../src/api/adapters/ExportAdapter.ts) 对自动 / WebCodecs 按所选原生路径的 VBR 目标码率、时长与音频预算估算，不探测并提前抽样可能的回退路径。编码能力探测与回退由正式导出执行；若实际回退到 FFmpeg CRF，目标码率不构成最终输出限制，原生 VBR 预算可能失效。明确选择 FFmpeg 时，目标码率同样直接计算；CRF / ProRes 通过 [`ExportSizeSampler`](../../src/engine/export/ExportSizeSampler.ts) 复用实际导出设置、混音、编码和封装，在头、中、尾最多抽取三段各两秒的视频，六秒以内完整试编码，以实测文件大小按帧数推算全片，不混合不同编码路径、不使用固定倍数范围。片段外内容复杂度仍可能带来误差。抽样保留面板布局，通过 `measureOnly` 复用主进程的私有任务输出：编码关闭后读取临时文件大小，等待清理后仅返回字节数，不发布采样成品，也不依赖渲染进程删除文件。失败、取消或渲染进程退出均由主进程清理，删除失败保留任务归属记录供启动恢复重试；渲染端等待舞台位置恢复。[`useExportSizeEstimate`](../../src/ui/hooks/useExportSizeEstimate.ts) 在打开面板或修改设置后延迟 600 ms 自动估算，期间只显示“计算中”；退出页面立即取消，正式导出等待抽样清理结束，避免竞争同一个编码进程；准备阶段和保存对话框等待期间关闭或卸载面板会取消后续导出启动。回归见 `ExportSizeEstimate`、`ExportAdapter`、`ExportDialog` 与 `StreamingExportIntegration`。
- 编码质量与回退：[`src/api/exportEncoding.ts`](../../src/api/exportEncoding.ts)、[`src/api/adapters/ExportAdapter.ts`](../../src/api/adapters/ExportAdapter.ts)、[`src/engine/export/WebCodecsEncoding.ts`](../../src/engine/export/WebCodecsEncoding.ts)、[`electron/ffmpeg-args.ts`](../../electron/ffmpeg-args.ts)、[`electron/ffmpeg-export.ts`](../../electron/ffmpeg-export.ts)、[`electron/export-output.ts`](../../electron/export-output.ts)；回归覆盖 `ExportOutput`、`ExportAdapter`、`CaptureBackends`、`WebCodecsEncoding`、`FFmpegArgs`、`FFmpegExport`、`ExportMedia`、`StreamingExportIntegration` 与 `ExportDialog`。
- 用户入口：创建项目、更多操作 → 画布设置；[`src/ui/onboarding/ProjectHome.tsx`](../../src/ui/onboarding/ProjectHome.tsx)、[`src/ui/ProjectSettingsDialog.tsx`](../../src/ui/ProjectSettingsDialog.tsx)、[`src/ui/settings/ProjectVideoSettings.tsx`](../../src/ui/settings/ProjectVideoSettings.tsx)、[`src/ui/ExportDialog.tsx`](../../src/ui/ExportDialog.tsx)
- 验证：`VideoFormat`、`CompatibleProjectSession`、`ProjectWorkspaceService`、`FrameCaptureEngine`、`SubtitleFrameCapture`、`ExportDialog` 与 `StageManagerBlendModeRendererConfig` 测试。
