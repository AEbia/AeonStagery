import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { NsisUpdater, type UpdateInfo } from 'electron-updater';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { NodeHttpExecutor } from 'builder-util/out/nodeHttpExecutor';
import { configureRequestOptions, configureRequestUrl, type DownloadOptions } from 'builder-util-runtime';
import { enforceDifferentialOnlyDownload, type DifferentialDownloadCapableUpdater } from '../../electron/updaterDownloadPolicy';
import { enforceVerifiedInstallerCache, type VerifiedCacheCapableUpdater } from '../../electron/updaterDownloadCache';
import { createUpdateFeedOptions } from '../../electron/updaterFeed';
import { GitHubReleaseProvider } from '../../electron/githubReleaseProvider';
import { UpdateCoordinator } from '../../electron/updateCoordinator';

class TestHttpExecutor extends NodeHttpExecutor {
  constructor(private readonly githubMirror: URL) { super(); }

  override createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void) {
    if (options.hostname === 'api.github.com' || options.hostname === 'github.com') {
      options = { ...options, protocol: 'http:', hostname: this.githubMirror.hostname, port: this.githubMirror.port };
    }
    // Each fixture owns a short-lived server and deliberately aborts downloads.
    // Avoid reusing global-agent sockets left behind by those failure paths.
    return super.createRequest({ ...options, agent: false }, callback);
  }
  download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers ?? undefined };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, {
        destination, options, onCancel, responseHandler: null,
        callback: (error) => error ? reject(error) : resolve(destination),
      }, 0);
    });
  }
}

function createTestUpdater(app: AppAdapter, executor: TestHttpExecutor): NsisUpdater {
  const updater = new NsisUpdater(undefined, app);
  // These runtime hooks are intentionally hidden from the dependency's .d.ts.
  // Supply Node HTTP and Windows provider naming without starting Electron.
  const internals = updater as unknown as {
    httpExecutor: TestHttpExecutor;
    createProviderRuntimeOptions(): ProviderRuntimeOptions;
  };
  internals.httpExecutor = executor;
  const runtimeOptions = internals.createProviderRuntimeOptions.bind(updater);
  internals.createProviderRuntimeOptions = () => ({ ...runtimeOptions(), platform: 'win32' });
  expect(enforceVerifiedInstallerCache(updater as unknown as VerifiedCacheCapableUpdater)).toBe(true);
  return updater;
}

