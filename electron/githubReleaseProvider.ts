import { Provider, type AppUpdater, type UpdateInfo, type ResolvedUpdateFileInfo } from 'electron-updater';
import type { CustomPublishOptions } from 'builder-util-runtime';
import { parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { URL } from 'node:url';
import { compare } from 'semver';
import { getUpdateChannel } from './updaterFeed';

const repository = 'AEbia/AeonStagery';
const releaseApi = `https://api.github.com/repos/${repository}/releases`;
const installerName = (version: string) => `AeonStagery-Setup-${version}.exe`;

interface GitHubReleaseProviderOptions extends CustomPublishOptions {
  fallbackBlockMapBaseUrl?: string;
}

interface ReleaseAsset {
  name: string;
  state: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  name?: string;
  body?: string;
  published_at: string;
  assets: ReleaseAsset[];
}

/** Reads GitHub releases while borrowing missing blockmaps from the configured generic feed. */
export class GitHubReleaseProvider extends Provider<UpdateInfo> {
  private readonly releasesByVersion = new Map<string, Release>();
  private readonly fallbackBlockMapBaseUrl?: URL;

  constructor(options: GitHubReleaseProviderOptions, private readonly updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    super({ ...runtime, isUseMultipleRangeRequest: false });
    if (options.fallbackBlockMapBaseUrl) {
      const fallbackUrl = new URL(options.fallbackBlockMapBaseUrl);
      if (!['http:', 'https:'].includes(fallbackUrl.protocol)) {
        throw new Error('海外源更新的备用块图源必须使用 HTTP 或 HTTPS。');
      }
      this.fallbackBlockMapBaseUrl = fallbackUrl;
    }
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const channel = getUpdateChannel(this.updater.currentVersion.version);
    const releasesByVersion = new Map<string, Release>();
    let latest: { release: Release; version: string; asset: ReleaseAsset } | undefined;

    // Release chronology can differ from SemVer order. Compare candidates across
    // pages, also allowing a prerelease installation to graduate to stable.
    for (let page = 1; page <= 10; page++) {
      const raw = await this.httpRequest(new URL(`${releaseApi}?per_page=100&page=${page}`), {
        accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      });
      const releases: unknown = JSON.parse(raw ?? 'null');
      if (!Array.isArray(releases)) throw new Error('海外源更新信息格式无效。');
      for (const release of releases as Release[]) {
        if (release.draft || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) continue;
        const version = release.tag_name.replace(/^v/, '');
        try { this.updater.currentVersion.compare(version); } catch { continue; }

        releasesByVersion.set(version, release);

        const releaseChannel = getUpdateChannel(version);
        if (releaseChannel !== channel && releaseChannel !== 'latest') continue;
        if (channel === 'latest' && release.prerelease) continue;
        if (latest && compare(version, latest.version) <= 0) continue;
        const fileName = installerName(version);
        const asset = release.assets.find((candidate) => candidate.name === fileName && candidate.state === 'uploaded');
        if (!asset) continue;
        latest = { release, version, asset };
      }
      if (releases.length < 100) break;
    }

    this.releasesByVersion.clear();
    for (const [version, release] of releasesByVersion) this.releasesByVersion.set(version, release);
    if (!latest) throw new Error('海外源尚无当前更新频道的正式安装包。');

    const { release, version, asset } = latest;
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '');
    if (!digest) throw new Error(`海外源安装包 ${version} 缺少 SHA-256 校验值，请手动下载安装。`);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('海外源安装包大小无效。');
    const expectedUrl = this.releaseAssetUrl(release, asset.name);
    if (asset.browser_download_url !== expectedUrl) throw new Error('海外源安装包下载地址无效。');
    const sha512 = await this.getInstallerSha512(release, asset, version);

    // electron-updater's differential downloader requires SHA-512 even though
    // GitHub's asset API only exposes SHA-256. Releases may carry a small
    // `.sha512` sidecar; older releases borrow the matching feed manifest.
    return {
      version, path: asset.browser_download_url,
      files: [{ url: asset.browser_download_url, size: asset.size, sha2: digest[1], sha512 }],
      sha2: digest[1], sha512, releaseDate: release.published_at,
      releaseName: release.name, releaseNotes: release.body,
    } as unknown as UpdateInfo;
  }

  resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
    return info.files.map((file) => ({ url: new URL(file.url), info: file }));
  }

  async getBlockMapFiles(_baseUrl: URL, oldVersion: string, newVersion: string, oldBlockMapFileBaseUrl?: string | null): Promise<URL[]> {
    const oldUrl = oldBlockMapFileBaseUrl
      ? this.feedBlockMapUrl(oldBlockMapFileBaseUrl, oldVersion)
      : this.githubBlockMapUrl(oldVersion) ?? this.feedBlockMapUrl(this.fallbackBlockMapBaseUrl, oldVersion);
    const newUrl = this.githubBlockMapUrl(newVersion)
      ?? this.feedBlockMapUrl(this.fallbackBlockMapBaseUrl, newVersion);

    if (!oldUrl || !newUrl) {
      const missingVersion = !oldUrl ? oldVersion : newVersion;
      throw new Error(`海外源与国内源都没有 ${missingVersion} 的更新块图，请手动下载安装。`);
    }
    return [oldUrl, newUrl];
  }

  private githubBlockMapUrl(version: string): URL | undefined {
    const release = this.releasesByVersion.get(version);
    if (!release) return undefined;
    const name = `${installerName(version)}.blockmap`;
    const asset = release.assets.find((candidate) => candidate.name === name && candidate.state === 'uploaded');
    if (!asset) return undefined;
    const expectedUrl = this.releaseAssetUrl(release, name);
    if (asset.browser_download_url !== expectedUrl) throw new Error(`海外源${version} 更新块图下载地址无效。`);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`海外源${version} 更新块图大小无效。`);
    return new URL(expectedUrl);
  }

  private feedBlockMapUrl(baseUrl: URL | string | undefined, version: string): URL | undefined {
    if (!baseUrl) return undefined;
    return this.feedUrl(baseUrl, `${installerName(version)}.blockmap`);
  }

  private feedUrl(baseUrl: URL | string, fileName: string): URL {
    const feedUrl = new URL(baseUrl);
    feedUrl.search = '';
    feedUrl.hash = '';
    if (!feedUrl.pathname.endsWith('/')) feedUrl.pathname += '/';
    return new URL(encodeURIComponent(fileName), feedUrl);
  }

  private async getInstallerSha512(release: Release, installer: ReleaseAsset, version: string): Promise<string> {
    const sidecarName = `${installer.name}.sha512`;
    const sidecar = release.assets.find((candidate) => candidate.name === sidecarName && candidate.state === 'uploaded');
    if (sidecar) {
      const expectedUrl = this.releaseAssetUrl(release, sidecarName);
      if (sidecar.browser_download_url !== expectedUrl) throw new Error(`海外源${version} SHA-512 文件地址无效。`);
      if (!Number.isSafeInteger(sidecar.size) || sidecar.size <= 0 || sidecar.size > 256) {
        throw new Error(`海外源${version} SHA-512 文件大小无效。`);
      }
      const raw = await this.httpRequest(new URL(expectedUrl), { accept: 'text/plain' });
      return this.parseSha512(raw ?? '', `GitHub ${version} SHA-512 文件`);
    }

    if (!this.fallbackBlockMapBaseUrl) {
      throw new Error(`海外源${version} 缺少 SHA-512 文件且未配置国内源校验清单。`);
    }
    const channelFile = `${getUpdateChannel(version)}.yml`;
    const manifestUrl = this.feedUrl(this.fallbackBlockMapBaseUrl, channelFile);
    const raw = await this.httpRequest(manifestUrl);
    if (!raw) throw new Error(`国内源更新清单 ${channelFile} 为空。`);
    const manifest = parseUpdateInfo(raw, channelFile, manifestUrl);
    if (manifest.version !== version || !Array.isArray(manifest.files)) {
      throw new Error(`国内源更新清单 ${channelFile} 与海外源版本 ${version} 不匹配。`);
    }
    const file = manifest.files.find((candidate) => {
      try { return decodeURIComponent(new URL(candidate.url, manifestUrl).pathname.split('/').pop() ?? '') === installer.name; }
      catch { return false; }
    });
    if (!file || (file.size !== undefined && file.size !== installer.size)) {
      throw new Error(`国内源更新清单 ${channelFile} 中没有匹配的 ${installer.name}。`);
    }
    return this.parseSha512(file.sha512 ?? '', `国内源 ${version} 更新清单`);
  }

  private parseSha512(value: string, source: string): string {
    const digest = value.trim().replace(/^sha512:/i, '').trim();
    if (!/^(?:[a-f0-9]{128}|[A-Za-z0-9+/]{86}==)$/i.test(digest)) {
      throw new Error(`${source}缺少有效的 SHA-512 校验值。`);
    }
    // The differential downloader always compares SHA-512 using Base64.
    return /^[a-f0-9]{128}$/i.test(digest) ? Buffer.from(digest, 'hex').toString('base64') : digest;
  }

  private releaseAssetUrl(release: Release, fileName: string): string {
    return `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(fileName)}`;
  }
}
