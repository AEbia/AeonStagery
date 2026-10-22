# 摄像机生产精度与准备成本

> 本文已保存的原始结果测量于脚部原点与 Bake 职责修正之前。它们保留为当时算法的性能和数值证据，不能证明修正后的构图或成本。当前 Bake 只产出 Live2D 快照，相机历史由独立 `CameraAnchorSampler` 准备；下面关于 Bake 输出相机状态的叙述仅描述历史测量版本。当前可复跑入口已按职责拆分，构图回归由真实 anchor→pivot 语义的正式场景测试覆盖。


生产规则为固定 15 Hz 角色锚点准备、额外捕获角色变换起止点与精确不连续事件、960 Hz 历史积分、一秒检查点。输出 fps 不参与这些参数的选择。语义和生命周期以 [ADR-0038](adr/0038-unified-camera-evaluation.md) 为准。

## 可重跑测量

基准位于 [`CameraProduction.test.ts`](../src/__benchmarks__/CameraProduction.test.ts)，独立闭式参考位于 [`cameraProductionReference.ts`](../src/__benchmarks__/cameraProductionReference.ts)。需要 Node >=24、已安装的现代 Cubism SDK、可读的 `AEON_CUBISM_TEST_MODEL` 和 Core（遵循现有 real-runtime fixture 的解析规则）。`AEON_CUBISM_TEST_MOTION` 可指定一个资源动作；未指定时选模型的第一个动作，不输出完整目录或环境值。

```sh
AEON_CAMERA_BENCHMARK=1 \
AEON_CAMERA_BENCHMARK_OUTPUT=.superpowers/sdd/camera-production-final.json \
npx vitest run --pool=forks --maxWorkers=1 --execArgv=--expose-gc \
  src/__benchmarks__/CameraProduction.test.ts
```

默认测试运行会跳过这个显式开启的长基准。`--execArgv=--expose-gc` 把 GC 开关传给实际 worker；只给外层 Node 加 `--expose-gc` 不足。完整结果写入指定 JSON，每个已完成阶段另写 `.progress.json`，即使后续失败也保留读数。

原生产历史算法对照：

```sh
AEON_CAMERA_BENCHMARK=1 AEON_CAMERA_BENCHMARK_POLICY=baseline \
AEON_CAMERA_BENCHMARK_OUTPUT=.superpowers/sdd/camera-production-baseline-necessary.json \
npx vitest run --pool=forks --maxWorkers=1 --execArgv=--expose-gc \
  src/__benchmarks__/CameraProduction.test.ts
```

该模式从固定 Git 对象 `acfee6cbc5b87fe2d18dcebd401f786d9199dd20` 提取实际生产 `CameraFollowHistory.ts`，只附加只读缓存计数，写到被忽略的 `.superpowers/sdd/camera-production-baseline-runtime/`。它替换正式入口使用的历史算法；不是原型或重新实现的旧算法。新旧模式都经过同一真实角色准备、ScriptEngine 播放/seek、正式 Bake 和 FrameCaptureEngine 调度，使用相同的完整 600 秒轨迹与观察时刻。

完整 baseline 命令会运行浏览器导出阶段，但它不是旧算法的浏览器对照：固定 Git 对象的 baseline mock 只作用于 Node/Vitest module graph，独立 Vite/Chromium module graph 始终加载当前 worktree 源码。结果会分别记录 Node 侧轨迹准备策略与 browser algorithm source。单独设置 `AEON_CAMERA_BENCHMARK_SUPPLEMENT=1` 时只运行 fresh 轨迹准备和当前浏览器补充，跳过长时间历史/Bake/调度分项。

现有的 `camera-production-baseline-node24.json` 与原完整 baseline 日志是在加入浏览器补充前采集的历史数据，不包含这项编码测量；本次 Issue07 的 fresh browser 数值来自独立 supplement 运行。