const oldInstaller = Buffer.from('AAAABBBBCCCC');
const newInstaller = Buffer.from('AAAADDDDCCCC');
const oldName = 'AeonStagery-Setup-0.8.0-beta.exe';
const newName = 'AeonStagery-Setup-0.8.1-beta.exe';
function blockmap(checksums: string[]) {
  return gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums, sizes: [4, 4, 4] }] }));
}
const oldMap = blockmap(['a', 'b', 'c']);
const newMap = blockmap(['a', 'd', 'c']);
const staleMap = blockmap(['c', 'a', 'b']);

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function fixture(options: {
  cachedMap?: Buffer; missingOldMap?: boolean; baseline?: Buffer;
  disconnect?: 'oss-manifest' | 'oss-blockmap' | 'oss-range' | 'github' | 'github-installer'; githubDigest?: string | null;
  githubInstaller?: Buffer; githubInstallerUnavailable?: boolean; githubBlockmaps?: boolean;
  githubOldBlockmap?: boolean; githubSha512Asset?: boolean;
  sha512Encoding?: 'hex' | 'uppercase-hex';
  githubReleaseOrder?: 'oldest-first' | 'latest-on-second-page';
} = {}) {
  const sha512 = (installer: Buffer) => {
    const digest = createHash('sha512').update(installer).digest(options.sha512Encoding ? 'hex' : 'base64');
    return options.sha512Encoding === 'uppercase-hex' ? digest.toUpperCase() : digest;
  };
  const root = await mkdtemp(join(tmpdir(), 'aeon-updater-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, 'aeonstagery-updater');
  await mkdir(cache);
  await writeFile(join(cache, 'installer.exe'), options.baseline ?? oldInstaller);
  if (options.cachedMap) await writeFile(join(cache, 'current.blockmap'), options.cachedMap);
  const info: UpdateInfo = {
    version: '0.8.1-beta', releaseDate: '2026-10-06T00:00:00Z',
    files: [{ url: newName, size: newInstaller.length, sha512: sha512(newInstaller) }],
    path: newName, sha512: sha512(newInstaller),
  };
  const requests: Array<{ path: string; range?: string }> = [];
  let installerBytes = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    requests.push({ path: pathname, range: request.headers.range });
    if ((options.disconnect === 'oss-manifest' && pathname === '/beta.yml')
      || (options.disconnect === 'oss-blockmap' && pathname === `/${oldName}.blockmap`)
      || (options.disconnect === 'oss-range' && pathname === `/${newName}` && request.headers.range)
      || (options.disconnect === 'github' && pathname.startsWith('/repos/'))
      || (options.disconnect === 'github-installer' && pathname === `/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}`)) {
      request.socket.destroy(); return;
    }
    let data: Buffer | undefined;
    if (pathname === '/repos/AEbia/AeonStagery/releases') {
      const githubNewMap = options.githubInstaller ? blockmap(['z', 'd', 'c']) : newMap;
      const githubSha512 = sha512(options.githubInstaller ?? newInstaller);
      const releases = [{
        tag_name: 'v0.8.1-beta', draft: false, prerelease: true, published_at: info.releaseDate,
        assets: [
          { name: newName, state: 'uploaded', size: (options.githubInstaller ?? newInstaller).length,
            digest: options.githubDigest === undefined ? `sha256:${createHash('sha256').update(options.githubInstaller ?? newInstaller).digest('hex')}` : options.githubDigest,
            browser_download_url: `https://github.com/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}` },
          ...(options.githubBlockmaps !== false ? [{ name: `${newName}.blockmap`, state: 'uploaded', size: githubNewMap.length,
            browser_download_url: `https://github.com/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}.blockmap` }] : []),
          ...(options.githubSha512Asset !== false ? [{ name: `${newName}.sha512`, state: 'uploaded', size: githubSha512.length,
            browser_download_url: `https://github.com/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}.sha512` }] : []),
        ],
      }, {
        tag_name: 'v0.8.0-beta', draft: false, prerelease: true, published_at: '2026-09-01T00:00:00Z',
        assets: [
          { name: oldName, state: 'uploaded', size: oldInstaller.length,
            digest: `sha256:${createHash('sha256').update(oldInstaller).digest('hex')}`,
            browser_download_url: `https://github.com/AEbia/AeonStagery/releases/download/v0.8.0-beta/${oldName}` },
          ...(options.githubBlockmaps !== false && options.githubOldBlockmap !== false ? [{ name: `${oldName}.blockmap`, state: 'uploaded', size: oldMap.length,
            browser_download_url: `https://github.com/AEbia/AeonStagery/releases/download/v0.8.0-beta/${oldName}.blockmap` }] : []),
          ...(options.githubSha512Asset !== false ? [{ name: `${oldName}.sha512`, state: 'uploaded', size: sha512(oldInstaller).length,
            browser_download_url: `https://github.com/AEbia/AeonStagery/releases/download/v0.8.0-beta/${oldName}.sha512` }] : []),
        ],
      }];
      const page = Number(new URL(request.url!, 'http://localhost').searchParams.get('page') ?? 1);
      let pageReleases = page === 1 ? releases : [];
      if (options.githubReleaseOrder === 'oldest-first') pageReleases.reverse();
      if (options.githubReleaseOrder === 'latest-on-second-page') {
        pageReleases = page === 1 ? Array.from({ length: 100 }, () => releases[1]) : page === 2 ? [releases[0]] : [];
      }
      data = Buffer.from(JSON.stringify(pageReleases));
    }
    if (pathname === `/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}`) {
      if (options.githubInstallerUnavailable) { response.writeHead(503).end(); return; }
      if (request.headers.range) {
        const installer = options.githubInstaller ?? newInstaller;
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
        if (!match) { response.writeHead(400).end(); return; }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const bytes = installer.subarray(start, end + 1);
        installerBytes += bytes.length;
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${installer.length}` }).end(bytes);
        return;
      }
      // Match the redirect used by GitHub release assets, exercising the actual
      // HTTP executor and its checksum transform after redirecting.
      response.writeHead(302, { Location: options.githubInstaller ? '/github-installer.exe' : `/${newName}` }).end(); return;
    }
    if (pathname === `/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}.blockmap` && options.githubBlockmaps !== false) {
      response.writeHead(302, { Location: '/github-new.blockmap' }).end(); return;
    }
    if (pathname === `/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}.sha512` && options.githubSha512Asset !== false) {
      response.writeHead(302, { Location: '/github-new.sha512' }).end(); return;
    }
    if (pathname === `/AEbia/AeonStagery/releases/download/v0.8.0-beta/${oldName}.blockmap`
      && options.githubBlockmaps !== false && options.githubOldBlockmap !== false) {
      response.writeHead(302, { Location: '/github-old.blockmap' }).end(); return;
    }
    if (pathname === `/AEbia/AeonStagery/releases/download/v0.8.0-beta/${oldName}.sha512` && options.githubSha512Asset !== false) {
      response.writeHead(302, { Location: '/github-old.sha512' }).end(); return;
    }
    if (pathname === '/github-installer.exe') {
      data = options.githubInstaller;
      installerBytes += data?.length ?? 0;
    }
    if (pathname === '/github-new.blockmap') data = options.githubInstaller ? blockmap(['z', 'd', 'c']) : newMap;
    if (pathname === '/github-new.sha512') data = Buffer.from(sha512(options.githubInstaller ?? newInstaller));
    if (pathname === '/github-old.blockmap') data = oldMap;
    if (pathname === '/github-old.sha512') data = Buffer.from(sha512(oldInstaller));
    if (pathname === '/beta.yml') data = Buffer.from(JSON.stringify(info));
    if (pathname === `/${oldName}.blockmap` && !options.missingOldMap) data = oldMap;
    if (pathname === `/${newName}.blockmap`) data = newMap;
    if (pathname === `/${newName}`) {
      data = newInstaller;
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
        if (!match) { response.writeHead(400).end(); return; }
        const start = Number(match[1]);
        const end = Number(match[2]);
        data = data.subarray(start, end + 1);
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${newInstaller.length}` });
      }
      installerBytes += data.length;
    }
    if (!data) { response.writeHead(404).end(); return; }
    response.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  disposals.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const configPath = join(root, 'app-update.yml');
  await writeFile(configPath, `provider: generic\nurl: ${url}\nchannel: beta\nuseMultipleRangeRequest: false\nupdaterCacheDirName: aeonstagery-updater\n`);
  const app: AppAdapter = {
    version: '0.8.0-beta', name: 'aeonstagery', isPackaged: true,
    appUpdateConfigPath: configPath, userDataPath: root, baseCachePath: root,
    whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {},
  };
  const executor = new TestHttpExecutor(new URL(url));
  const updater = createTestUpdater(app, executor);
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableWebInstaller = true;
  updater.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  expect(enforceDifferentialOnlyDownload(updater as unknown as DifferentialDownloadCapableUpdater)).toBe(true);
  const createGitHubUpdater = () => {
    const github = createTestUpdater(app, executor);
    github.autoDownload = false;
    github.autoInstallOnAppQuit = false;
    github.disableDifferentialDownload = false;
    github.disableWebInstaller = true;
    github.logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    github.setFeedURL({ provider: 'custom', updateProvider: GitHubReleaseProvider, fallbackBlockMapBaseUrl: url });
    expect(enforceDifferentialOnlyDownload(github as unknown as DifferentialDownloadCapableUpdater)).toBe(true);
    return github;
  };
  const github = createGitHubUpdater();
  return { updater, github, createGitHubUpdater, cache, configPath, info, url, requests, server, installerBytes: () => installerBytes };
}

