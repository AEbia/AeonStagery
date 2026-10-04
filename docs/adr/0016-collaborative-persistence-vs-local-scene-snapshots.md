---
status: accepted
---

# Collaborative Persistence Instead of Local Autosave as Source of Truth

协作模式下共享事实由 `Collaboration Server` 持久化；本地 scene 文件是从协作状态派生出的本地工作快照，而不是多人协作事实来源。加入已有房间并确认服务器场景后，客户端会在远端 materialization 前备份当前内存文档，再把服务器场景自动写入本地目标 scene 文件。这个落盘动作是有意的本地快照更新，不改变服务器对共享事实的权威性。

## Considered Options

1. **Server-side collaborative persistence with local snapshots**: 选用。它匹配中心化协作服务、素材可用性校验和房间级共享事实。
2. **Keep local autosave as primary persistence**: 拒绝。多个客户端各自写本地文件无法表达一个共同事实来源。
3. **Shared project folder autosave**: 拒绝。文件同步不能保证实时协作顺序、断线恢复和 asset-backed commit 语义。

## Consequences

- 协作模式需要独立于 `AutoSaveDaemon` 的服务端持久化路径。
- 本地保存入口表达为保存副本或导出 snapshot，而不是“提交协作事实”；协作加入确认后的远端 materialization 可以自动更新本地工作快照。
- `DocumentStore` 的远端更新可以在协作 materialization 路径中触发本地快照写入，但不能把本地文件反向当作共享事实来源。
- 覆盖本地快照前必须先保存当前内存中的本地语义文档；不能只复制已经落盘的旧文件，也不能等远端 materialization 后再创建备份。
- 服务端权威持久化 Yjs document state/update 与 asset manifest；`SceneScript` snapshot 只作为快速恢复、导出或兼容读取的派生结果。
- Presence、选中对象和当前编辑位置属于在线临时状态，不进入服务端持久化事实。
- 空房间可以由第一个主持客户端 seed 当前 `SceneScript` 和首期素材；seed 成功后，后续客户端只能拉取服务端状态，不能用本地文件覆盖共享事实。
- 加入已有状态的房间时采用 server-wins 规则：客户端用服务端 materialized scene 替换本地当前场景，不做本地 scene 自动 merge。
- 第一阶段不支持离线排队编辑；断线客户端只能查看或本地预览，重连后先拉取服务端状态再恢复共享提交。