对照的轨迹准备采用相同的 tracks-only 请求：历史 runtime 只消费轨迹和版本，原先准备过程额外生成的约 9,000 个相机状态没有消费者。正式 Bake 仍在所请求范围内生成相机状态。额外运行旧式全部状态预计算的作业约 508 秒后被主动停止，只作为未完成成本下界；不拿它代替有效分项测量，也不把估计完成时间当作实测。

## 输入与正式调用边界

2026-10-22 的观测使用 Node v24.21.0、Linux x64、Intel i7-13650HX、`untitled-pixi-live2d-engine` 1.4.0、Cubism Core 6.0.1。模型与动作 SHA-256、完整选中动作元数据和原始读数保存于 [`camera-production-node24.json`](benchmarks/camera-production-node24.json) 和 [`camera-production-baseline-node24.json`](benchmarks/camera-production-baseline-node24.json)。这是一轮机器观测，不是跨硬件性能承诺。

场景为 1920×1080 合成参考尺寸、一个真实角色、600 秒、资源动作 `avemujica/mutsumi/mtn_angry01_C_casual_spring_01`（4.633 秒、30 fps、67 条参数曲线、资源标记 Loop=true）。角色在第 10 秒完成 80 ms 的线性快速变换，第 300 秒退场，第 302 秒重现；600 秒处有明确终止编排，确保正式 Bake 实际覆盖十分钟。准备得到五条轨迹，共 44,865 个样本；center 有 8,973 个样本，区间边界精确为 300/302 秒。

模型 factory 采用现有 real-runtime 测试的 renderer-free SDK 边界：真实 moc、真实参数曲线、真实 Core 几何和生产 motion stage；只保留选中资源动作，关闭自动眨眼，不加载纹理和 Physics。正式 ScriptEngine/历史准备/Bake/capture 算法保持实际实现。因而测量覆盖真实姿态推进与镜头求值、快照及捕获编排；不代表完整 7,065 个动作目录、纹理或 Physics 的加载和运行成本。

## 当前观测

| 分项 | 原生产历史策略 | 当前生产策略 |
| --- | ---: | ---: |
| 轨迹准备 | 51,952 ms | 54,578 ms |
| 正式场景加载（含准备） | 52,083 ms | 54,759 ms |
| 首次冷镜头求值，599.12345 秒 | 88,801 ms | 540.256 ms |
| 已准备场景首次正式 seek | 94,422 ms | 339.777 ms |
| 100 次同刻暖镜头求值 | 1,914.619 ms | 14.760 ms |
| 20 次同刻暖正式 seek | 2,965.207 ms | 224.423 ms |
| 正式 Bake 末两秒的 49 个相机样本 | 309,139 ms | 56,457 ms |
| 正式 capture 的 48 帧调度 | 26,961.796 ms | 590.237 ms |
| capture 调度吞吐 | 1.7803 帧/秒 | 81.3232 帧/秒 |

旧策略完整基准通过，运行 1,883.80 秒；生产基准通过，运行 137.23 秒。两者准备相同轨迹，准备成本未显示改善；索引、检查点复用和去除未消费状态解决镜头求值的额外工作。两轮独立的十个观察时刻之间最大位置差为 `1.3941e-11` 个创作单位，不能将其当作普遍精度上界。

计时顺序为准备/加载、独立轨迹对象上的冷求值、100 次同刻暖求值、正式首次 seek、20 次暖 seek、顺序/fps 验证、dense 参考、Bake、capture。这里的“冷”指该轨迹索引与检查点上下文尚未建立；模型已经准备完成，正式首次 seek 前公共求值代码已经运行，JIT 不属于全新进程冷启动。

准备和首次 seek 分开计时，暖查询不能表示首次就绪成本。Bake 没有 seed，因此尽管只输出末两秒的快照/相机状态，角色实际从 0 重放到 600 秒；该读数包含重放成本。capture 使用内存接收 backend 和空 renderer：**没有 GPU 绘制、JPEG/图片编码或 ffmpeg/WebCodecs 视频编码**。81.32 只表示正式 seek、相机与捕获调度吞吐，不能称为视频导出速度。

