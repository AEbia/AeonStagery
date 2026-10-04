# AeonStagery

[English](README.md) | [简体中文](README_CN.md)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.8.0--beta-informational.svg)
![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![PixiJS](https://img.shields.io/badge/PixiJS-Rendering-E72264?logo=pixijs&logoColor=white)

> AeonStagery 是一个面向视频制作的视觉小说风格场景编排与回放引擎，支持时间线驱动、Live2D 角色控制、多层背景环境及导出。

---

## 核心功能

- **时间线分镜编排**：支持对对话、角色走位动作、镜头运镜、光照效果、音频与场景行为进行精细控制。
- **实时桌面预览**：基于 Electron 桌面端，结合 PixiJS 与 GSAP 实现流畅的实时渲染与动效呈现。
- **确定性时间轴寻道**：采用基于快照（Snapshot）的 Seek 机制，保证时间线拖拽与回放结果的一致性。
- **多人协同编辑**：内置独立协同房间服务器，在同步场景前自动执行资产可用性检查。
- **高质量导出管线**：面向视频与高画质动画内容制作的高精度渲染管线。

## 技术栈

| 分类 | 核心技术 |
| :--- | :--- |
| **前端与 UI** | React 18, TypeScript, Vite |
| **桌面端** | Electron |
| **图形与动画** | PixiJS, GSAP |
| **测试框架** | Vitest, Electron E2E |
| **协作服务** | Yjs, WebSocket 独立服务 |

---

## 快速上手

### 1. 安装依赖

```bash
npm install
```

### 2. 本地开发与运行

可以在浏览器中启动渲染器调试，或直接启动 Electron 桌面端：

```bash
# 启动浏览器开发模式预览渲染器
npm run dev

# 启动桌面端 Electron 开发模式
npm run electron:dev

# 运行当前构建产物的打包入口
npm start
```

---

## Live2D 运行时配置

> [!WARNING]
> **本仓库不随附 Live2D 运行时。**
> 因使用 Live2D 产生的一切版权争议由使用者自行承担。

可通过环境变量或本地 `.local/` 目录提供对应运行时：

| 运行时版本 | 环境变量 | 默认读取路径 |
| :--- | :--- | :--- |
| Cubism 2.1 核心（`live2d.min.js`） | `LIVE2D_CUBISM2_CORE`（文件或目录） | `.local/live2d/live2d.min.js` |
| Cubism Web 3/4/5（`live2dcubismcore.min.js` + Framework + Shaders） | `CUBISM_WEB_SDK_DIR`（SDK 源码根目录） | `.local/cubism-web-sdk` |

---

## 测试与构建

```bash
# 运行单元测试与集成测试
npm test

# 运行 Electron E2E 端到端测试（Linux 环境需搭配 xvfb-run，Windows/macOS 直接运行）
npm run test:e2e

# 构建渲染器与 Electron 产物
npm run build

# 打包 Windows 安装包
npm run dist:win
```

---

## 协同服务器

AeonStagery 支持通过独立服务实现多人协同：

```bash
npm run collab:server
```

协同层基于共享场景文档构建，并在应用远端变更前执行本地资产可用性校验。

---

## Agent Bridge

支持从命令行以无头（Headless）模式运行项目的 Agent 服务，供外部 Agent 调用驱动场景并获取结果：

```bash
# 对指定场景执行一轮 Agent 操作
npm run agent:bridge -- run --project-dir <project-dir> --scene-rel-path scenes/start.json \
  --message "你好！" \
  --endpoint https://api.example.com/v1 --model your-model

# 查询持久化对话日志（由 Bridge 独立维护）
npm run agent:bridge -- list --project-id <projectId>
npm run agent:bridge -- show --project-id <projectId> --task-id <taskId>

# 启动基于 stdio 的长连接 JSON-RPC 服务（支持 run / send / pause / cancel / status / result / list / show / close）
npm run agent:bridge -- serve --endpoint ... --model ...
```

---

## 支持范围与已知限制

### 支持范围

- Electron 桌面端编排工作流
- 基于时间线驱动的场景编辑与回放
- Live2D 角色动作与自定义运动关键帧编辑
- 基于 Node.js 的多人协同会话
- 架构设计决策记录详见 [`docs/adr-status.md`](docs/adr-status.md)

### 已知限制

- **Live2D 兼容范围**：仅适配当前支持的运行时系列（Cubism 2.1 及官方 Cubism Web 3/4/5 路径），不支持所有任意版本的 Cubism 运行时。
- **运行时缺失处理**：未放置对应运行时时，Live2D 模型会抛出明确的缺失提示，但应用的其他功能不受影响。

---

## 开源协议

AeonStagery 基于 [Apache License 2.0](LICENSE) 开源。

必要归属声明参见 [`NOTICE`](NOTICE)，所有打包及附带的第三方组件协议参见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)（包括以独立进程调用的 FFmpeg GPL-3.0-or-later 许可、GSAP 商业授权，以及内置的 OFL 字体）。
