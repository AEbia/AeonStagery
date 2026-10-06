---
status: accepted
---

# 更新渠道与差分下载基线

OSS generic feed 和 GitHub Releases 都提供 Windows 更新。两者共享 NSIS 安装缓存，但元数据和历史块图可能分别发布；更新必须明确选择来源、校验目标安装包，并避免差分失败后静默下载整包。

## Decision

- OSS 与 GitHub 都只允许差分更新。GitHub release 已有安装包 SHA-256；electron-updater 的 NSIS 差分流程可使用该摘要，下载后仍执行安装包摘要与 Windows 签名校验。
- 对每个版本，优先从该 GitHub release 读取 `${installer}.blockmap`。若 release 没有对应块图，则从配置的 generic feed 读取同名同版本块图。只有新旧块图都可取时才继续差分；任一缺失或差分失败都必须报错，不能转成整包下载。
- GitHub API 为安装包提供 SHA-256；electron-updater 的差分重建还要求 SHA-512。release 可上传 `${installer}.sha512` sidecar；缺少 sidecar 时，从 OSS 对应 channel manifest 读取同版本 SHA-512。下载完成后再次以 GitHub SHA-256 校验重建文件，缓存复用也必须匹配当前源的摘要。
- 上传 GitHub 块图与 SHA-512 sidecar 前，确认它们对应 release 中的原始安装包。补历史资产时可直接复用 OSS 侧的块图和清单摘要，但必须先确认 OSS 安装包 SHA-256 与 GitHub Release API 的 asset digest 一致。
- 两个渠道共享 NSIS 缓存，由更新协调器串行执行检查、下载和安装，避免并发改写缓存或安装包。
- 网络错误可切换到另一个渠道；缺少块图、摘要不符和签名失败属于内容错误，不触发渠道回退。

## Consequences

- 后续 GitHub 发布应同时上传安装包、`.blockmap` 与 `.sha512`。未上传块图或摘要的 release 仍可尝试借用 OSS 上的对应文件。
- OSS 未发布对应历史块图时，GitHub 差分更新会停止并提示用户手动下载安装；不会退化成完整安装包下载。
- 切换渠道可能复用已缓存安装包，但每次复用都需匹配当前源的摘要并通过签名校验。

## Implementation alignment

- Provider 与 blockmap 补取：[`electron/githubReleaseProvider.ts`](../../electron/githubReleaseProvider.ts)
- 差分下载保护与缓存校验：[`electron/updaterDownloadPolicy.ts`](../../electron/updaterDownloadPolicy.ts)、[`electron/updaterDownloadCache.ts`](../../electron/updaterDownloadCache.ts)
- 渠道协调：[`electron/updateCoordinator.ts`](../../electron/updateCoordinator.ts)
- 更新设置：[`src/ui/settings/UpdateSettingsPanel.tsx`](../../src/ui/settings/UpdateSettingsPanel.tsx)
- 集成验证：[`src/__tests__/UpdaterDownloadIntegration.test.ts`](../../src/__tests__/UpdaterDownloadIntegration.test.ts)