旧策略冷求值实际调用 287,581 次锚点采样，读取原样本 2,571,859,206 次；100 次暖求值新增 6,100 次采样、54,735,300 次原样本读取。当前计数轨迹的冷求值上下文实际调用 1,150,319 次廉价轨迹采样，首次建立索引读取原样本 17,946 次；100 次暖求值新增 23,900 次采样，原样本读取为 0。同步纯镜头查询期间 Core frame 计数保持不变，真实角色推进发生在异步准备或显式正式角色同步阶段。

该计数轨迹保留 8,973 个索引点、一个上下文、256 个检查点。冷求值前后强制 GC 的实际新增 JS 堆为 701,184 字节；这是该进程的保留堆差，有分配器噪声，不是引擎无关的对象尺寸。完整流程 GC 后 JS 堆增量为 22,383,016 字节，包含模型、引擎与快照；外部分配和 RSS 另见原始 JSON。轨迹 JSON 的 3,427,354 字节仅为序列化尺寸，不冒充实际堆占用。

旧策略这轮外层 Node 的 GC 开关没有传入 fork worker，原始结果标为 gc=false；其堆差只记录进程观测，不参与受控 GC 缓存尺寸比较。

Bake 的正式 range 实现为 49 个输出共用一次建立的 timeline 数组、prepared bundle 与 revision，未在每个样本创建新 wrapper。没有另外测量逐样本命中率，因此 Bake 的总时间包含真实 Core 重放及实际缓存重建，不能由单个暖查询外推。

旧策略对照的首查/暖查/seek 计时完成后，在未计时的查询顺序/fps 检验中有两次短暂 Inspector 诊断连接，第二次确认正在执行 60 fps 后的反序回查。连接在 dense-reference、Bake 与 capture 计时前断开；这些后续分项发生在 Inspector 初始化之后，可能的 JIT/调试状态影响未量化。最终生产 worker 没有诊断连接。两个作业曾在同一多核机器并行运行；这些是有该负载条件的观测，不是隔离机器上的统计承诺。

## 精度和确定性分别验收

这里的创作单位按合成参考尺寸换算：1920×1080 的归一化差分别乘 1920/1080。它们在此尺寸上数值等于像素，但不随输出分辨率变化。

**准备插值误差。** 独立参考在真实 Core 更新后直接读取 posed bounds，使用独立的坐标公式；没有调用生产锚点捕获 helper 作为答案。参考按 240 Hz 观察 `[0,5]` 和 `[9.95,10.15]`，共 1,247 个有效观察点。仅 15 Hz 固定采样时，快速变换端点未对齐，最大观测差为 76.8963 个创作单位。增加编排中已有的变换起止点后，最大差为 **0.597003**，RMS 为 **0.087655**；生产规则保留 15 Hz，并对这个固定输入约束观测差小于 1 个创作单位。此数字不是任意模型、Physics、非线性变换或连续时间的误差上界。

**历史积分误差。** 真实 prepared 轨迹另与独立闭式指数卷积比较：分段线性目标在视口 clamp 交点精确分段，覆盖开始、子帧、退场前后、无锚点、重现和远端查询；最大观测差约 `1.86e-11` 个创作单位。事件跳变、快速目标和变化 zoom 的独立 RK4 参考在 [`CameraProductionPrecision.test.ts`](../src/__tests__/CameraProductionPrecision.test.ts) 中验证，15,360/30,720 Hz 参考之间的差小于 0.001 单位。

| 固定积分频率 | 快速目标 + 变化 zoom clamp 最大观测差 |
| --- | ---: |
| 240 Hz | 2.697285 单位 |
| 480 Hz | 0.677359 单位 |
| 960 Hz | 0.139801 单位 |

