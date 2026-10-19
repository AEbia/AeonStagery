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
- 分辨率与 fps 在创建项目时选择，后续从独立的项目设置入口修改，不放在全局设置中。画布运行时配置与场景重载统一由 `SemanticDocumentCoordinator` 的投影队列管理；设置保存等待当前场景重载完成，重载或持久化失败恢复原运行时配置并向调用方返回错误。运行时重载不创建场景文档版本或撤销记录。
- 输出宽高限制为 16–8192 的偶数，兼容常用视频编码的色度采样要求；fps 为 1–240，允许小数。底层编码器的具体能力仍由导出错误报告。
- 图片对白模板仍以 1920×1080 设计面保存。运行时横向重排面板及正文宽度，并保留顶部或底部依附；不改写模板源数据或缩放字形。

### 编码质量与回退（2026-10-20）

- 导出分离编码标准（H.264 / HEVC / VP9 / AV1）与编码实现（自动 / WebCodecs / FFmpeg）。默认均衡质量；高级设置提供 FFmpeg CRF / 目标码率、速度与中间流码率。设置只作用于本次导出，不进入项目或场景 schema。
- WebCodecs 针对当前标准、尺寸、帧率和码率探测原生配置，采用 `latencyMode: quality`。H.264 / HEVC 输出 Annex B，VP9 / AV1 封装为带有理时间基的 IVF；最终由 FFmpeg 复制视频流封装。若帧时间戳不连续或输出帧数不完整，视为编码能力失败，不能静默产生错误时间轴。
- 均衡模式的回退顺序为目标标准原生编码 → 高码率 H.264 捕获并转码 → RawPixels 单次编码。高画质默认跳过 H.264 中转；用户可在高级设置覆盖。H.264 中间文件使用 MP4，中间码率默认是同尺寸、帧率 H.264 高画质推荐值的两倍，独立于最终目标码率。
- 原生 WebCodecs 使用目标码率；FFmpeg 软件编码默认 CRF：均衡 x264 20 / x265 24 / VP9 32 / AV1 32，高画质分别为 18 / 20 / 28 / 28。CRF 只作用于执行该参数的编码阶段，不恢复中间流已丢失的信息，不同标准的数值不能直接比较。软件速度默认 x264 / x265 medium、VP9 cpu-used 2、AV1 cpu-used 6。
- RawPixels 和文件转码共用视频参数构建逻辑；码率在后端保留小数 Mbps。硬件实现不可用时使用同标准的软件编码；CRF 请求由支持它的软件编码器执行。已有 `codec/backend/bitrateMbps` 调用仍兼容，新 `encoding` 设置优先。
- 已完成目标编码的视频在音频合成时只复制视频流。已知帧数、帧率时通过 `-t` 限定混音长度，不同时使用 `-shortest`，避免 FFmpeg 7 在含重排或延迟包的短 MP4 中截掉尾帧。最终 MP4 启用 faststart；关键帧间隔约为两秒。
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
- 编码质量与回退：[`src/api/exportEncoding.ts`](../../src/api/exportEncoding.ts)、[`src/api/adapters/ExportAdapter.ts`](../../src/api/adapters/ExportAdapter.ts)、[`src/engine/export/WebCodecsEncoding.ts`](../../src/engine/export/WebCodecsEncoding.ts)、[`electron/ffmpeg-args.ts`](../../electron/ffmpeg-args.ts)；回归覆盖 `ExportAdapter`、`CaptureBackends`、`WebCodecsEncoding`、`FFmpegArgs`、`FFmpegExport`、`ExportMedia` 与 `ExportDialog`。
- 用户入口：创建项目、更多操作 → 项目设置；[`src/ui/onboarding/ProjectHome.tsx`](../../src/ui/onboarding/ProjectHome.tsx)、[`src/ui/ProjectSettingsDialog.tsx`](../../src/ui/ProjectSettingsDialog.tsx)、[`src/ui/settings/ProjectVideoSettings.tsx`](../../src/ui/settings/ProjectVideoSettings.tsx)、[`src/ui/ExportDialog.tsx`](../../src/ui/ExportDialog.tsx)
- 验证：`VideoFormat`、`CompatibleProjectSession`、`ProjectWorkspaceService`、`FrameCaptureEngine`、`SubtitleFrameCapture`、`ExportDialog` 与 `StageManagerBlendModeRendererConfig` 测试。