describe('NSIS differential downloads with the installed electron-updater', () => {
  it.each([
    ['first installation', undefined],
    ['healthy cache', oldMap],
    ['manual installation over stale cache', staleMap],
    ['downloaded update that was never installed', newMap],
  ])('uses the installed version blockmap for %s', async (_name, cachedMap) => {
    const f = await fixture({ cachedMap });
    await f.updater.checkForUpdates();
    const [file] = await f.updater.downloadUpdate();
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.requests.some((request) => request.path === `/${oldName}.blockmap`)).toBe(true);
    expect(f.installerBytes()).toBe(4);
    expect(f.requests.filter((request) => request.path.endsWith('.exe')).every((request) => request.range === 'bytes=4-7')).toBe(true);
  });

  it('keeps full downloads blocked when a historical blockmap is missing', async () => {
    const f = await fixture({ missingOldMap: true });
    await f.updater.checkForUpdates();
    await expect(f.updater.downloadUpdate()).rejects.toThrow('请手动下载');
    expect(f.installerBytes()).toBe(0);
  });

  it('keeps full downloads blocked when the baseline fails sha512 validation', async () => {
    const f = await fixture({ baseline: Buffer.from('ZZZZBBBBCCCC') });
    await f.updater.checkForUpdates();
    await expect(f.updater.downloadUpdate()).rejects.toThrow('请手动下载');
    expect(f.requests.filter((request) => request.path.endsWith('.exe')).every((request) => request.range)).toBe(true);
  });

  it('keeps the beta channel and single Range requests when overriding the feed URL', async () => {
    const f = await fixture();
    f.updater.setFeedURL(createUpdateFeedOptions(f.url, '0.8.0-beta'));
    await expect(f.updater.checkForUpdates()).resolves.toMatchObject({ isUpdateAvailable: true });
    const [file] = await f.updater.downloadUpdate();
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.requests.some((request) => request.path === '/latest.yml')).toBe(false);
    expect(f.installerBytes()).toBe(4);
  });
});