因此采用 960 Hz；该合成测试预算为 0.5 单位。smoothing=0 在有效锚点处立即跟随，事件左右侧明确；无锚点时持有历史位置。smoothing=1 保持进入前位置。中间值为 `lambda=-60*ln(smoothing)` 的连续追赶，不再按播放帧率累计反馈；例如 .9 的半衰期约 0.110 秒。不能把上述合成最大差、真实实例最大差或二者相加称为通用上界。

新旧算法各自检查重复、反序、子帧、冷暖缓存，以及先按 24/30/60/120 fps 查询后的同刻严格相等。改变生产积分频率产生的近似差与查询顺序的确定性差分开报告。编排、轨迹内容/对象和合成参考尺寸的缓存失效由跨入口与 evaluator 回归覆盖。

## 策略和剩余成本

轨迹索引随不可变对象及内容版本复用；查询先选择有效区间，再对有序点二分查找。历史缓存选择查询之前最近的完整检查点，避免刚进入新整秒时从起点重算；每个上下文最多 256 个检查点，每条轨迹最多 32 个上下文。检查点都是固定全局网格的派生结果，子帧结果不入缓存。左侧事件查询不会复用同刻的事件后检查点，也不会把事件前状态存成事件后检查点。准备保留既有 cancel、ready、串行隔离模型和过期结果丢弃合同。

目前仍需约 55 秒推进这一个真实角色的十分钟轨迹，首次完整冷积分约 0.5 秒；很早的反向查询可能越过 256 秒保留窗口而重建。没有把大量真实 Core 推进移入同步镜头查询，也没有依据单个参数动作擅自假设 Physics 或任意资源可以循环复用。

继承风险分别处理：

- **编排前缀成本：保留并记录边界。** 公开 evaluator 的 64/128/256 个纯 zoom writer 探针，各三次求值测得 15.8/66.5/419.7 ms，显示密集编排前缀处理的明显非线性成本。当前真实场景只有两个 zoom writer；本轮优化针对实测轨迹扫描与检查点重算，没有重写完整通道解析器。密集镜头编排不能套用上表的暖查询数字。
- **SDK 私有 posed-bounds seam：当前已验证，升级仍需复测。** 基准在创建真实 SDK 模型时明确断言 `updateDrawableBounds` 存在，并以当前安装 runtime 的实际 Core 更新验证姿态变化。生产 helper 仍有结构化可选调用；若未来 SDK 删除这个方法，可能读到旧 bounds。未凭空修改 vendor 或引入未经测量的替代几何路径。

完整仓库检查由最终汇总门禁在独立评审通过后执行一次；本轮只运行基准、行为/缓存/跨入口测试和 TypeScript，不进行浏览器视觉检查。

## 正常播放与真实浏览器编码补充

上面的 capture 调度分项仍是带空 renderer 和内存接收 backend 的调度测量，不能代表绘制或编码速度。Issue07 补充基准另在自动化 Chromium 中加载正式 `ScriptEngine`、Pixi WebGL、Cubism Core 与一个真实模型，验证正常 `play()` 时间更新、同刻 evaluator/seek 镜头一致性，并通过生产 `FrameCaptureEngine`、`RawPixelsBackend` 和注册的 FFmpeg 导出 handler 渲染、编码视频。浏览器检查全程非视觉，不保存或人工审阅截图。

从 Node >=24 的项目环境安装依赖及 Playwright Chromium：

```sh
npm ci
npx playwright install chromium
```

需按上文现有 real-runtime fixture 规则配置 `AEON_CUBISM_TEST_MODEL`、Core 与可选的 `AEON_CUBISM_TEST_MOTION`。未设置动作时仍使用真实模型可读的一个动作。补充命令不设置 `AEON_CAMERA_BENCHMARK_PREPARED_TRACKS`，每次均以真实 Core 从头准备完整 600 秒轨迹；不要用仅用于 transport 定位的 ignored diagnostic cache 代替验收：

```sh
unset AEON_CAMERA_BENCHMARK_PREPARED_TRACKS
AEON_CAMERA_BENCHMARK=1 \
AEON_CAMERA_BENCHMARK_SUPPLEMENT=1 \
AEON_CAMERA_BENCHMARK_OUTPUT=.superpowers/sdd/camera-production-browser-export.json \
npx vitest run --pool=forks --maxWorkers=1 \
  src/__benchmarks__/CameraProduction.test.ts
```

