---
status: accepted
---

# 开源许可与 Live2D 运行时分发边界

AeonStagery 以 Apache-2.0 开源发布。这带来两个此前没有约束的边界：仓库里不能再出现 Live2D Inc. 的专有运行时，而应用又必须继续支持用户自带运行时。ADR-0019 只解决了"运行时可以缺失、缺失时报可解释错误"，没有回答"运行时如何进入仓库/安装包/更新路径"。

## Decision

### 1. 仓库不提交任何 Live2D 运行时

`live2d.min.js`（Cubism 2.1 core）、`live2dcubismcore.min.js`（Cubism Core for Web）、官方 Cubism Web Framework 源码与其 Shader 全部为 Live2D 自有许可（非 OSI），一律不入库。仓库只保留 MIT 的适配层（`untitled-pixi-live2d-engine` 的 `cubism-legacy` 与 `cubism` 入口），它在运行期需要用户提供的 core 才能工作。

运行时来源只能是本机路径：

- `LIVE2D_CUBISM2_CORE`：`live2d.min.js` 文件或所在目录；兜底 `.local/live2d/live2d.min.js`；
- `LIVE2D_CUBISM_CORE`：`live2dcubismcore.min.js` 文件或所在目录；兜底 `.local/live2d/live2dcubismcore.min.js`；旧 `CUBISM_WEB_SDK_DIR/Core/live2dcubismcore.min.js` 与 `.local/cubism-web-sdk/Core/live2dcubismcore.min.js` 保留为 Core-only 兼容来源。

2026-10-05 调整：3/4/5 使用 npm 引擎的 `cubism` 入口，Framework 与 Shader 随该入口打包，保留相应 Live2D 许可声明；不再从本机 SDK 复制 Framework、类型或 Shader。禁止提交或在默认发布包中携带用户提供的 Core 脚本仍然成立。

`scripts/check-repo-hygiene.mjs` 作为 gate 接入 `npm run check`：按文件名、路径与已知专有 blob 的 SHA256 阻止重新入库。

### 2. 单一 staging 入口 + 三种模式

`scripts/sync-live2d-runtime.mjs`（逻辑在 `scripts/lib/live2dRuntimeStaging.mjs`）是唯一入口：

| 模式 | 用途 | 行为 |
| --- | --- | --- |
| `auto` | dev / test / install | 有什么 Core stage 什么，不生成 SDK stub，缺失不失败 |
| `none` | 对外发布 | 清除 staged Core 与旧 generated SDK / Shader，**忽略环境变量** |
| `verify` | 内部验证 | 两个运行时族都必需，缺失即失败 |

每次运行写 `.generated/live2d-runtime-manifest.json`：模式、来源、每个 staged 文件的 SHA256、来源指纹。重复运行以指纹+哈希判断是否已最新，可直接跳过。`postinstall` / `pretest` / `precheck` / `predev` / `prebuild` 都走 `auto`，因此干净克隆即使没有任何 SDK 也能通过 `tsc`、`vitest` 与 `vite build`。

### 3. 打包两种模式，各自前后夹逼

`scripts/package.mjs <none|verify>` 是唯一打包入口：staging → build → 源码/产物 gate → electron-builder → 安装包 gate。

- `none`（默认，可对外发布）：`package.json#build` 配置，无 `live2d-runtime` extraResources，`dist` 中也不保留运行时脚本副本（运行期只从 `aeon-runtime://` 读 userData）。
- `verify`（仅内部验证）：`electron-builder.verify.config.cjs` 追加 `live2d-runtime/**` extraResources，产物文件名带 `-verify`，输出目录固定为 `release/verify`。该产物**禁止公开分发**，因为它携带用户提供的 Live2D Core 脚本。它与发布包一样沿用 `package.json#build` 的 generic `publish` 源（不再置 `publish: null`），electron-builder 因此照常生成 `resources/app-update.yml`：内部验证机装完即可走同一条 `beta` 更新通道。这并不构成发布——generic provider 下 electron-builder 从不上传，`scripts/package.mjs` 也始终传 `--publish never`。