describe('GitHub installer downloads and network failover', () => {
  it.each(['oldest-first', 'latest-on-second-page'] as const)('finds the newer release with %s ordering', async (githubReleaseOrder) => {
    const f = await fixture({ githubReleaseOrder });
    await expect(f.github.checkForUpdates()).resolves.toMatchObject({
      isUpdateAvailable: true, updateInfo: { version: '0.8.1-beta' },
    });
    const [file] = await f.github.downloadUpdate();
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(4);
  });

  it.each([
    { source: 'GitHub sidecar', githubSha512Asset: true, sha512Encoding: 'hex' },
    { source: 'GitHub sidecar', githubSha512Asset: true, sha512Encoding: 'uppercase-hex' },
    { source: 'OSS manifest', githubSha512Asset: false, sha512Encoding: 'hex' },
    { source: 'OSS manifest', githubSha512Asset: false, sha512Encoding: 'uppercase-hex' },
  ] as const)('downloads with $source and $sha512Encoding SHA-512', async ({ githubSha512Asset, sha512Encoding }) => {
    const f = await fixture({ githubSha512Asset, sha512Encoding });
    const result = await f.github.checkForUpdates();
    const [file] = await f.github.downloadUpdate();
    expect(result?.updateInfo.sha512).toBe(createHash('sha512').update(newInstaller).digest('base64'));
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(4);
  });

  it('borrows missing GitHub blockmaps from OSS and downloads only changed installer ranges', async () => {
    const f = await fixture({ githubBlockmaps: false });
    const result = await f.github.checkForUpdates();
    expect(result?.isUpdateAvailable).toBe(true);
    const [file] = await f.github.downloadUpdate();
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(4);
    expect(f.requests.some((request) => request.path === `/${oldName}.blockmap`)).toBe(true);
    expect(f.requests.some((request) => request.path === `/${newName}.blockmap`)).toBe(true);
    expect(f.requests.filter((request) => request.path.endsWith('.exe')).every((request) => request.range === 'bytes=4-7')).toBe(true);
    expect(f.requests.some((request) => request.path.endsWith('.yml'))).toBe(false);
  });

  it('uses a published GitHub blockmap and fills only the missing historical map from OSS', async () => {
    const f = await fixture({ githubOldBlockmap: false });
    await f.github.checkForUpdates();
    const [file] = await f.github.downloadUpdate();
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.requests.some((request) => request.path === `/AEbia/AeonStagery/releases/download/v0.8.1-beta/${newName}.blockmap`)).toBe(true);
    expect(f.requests.some((request) => request.path === `/${oldName}.blockmap`)).toBe(true);
    expect(f.requests.some((request) => request.path === `/${newName}.blockmap`)).toBe(false);
    expect(f.installerBytes()).toBe(4);
  });

  it('borrows a missing GitHub SHA-512 sidecar from the OSS release manifest', async () => {
    const f = await fixture({ githubSha512Asset: false });
    await f.github.checkForUpdates();
    const [file] = await f.github.downloadUpdate();
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.requests.some((request) => request.path === '/beta.yml')).toBe(true);
    expect(f.installerBytes()).toBe(4);
  });

  it.each(['oss-manifest', 'oss-blockmap', 'oss-range'] as const)('falls back to GitHub differential download after an %s connection failure', async (disconnect) => {
    const f = await fixture({ disconnect });
    const status = vi.fn();
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, status);
    await coordinator.checkForUpdates('oss');
    const result = await coordinator.downloadUpdate();
    expect(result.source).toBe('github');
    expect(await readFile(result.files[0])).toEqual(newInstaller);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ state: 'checking', source: 'github', fallbackFrom: 'oss' }));
    expect(f.installerBytes()).toBe(4);
  });

  it('falls back from GitHub to an OSS differential download after a connection failure', async () => {
    const f = await fixture({ disconnect: 'github', cachedMap: staleMap });
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, vi.fn());
    expect((await coordinator.checkForUpdates('github')).source).toBe('oss');
    const result = await coordinator.downloadUpdate();
    expect(result.source).toBe('oss');
    expect(await readFile(result.files[0])).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(4);
  });

  it('falls back from a failed GitHub full download to OSS without enabling full OSS downloads', async () => {
    const f = await fixture({ disconnect: 'github-installer', cachedMap: staleMap });
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, vi.fn());
    await coordinator.checkForUpdates('github');
    const result = await coordinator.downloadUpdate();
    expect(result.source).toBe('oss');
    expect(await readFile(result.files[0])).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(4);
  });

  it('does not automatically switch channels for a missing historical blockmap', async () => {
    const f = await fixture({ missingOldMap: true });
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, vi.fn());
    await coordinator.checkForUpdates();
    await expect(coordinator.downloadUpdate()).rejects.toThrow('请手动下载');
    expect(f.requests.some((request) => request.path.startsWith('/repos/'))).toBe(false);
  });

  it('keeps GitHub full downloads blocked when a missing GitHub map cannot be borrowed from OSS', async () => {
    const f = await fixture({ missingOldMap: true, githubBlockmaps: false });
    await f.github.checkForUpdates();
    await expect(f.github.downloadUpdate()).rejects.toThrow('请手动下载');
    expect(f.installerBytes()).toBe(0);
  });

  it('rejects a GitHub installer with an incorrect SHA-256 instead of falling back', async () => {
    const f = await fixture({ githubDigest: `sha256:${'f'.repeat(64)}` });
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, vi.fn());
    await coordinator.checkForUpdates('github');
    await expect(coordinator.downloadUpdate()).rejects.toThrow('checksum mismatch');
    expect(f.requests.some((request) => request.path === '/beta.yml')).toBe(false);
    expect(() => coordinator.installUpdate()).toThrow('请先完成');
  });

  it('rejects a GitHub release asset without a digest before downloading', async () => {
    const f = await fixture({ githubDigest: null });
    await expect(f.github.checkForUpdates()).rejects.toThrow('缺少 SHA-256');
    expect(f.installerBytes()).toBe(0);
  });
});