补充场景用正式播放从 9.95 秒连续运行至 10.15 秒；逐个 time-update 在相同时间点与独立 camera-channel evaluator 对比，并将最终播放时间 seek 回查。实际导出在 10–11 秒以 24 fps、640×360 捕获 24 帧，Pixi WebGL 在 Chromium SwiftShader 上绘制真实角色和纹理；`libx264` 以 H.264/yuv420p 将真实 RGBA 像素写入临时 MP4。测量涵盖 `FrameCaptureEngine`、本机测试 WebSocket bridge 传帧及 FFmpeg 编码，结束后用 FFmpeg 解码帧数与 `framemd5` 校验，再删除临时视频。只有全部帧成功解码、输出非空、Cubism 参数快照有变化、模型 bounds 与正式舞台相交、模型绘制像素与背景角点不同且解码帧确有不同哈希时才输出吞吐结果。

Chromium 没有 Electron 的 `asset://` 协议，自动化夹具只把 Electron preload 文件读取入口和有限的 fixture `asset://` 地址映射到 loopback HTTP；模型 resolver、Cubism 加载器、真实 Moc、纹理、Pixi WebGL 绘制、帧捕获和正式 FFmpeg 文件写入仍走实际实现。Pixi 的公开 `Assets.setPreferences({ preferWorkers: false })` 仅用于此 harness，使真实 `ImageBitmap` 纹理加载留在可适配的页面 transport；Electron 桌面默认 worker 配置保持不变。结果标记为 current browser source；Vitest baseline mock 不会应用到 Chromium 的独立 module graph。测试 bridge 直接调用正式 FFmpeg handlers，不测量 Electron 主进程 IPC 延迟。SwiftShader、main-thread texture fetch 和本机 WebSocket bridge 都与桌面 GPU/Electron 的实时导出条件不同；所得编码 fps 是本次自动化环境下的观测，不是跨硬件吞吐承诺。

一次从头准备的补充验收在 Node v24.21.0、Chromium 151.0.7922.34、FFmpeg 7.0.2-static、Linux x64 / Intel i7-13650HX 上通过。完整 600 秒准备耗时 46,935.9 ms；正常播放观察 11 次时间更新，0.1643 秒墙钟内到达 10.162 秒，播放/evaluator/seek 的最大镜头差为 0。真实 Pixi WebGL/SwiftShader 捕获并编码 24 帧，测得 **10.14 帧/秒（instrumented end-to-end）**，实际临时 H.264 文件 22,603 字节；FFmpeg 解码出 24 帧，其中 21 种不同的完整帧哈希。计时路径包括逐帧验证、camera parity 比较、Cubism 参数快照与 bounds 检查、像素扫描、完整像素缓冲复制及哈希；它不是未经插桩的编码器上限。模型已加载、186 个 Cubism 参数产生 24 个不同快照，真实 Moc/纹理/动作 fixture 请求均成功。捕获时钟相对请求时刻最大偏差为 `3.34e-8` 秒；严格式播放/evaluator 与 same-time 输出 camera parity 均为 0。这里的 10.14 是 640×360、24 fps 输入和上述软件渲染条件下端到端的观测，不能与 1920×1080 composition 单位或前表的 81.32 帧/秒空 renderer 调度结果混为一谈。81.3232 帧/秒仍只表示空 renderer 调度。

不含本机模型路径或动作目录的 fresh 原始结果保存在 [camera-production-browser-export-node24.json](benchmarks/camera-production-browser-export-node24.json)，其中 `diagnosticTrackReuse: false`。文件另将后续缓存轨迹的可见性守卫验证放在独立 `postFreshAcceptanceGuardVerification` 字段，标为 `diagnosticTrackReuse: true`，不混入 fresh 性能数值。
