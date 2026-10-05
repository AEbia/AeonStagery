---
status: accepted
---

# Centralized Collaboration Server for Scene Collaboration

多人协作采用中心化 **Collaboration Server** 承载协作场景会话、presence、素材 manifest 校验与共享素材可用性协调。第一阶段可以用本地或内网开发服务运行，但架构上不采用纯 P2P、共享文件夹、或某个 Electron 客户端临时充当房主，因为这些方案无法稳定保证素材可用性、权限边界、重连恢复和后续协作审计。

## Current Scope Note

本文拒绝的是 client-hosted P2P / 共享文件夹 / 临时客户端房主，不是拒绝由 Electron 主进程启动一个中心化服务端进程。当前 **Embedded Collaboration Server Process** 仍然是中心化 Collaboration Server 的一个启动 Adapter：renderer 作为 joiner 连接它，room、presence、素材存储与 availability gate 仍由服务端进程持有。

## Considered Options

1. **Centralized Collaboration Server**: 选用。服务端拥有协作 room 与素材可用性校验边界，客户端负责本地缓存和编辑体验。
2. **Client-hosted room**: 拒绝。房主离线、网络切换和素材上传失败都会把协作状态拖进不可预测区。
3. **Shared project folder**: 拒绝。文件系统同步不能提供可靠的 scene 操作顺序、presence、权限和 asset-backed commit 语义。
4. **Pure P2P**: 拒绝。适合轻量文本协作实验，但不适合带大体积素材与项目权限的 authoring 工作流。

## Consequences

- Yjs provider、素材上传下载、presence 和权限模型都应围绕服务端 room 设计。
- 协作场景文档只同步 scene 状态、素材 manifest 与引用；二进制素材通过共享素材存储分发。
- 本地 Electron 项目目录仍是缓存与离线工作区，不是多人协作事实来源。
- Room 身份由服务端 `collaborationProjectId + sceneId` 决定；本地项目路径和本地 projectId 只能作为远端项目绑定信息。
- 共享素材存储以服务端 collaboration project 为作用域隔离。
- 第一阶段 UI 可以采用 `ip:port + displayName` 的 direct endpoint join，连接到一个 single-room collaboration server；复杂 room 选择与账号权限后置。
- 第一阶段服务端以独立 Node 进程或 Electron 主进程托管的 embedded Node 进程启动；Electron renderer 客户端只作为 joiner 连接，不能把 renderer 本身变成房主事实来源。

## Server Access Boundary

当前 single-room 服务默认监听 `0.0.0.0`，允许其他设备连接；主持人可切换为仅本机监听。
HTTP 数据接口与 WebSocket upgrade 都必须校验房间凭证。主持可设置任意长度密码，留空
生成随机密码；邀请链接作为可选快捷连接方式承载相同权限。复杂账号、逐成员权限与审计仍后置。

服务端只发布已上传至 collaboration asset store 的共享副本，不挂载整个项目目录或任意
本地文件。素材读写必须约束路径及符号链接边界，协议入口须限制请求体、连接数量及
待处理更新，错误与健康响应不得暴露本机目录。

运行配置、密码与邀请链接生命周期、部署限制见
[Collaboration server access](../collaboration-security.md)。实现入口为
[`server/collaboration/security.ts`](../../server/collaboration/security.ts)、
[`server/collaboration/server.ts`](../../server/collaboration/server.ts) 与
[`server/collaboration/assets.ts`](../../server/collaboration/assets.ts)。