describe('verified installer cache reuse', () => {
  it.each([
    ['oss', 'github', 'oss'],
    ['github', 'oss', 'github'],
  ] as const)('validates the installer after switching %s -> %s -> %s', async (first, second, third) => {
    const githubInstaller = Buffer.from('ZZZZDDDDCCCC');
    const f = await fixture({ githubInstaller });
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, vi.fn());
    for (const source of [first, second, third]) {
      await coordinator.checkForUpdates(source);
      const result = await coordinator.downloadUpdate();
      const expected = source === 'oss' ? newInstaller : githubInstaller;
      expect(await readFile(result.files[0])).toEqual(expected);
    }
    expect(await readFile(join(f.cache, 'installer.exe'))).toEqual(oldInstaller);
  });

  it('reuses identical verified bytes across channels without downloading again', async () => {
    const f = await fixture();
    const coordinator = new UpdateCoordinator({ oss: f.updater, github: f.github }, vi.fn());
    await coordinator.checkForUpdates('oss');
    await coordinator.downloadUpdate();
    const bytes = f.installerBytes();
    await coordinator.checkForUpdates('github');
    const result = await coordinator.downloadUpdate();
    expect(await readFile(result.files[0])).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(bytes);
  });

  it('reuses a GitHub installer after restart when the asset endpoint is unavailable', async () => {
    const options = { githubInstallerUnavailable: false };
    const f = await fixture(options);
    await f.github.checkForUpdates();
    const [file] = await f.github.downloadUpdate();
    const bytes = f.installerBytes();
    options.githubInstallerUnavailable = true;
    const restarted = f.createGitHubUpdater();
    const coordinator = new UpdateCoordinator({ github: restarted }, vi.fn());
    await coordinator.checkForUpdates('github');
    const result = await coordinator.downloadUpdate();
    expect(result.files).toEqual([file]);
    expect(await readFile(file)).toEqual(newInstaller);
    expect(f.installerBytes()).toBe(bytes);
    expect(coordinator.snapshot).toMatchObject({ state: 'downloaded', source: 'github' });
    expect((restarted as unknown as { installerPath: string }).installerPath).toBe(file);
  });

  it.each(['oss', 'github'] as const)('revalidates %s cache bytes even in the same updater instance', async (source) => {
    const f = await fixture();
    const updater = source === 'oss' ? f.updater : f.github;
    await updater.checkForUpdates();
    const [file] = await updater.downloadUpdate();
    await writeFile(file, Buffer.from('ZZZZDDDDCCCC'));
    const bytes = f.installerBytes();
    const [downloaded] = await updater.downloadUpdate();
    expect(await readFile(downloaded)).toEqual(newInstaller);
    expect(f.installerBytes()).toBeGreaterThan(bytes);
  });

  it('rejects a corrupted GitHub cache after restart when it cannot be downloaded again', async () => {
    const options = { githubInstallerUnavailable: false };
    const f = await fixture(options);
    await f.github.checkForUpdates();
    const [file] = await f.github.downloadUpdate();
    await writeFile(file, Buffer.from('ZZZZDDDDCCCC'));
    options.githubInstallerUnavailable = true;
    const coordinator = new UpdateCoordinator({ github: f.createGitHubUpdater() }, vi.fn());
    await coordinator.checkForUpdates('github');
    await expect(coordinator.downloadUpdate()).rejects.toThrow('请手动下载');
    expect(() => coordinator.installUpdate()).toThrow('请先完成');
  });

  it('preserves publisher signature verification when reusing a cached installer', async () => {
    const f = await fixture();
    const config = await readFile(f.configPath, 'utf8');
    await writeFile(f.configPath, `${config}publisherName: Expected Publisher\n`);
    const verifySignature = vi.fn(async () => null as string | null);
    f.github.verifyUpdateCodeSignature = verifySignature;
    const coordinator = new UpdateCoordinator({ github: f.github }, vi.fn());
    await coordinator.checkForUpdates('github');
    await coordinator.downloadUpdate();
    const bytes = f.installerBytes();
    verifySignature.mockResolvedValue('Unexpected Publisher');
    await expect(coordinator.downloadUpdate()).rejects.toThrow('Cached installer signature is invalid');
    expect(verifySignature).toHaveBeenCalledTimes(2);
    expect(f.installerBytes()).toBe(bytes);
    expect(() => coordinator.installUpdate()).toThrow('请先完成');
  });

  it('reports unavailable updater hooks instead of allowing unverified cache reuse', () => {
    expect(enforceVerifiedInstallerCache({})).toBe(false);
    expect(enforceVerifiedInstallerCache({ verifySignature: async () => null })).toBe(false);
    expect(enforceVerifiedInstallerCache({
      getOrCreateDownloadHelper: async () => ({ validateDownloadedPath: async () => null }),
    })).toBe(false);
  });
});
