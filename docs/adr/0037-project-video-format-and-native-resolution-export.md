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

## Consequences

- 高分辨率渲染可以保留素材已有的细节，不能创造低分辨率背景或 Live2D 贴图里不存在的信息。
- 项目画布配置存储在本地 `project.json`，当前协作协议仅共享场景，不同步项目画布设置。协作参与者需使用相同的项目画布设置。
- 旧场景 `meta.resolution` / `meta.fps` 保持兼容读取，编辑器当前画布与默认帧率以项目设置为准，不向场景文档复制第二份项目设置。
- 单个编辑器窗口只有一个活动舞台；运行时尺寸通过统一 live bindings 提供。场景编译继续保持纯粹，不依赖活动舞台。旧编译点光源设计坐标在渲染边界适配。

## Implementation alignment

- 格式、校验与输出映射：[`src/api/types/video-format.ts`](../../src/api/types/video-format.ts)
- 项目兼容读写：[`src/services/project/ProjectMetadataCodec.ts`](../../src/services/project/ProjectMetadataCodec.ts)、[`src/services/io/ProjectWorkspaceService.ts`](../../src/services/io/ProjectWorkspaceService.ts)
- 舞台尺寸与生命周期：[`src/engine/StageDimensions.ts`](../../src/engine/StageDimensions.ts)、[`src/engine/StageManager.ts`](../../src/engine/StageManager.ts)、[`src/engine/Bootstrapper.ts`](../../src/engine/Bootstrapper.ts)
- 原生像素捕获：[`src/engine/export/FrameCaptureEngine.ts`](../../src/engine/export/FrameCaptureEngine.ts)
- 用户入口：创建项目、更多操作 → 项目设置；[`src/ui/onboarding/ProjectHome.tsx`](../../src/ui/onboarding/ProjectHome.tsx)、[`src/ui/ProjectSettingsDialog.tsx`](../../src/ui/ProjectSettingsDialog.tsx)、[`src/ui/settings/ProjectVideoSettings.tsx`](../../src/ui/settings/ProjectVideoSettings.tsx)、[`src/ui/ExportDialog.tsx`](../../src/ui/ExportDialog.tsx)
- 验证：`VideoFormat`、`CompatibleProjectSession`、`ProjectWorkspaceService`、`FrameCaptureEngine`、`SubtitleFrameCapture`、`ExportDialog` 与 `StageManagerBlendModeRendererConfig` 测试。