两种模式使用相同 `appId` 与 `productName`：userData（含已装运行时）必须在两种模式间解析到同一目录，这样"安装新版本不删除已有运行时"才可被直接实测。发布包文件名由 `build.artifactName` 显式固定为 `${productName}-Setup-${version}.${ext}`：electron-builder 在 `latest.yml` 中写的是 URL 安全名（空格替换为 `-`），若不显式命名，磁盘文件名与元数据 url 不一致，`APP_UPDATE_URL` 上的自动更新会 404。验证包在同名规则上追加 `-verify`，并输出到独立的 `release/verify` 目录，因此它为自己生成的 `beta.yml` 永远不会覆盖 `release/beta.yml`，两者永不重名、也不会互相污染更新清单。

`scripts/verify-live2d-runtime.mjs` 断言 staged 源与 `dist` bundle（默认发布模式无外部 Core / Shader 文件，验证模式逐文件核对 Core SHA256；npm 引擎内置 Framework / Shader 允许打包），`scripts/verify-package-contents.mjs` 断言最终 `resources/`、`app.asar` 条目表与其中的渲染器代码。

### 4. 更新不得删除已有运行时

`userData/live2d-runtime/` 是用户资产，seeding 只增不删：

- `ensureLive2DRuntimeFiles` 只复制缺失文件，绝不覆盖、绝不删除（旧版用户 Shader 保留，但不再复制新的 Shader）；
- 打包后不含运行时的版本启动时同样不会删除已有运行时；
- NSIS 显式 `deleteAppDataOnUninstall: false`；
- `live2d-runtime` 目录名、`aeon-runtime://` scheme 与 `build.productName` 一旦发布不得改名——改名等于让老用户的运行时"消失"；
- 更新渠道上传的安装包文件名必须等于 `latest.yml` 里的 url（见 §3）：更新根本装不上的话，"保留已有运行时"无从谈起。

### 5. 许可与三方声明

`LICENSE`（Apache-2.0）、`NOTICE`、`THIRD_PARTY_NOTICES.md`（由 `scripts/generate-third-party-notices.mjs` 从 `package-lock.json` 生成，`--check` 接入 `npm run check`，同一份内容随包分发到 `public/licenses/third-party-notices.md`）。需要专门声明的组件：

- **FFmpeg（`ffmpeg-static`，GPL-3.0-or-later）**：仅以独立子进程方式调用（`spawn`/`execFile`），不与应用链接，因此应用仍可按 Apache-2.0 分发；随包提供 GPL-3.0 全文（`public/licenses/ffmpeg/GPL-3.0.txt`）与上游源码出处。
- **GSAP**：GreenSock Standard License（非 OSI），单独声明。
- **字体**：JetBrains Mono / Noto Sans SC / Outfit 为 OFL 1.1，许可文本随包。
- **Live2D 运行时**：默认不分发，由用户自行取得并承担许可责任。

## Consequences

- 干净克隆下真实内核用例（Cubism 2.1 / 真实 Framework 特征化测试）会 skip：这是有意的，skip 而非 fail。
- 默认发布物中不出现用户提供的 Live2D Core 脚本；用户在 `userData/live2d-runtime/` 放置运行时后，Cubism 2.1 与 3/4/5 模型均可用。
- 验证包与发布包共用产品身份，因此两者可互相覆盖安装且共享 userData；验证包靠 `-verify` 文件名与独立的 `release/verify` 输出目录区分。
- 验证包与发布包解析同一条 `beta` 更新通道，内部验证机可实测真实更新路径。验证包被更新时拉到的自然是 `none` 发布包，已装运行时不受影响：runtime 的权威副本在 `userData/live2d-runtime/`，seeding 只增不删，且 NSIS 更新（`--updated`）不会删除 AppData。
- 修改分发方式（自动下载运行时、把运行时放进安装目录、改名目录/scheme）必须先有新的 ADR。
