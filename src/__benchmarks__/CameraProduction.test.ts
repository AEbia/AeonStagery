/** @vitest-environment node */
/** Opt-in real-Core benchmark. See docs/camera-production-benchmark.md. */
import { referencePreparedFollow } from './cameraProductionReference';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, type RawData } from 'ws';
import { createServer, type ViteDevServer } from 'vite';
import { chromium } from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import { Container, type Application } from 'pixi.js';
import gsap from 'gsap';
import { resolveCubismWebCorePath } from '../__tests__/helpers/live2dRuntimeFixture';
import { CubismPixiLive2DAdapter } from '../engine/runtime/CubismPixiLive2DAdapter';
import * as adapters from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { installCubismPixiModelRuntime } from '../engine/CubismPixiModel';
import type { Live2DModelDisplayObject } from '../engine/runtime/Live2DRuntimeContracts';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument, PreparedCompiledScene } from '../api/types/semantic-scene';
import { BakeEngine, type BakeResult } from '../engine/BakeEngine';
import ScriptEngine from '../engine/ScriptEngine';
import { stageManager } from '../engine/StageManager';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { FrameCaptureEngine } from '../engine/export/FrameCaptureEngine';
import { cameraController } from '../engine/CameraController';
import { evaluateCameraChannels, sampleCameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';
import type { PreparedCameraAnchorTrajectory } from '../engine/CameraAnchorPreparation';
import { getCameraFollowHistoryDiagnostics } from '../engine/CameraFollowHistory';
import { preparedSceneToRuntimeTimelineScene } from '../engine/PreparedRuntimeScene';
import type { CameraProductionBrowserInput, CameraProductionBrowserResult } from './cameraProductionBrowserHarness';
import type { FFmpegStreamOptions } from '../api/types/export';

interface RealModelDocument {
  FileReferences: {
    Moc: string;
    Physics?: string;
    Textures?: string[];
    Motions: Record<string, { File: string; Sound?: string }[]>;
    Expressions: unknown[];
    Pose?: string;
    UserData?: string;
    DisplayInfo?: string;
  };
  [key: string]: unknown;
}

interface BrowserFixtureAsset {
  file: string;
  contentType: string;
}

interface StreamBridgeRequest {
  id: number;
  kind: 'start' | 'frame' | 'finish' | 'cancel';
  outputPath?: string;
  options?: FFmpegStreamOptions;
  byteLength?: number;
}

function invokeFFmpegHandler(name: string, ...args: unknown[]): Promise<unknown> {
  const handler = ffmpegHandlers.get(`ffmpeg:${name}`);
  if (!handler) throw new Error(`Missing FFmpeg handler: ${name}`);
  return handler(undefined, ...args);
}

function asBuffer(data: RawData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

function assetContentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function uriScheme(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1];
  return scheme?.toLowerCase() ?? 'relative';
}

function createBrowserModelFixture(entry: string, motion: string, source: RealModelDocument): {
  modelJson: string;
  assets: Map<string, BrowserFixtureAsset>;
} {
  const assets = new Map<string, BrowserFixtureAsset>();
  const model = structuredClone(source);
  const references = model.FileReferences;
  const routeAsset = (routeName: string, relativePath: string): string => {
    const file = path.resolve(path.dirname(entry), relativePath);
    assets.set(routeName, { file, contentType: assetContentType(file) });
    return `/__camera_fixture/${routeName}`;
  };

  references.Moc = routeAsset('model.moc3', references.Moc);
  references.Textures = (references.Textures ?? []).map((texture, index) =>
    routeAsset(`texture-${index}${path.extname(texture)}`, texture));
  const selectedDefinitions = references.Motions[motion];
  if (!selectedDefinitions?.length) throw new Error('Selected real motion is unavailable.');
  references.Motions = {
    [motion]: selectedDefinitions.map((definition, index) => {
      const routed = { ...definition, File: routeAsset(`motion-${index}${path.extname(definition.File)}`, definition.File) };
      delete routed.Sound;
      return routed;
    }),
  };
  references.Expressions = [];
  delete references.Physics;
  if (references.Pose) references.Pose = routeAsset(`pose${path.extname(references.Pose)}`, references.Pose);
  if (references.UserData) references.UserData = routeAsset(`userdata${path.extname(references.UserData)}`, references.UserData);
  if (references.DisplayInfo) references.DisplayInfo = routeAsset(`display-info${path.extname(references.DisplayInfo)}`, references.DisplayInfo);
  return { modelJson: JSON.stringify(model), assets };
}

async function measureRealBrowserExport(args: {
  scene: PreparedCompiledScene;
  anchorRevision: string | number;
  anchorTrajectories: readonly PreparedCameraAnchorTrajectory[];
  expectedFrames: CameraProductionBrowserInput['expectedFrames'];
  modelEntry: string;
  motion: string;
  model: RealModelDocument;
  core: string;
}): Promise<CameraProductionBrowserResult & {
  browserVersion: string;
  ffmpegVersion: string;
  outputBytes: number;
  decodedFrameCount: number;
  uniqueDecodedFrameHashes: number;
  fixtureRequests: Record<string, number>;
  missingFixtureAssets: string[];
  modelLoadErrorCount: number;
  modelLoadErrors: string[];
}> {
  if (!ffmpeg) throw new Error('Bundled FFmpeg is unavailable.');
  const fixture = createBrowserModelFixture(args.modelEntry, args.motion, args.model);
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'camera-production-export-'));
  const outputPath = path.join(outputDirectory, 'camera-production.mp4');
  const fixtureRequests = new Map<string, number>();
  const fixtureRequestSchemes = new Map<string, number>();
  const fixtureResponseStatuses = new Map<string, number>();
  const fixtureRequestFailures = new Map<string, number>();
  let electronModelJsonReadCount = 0;
  const missingFixtureAssets = new Set<string>();
  let modelLoadErrorCount = 0;
  const modelLoadErrors = new Set<string>();
  const modelLoadFailureAssetAliases = new Set<string>();
  let server: ViteDevServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let frameRequest: { id: number; byteLength: number } | undefined;

  const invoke = (socket: import('ws').WebSocket, id: number, run: () => Promise<unknown>) => {
    const task = operationQueue.then(run);
    operationQueue = task.then(() => undefined, () => undefined);
    void task.then(
      result => { if (socket.readyState === 1) socket.send(JSON.stringify({ id, result })); },
      error => {
        const message = error instanceof Error ? error.message : String(error);
        if (socket.readyState === 1) socket.send(JSON.stringify({ id, error: message }));
      },
    );
  };
  let operationQueue: Promise<unknown> = Promise.resolve();

  try {
    ffmpegHandlers.clear();
    registerFFmpegHandlers();
    await new Promise<void>((resolve, reject) => {
      bridge.once('listening', resolve);
      bridge.once('error', reject);
    });
    bridge.on('connection', socket => {
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          const pending = frameRequest;
          frameRequest = undefined;
          const bytes = asBuffer(data);
          if (!pending || !bytes || bytes.byteLength !== pending.byteLength) {
            if (pending && socket.readyState === 1) socket.send(JSON.stringify({ id: pending.id, error: 'Invalid raw frame payload.' }));
            return;
          }
          invoke(socket, pending.id, () => invokeFFmpegHandler('pushFrame', bytes));
          return;
        }

        const bytes = asBuffer(data);
        if (!bytes) return;
        let request: StreamBridgeRequest;
        try { request = JSON.parse(bytes.toString('utf8')) as StreamBridgeRequest; }
        catch { return; }
        if (request.kind === 'frame') {
          frameRequest = { id: request.id, byteLength: request.byteLength ?? -1 };
          return;
        }
        if (request.kind === 'start') {
          invoke(socket, request.id, () => invokeFFmpegHandler('startStreamExport', request.outputPath, request.options));
        } else if (request.kind === 'finish') {
          invoke(socket, request.id, () => invokeFFmpegHandler('endStreamExport'));
        } else {
          invoke(socket, request.id, () => invokeFFmpegHandler('cancelExport'));
        }
      });
    });

    server = await createServer({
      configFile: false,
      root: process.cwd(),
      appType: 'mpa',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const httpAddress = server.httpServer?.address();
    const websocketAddress = bridge.address();
    if (!httpAddress || typeof httpAddress === 'string' || !websocketAddress || typeof websocketAddress === 'string') {
      throw new Error('Headless benchmark servers did not bind local ports.');
    }
    const origin = `http://127.0.0.1:${httpAddress.port}`;
    const pageOrigin = `${origin}/__camera_fixture/`;
    const input: CameraProductionBrowserInput = {
      scene: args.scene,
      anchorRevision: args.anchorRevision,
      anchorTrajectories: args.anchorTrajectories,
      modelUrl: 'asset://localhost/__camera_fixture/model.model3.json',
      websocketUrl: `ws://127.0.0.1:${websocketAddress.port}`,
      outputPath,
      fps: 24,
      rangeStart: 10,
      rangeEnd: 11,
      width: 640,
      height: 360,
      expectedFrames: args.expectedFrames,
    };

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript((fixtureOrigin: string) => {
      const resolveFixtureUrl = (sourceUrl: string, transport: 'fetch' | 'xhr' | 'image'): string => {
        if (!sourceUrl.startsWith('asset://localhost/')) return sourceUrl;
        const pathname = new URL(sourceUrl).pathname;
        const marker = '/__camera_fixture/';
        const markerIndex = pathname.lastIndexOf(marker);
        if (markerIndex < 0) return sourceUrl;
        const diagnosticWindow = window as Window & {
          __cameraAssetTransportRewriteCount?: number;
          __cameraAssetTransportKinds?: Record<'fetch' | 'xhr' | 'image', number>;
          __cameraAssetTransportAliases?: Record<string, number>;
        };
        diagnosticWindow.__cameraAssetTransportRewriteCount = (diagnosticWindow.__cameraAssetTransportRewriteCount ?? 0) + 1;
        const counts = diagnosticWindow.__cameraAssetTransportKinds ?? { fetch: 0, xhr: 0, image: 0 };
        counts[transport]++;
        diagnosticWindow.__cameraAssetTransportKinds = counts;
        const alias = pathname.slice(markerIndex + marker.length) || 'root';
        const aliases = diagnosticWindow.__cameraAssetTransportAliases ?? {};
        aliases[alias] = (aliases[alias] ?? 0) + 1;
        diagnosticWindow.__cameraAssetTransportAliases = aliases;
        return `${fixtureOrigin}${pathname.slice(markerIndex + marker.length)}`;
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const sourceUrl = input instanceof Request ? input.url : String(input);
        const routedUrl = resolveFixtureUrl(sourceUrl, 'fetch');
        if (routedUrl === sourceUrl) return nativeFetch(input, init);
        const routedRequest = input instanceof Request ? new Request(routedUrl, input) : routedUrl;
        return nativeFetch(routedRequest, init);
      };
      const nativeXhrOpen = XMLHttpRequest.prototype.open;
      const nativeXhrSend = XMLHttpRequest.prototype.send;
      const xhrAliases = new WeakMap<XMLHttpRequest, string>();
      XMLHttpRequest.prototype.open = function(
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null,
      ): void {
        const sourceUrl = String(url);
        const routedUrl = resolveFixtureUrl(sourceUrl, 'xhr');
        if (routedUrl !== sourceUrl) xhrAliases.set(this, new URL(sourceUrl).pathname.split('/').at(-1) ?? 'root');
        const args = async === undefined
          ? [method, routedUrl]
          : [method, routedUrl, async, username, password];
        Reflect.apply(nativeXhrOpen, this, args);
      };
      XMLHttpRequest.prototype.send = function(
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ): void {
        const alias = xhrAliases.get(this);
        if (alias) {
          this.addEventListener('loadend', () => {
            const diagnosticWindow = window as Window & { __cameraAssetTransportResponses?: Record<string, number> };
            const response = this.response;
            const responseBytes = response instanceof ArrayBuffer
              ? response.byteLength
              : response instanceof Blob ? response.size
                : typeof response === 'string' ? new TextEncoder().encode(response).byteLength : 0;
            const responseKey = `${alias}:${this.status}:${this.responseType || 'default'}:${responseBytes}`;
            const responses = diagnosticWindow.__cameraAssetTransportResponses ?? {};
            responses[responseKey] = (responses[responseKey] ?? 0) + 1;
            diagnosticWindow.__cameraAssetTransportResponses = responses;
          }, { once: true });
        }
        if (body === undefined) return Reflect.apply(nativeXhrSend, this, []);
        return Reflect.apply(nativeXhrSend, this, [body]);
      };
      const imageSource = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (imageSource?.get && imageSource.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          configurable: true,
          enumerable: imageSource.enumerable,
          get: imageSource.get,
          set(this: HTMLImageElement, value: string) {
            imageSource.set?.call(this, resolveFixtureUrl(String(value), 'image'));
          },
        });
      }
      const nativeSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        const routedValue = this instanceof HTMLImageElement && name.toLowerCase() === 'src'
          ? resolveFixtureUrl(value, 'image') : value;
        return nativeSetAttribute.call(this, name, routedValue);
      };
      Object.defineProperty(window, 'aeonStageryAPI', {
        configurable: true,
        value: {
          fs: {
            readTextFile: async (filePath: string) => {
              const normalizedPath = filePath.replaceAll('\\', '/').toLowerCase();
              if (!normalizedPath.endsWith('/model.model3.json') && normalizedPath !== 'model.model3.json') {
                return { success: false, error: 'Fixture file is unavailable.' };
              }
              const response = await nativeFetch(`${fixtureOrigin}model.model3.json`);
              if (!response.ok) return { success: false, error: `Fixture response ${response.status}.` };
              const diagnosticWindow = window as Window & { __cameraModelJsonReadCount?: number };
              diagnosticWindow.__cameraModelJsonReadCount = (diagnosticWindow.__cameraModelJsonReadCount ?? 0) + 1;
              return { success: true, data: await response.text() };
            },
          },
        },
      });
    }, pageOrigin);
    page.on('request', request => {
      const requestPath = new URL(request.url()).pathname;
      const prefix = '/__camera_fixture/';
      if (!requestPath.startsWith(prefix)) return;
      const assetName = requestPath.slice(prefix.length);
      fixtureRequests.set(assetName, (fixtureRequests.get(assetName) ?? 0) + 1);
      const scheme = new URL(request.url()).protocol.slice(0, -1);
      const requestKey = `${assetName}:${scheme}`;
      fixtureRequestSchemes.set(requestKey, (fixtureRequestSchemes.get(requestKey) ?? 0) + 1);
    });
    page.on('response', response => {
      const responseUrl = new URL(response.url());
      if (!responseUrl.pathname.startsWith('/__camera_fixture/')) return;
      const assetName = responseUrl.pathname.slice('/__camera_fixture/'.length);
      const responseKey = `${assetName}:${response.status()}`;
      fixtureResponseStatuses.set(responseKey, (fixtureResponseStatuses.get(responseKey) ?? 0) + 1);
    });
    page.on('requestfailed', request => {
      const requestUrl = new URL(request.url());
      const routePrefix = '/__camera_fixture/';
      const routeIndex = requestUrl.pathname.lastIndexOf(routePrefix);
      if (routeIndex < 0 && requestUrl.protocol !== 'asset:') return;
      const assetName = routeIndex >= 0
        ? requestUrl.pathname.slice(routeIndex + routePrefix.length)
        : path.posix.basename(requestUrl.pathname) || 'root';
      const failure = request.failure()?.errorText ?? 'unknown';
      const failureKey = `${assetName}:${requestUrl.protocol.slice(0, -1)}:${failure}`;
      fixtureRequestFailures.set(failureKey, (fixtureRequestFailures.get(failureKey) ?? 0) + 1);
    });
    page.on('console', message => {
      const text = message.text();
      if (message.type() !== 'error' || !text.includes('Failed to load model')) return;
      modelLoadErrorCount++;
      for (const assetName of ['model.model3.json', ...fixture.assets.keys()]) {
        if (text.includes(assetName)) modelLoadFailureAssetAliases.add(assetName);
      }
      const summary = text.split('\n', 1)[0]
        .replaceAll(args.modelEntry, '[model]')
        .replaceAll(path.dirname(args.modelEntry), '[fixture-root]')
        .replaceAll(args.core, '[Core]')
        .replace(/(?:file|asset|https?):\/\/[^\s"'`]+/g, '[url]')
        .replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s"'`]+[\\/]){2,}[^\\/\s"'`]+/g, '[path]')
        .slice(0, 300);
      if (modelLoadErrors.size < 3) modelLoadErrors.add(summary);
    });
    await page.route('**/__camera_fixture/**', async route => {
      const requestUrl = new URL(route.request().url());
      const assetName = decodeURIComponent(requestUrl.pathname.slice('/__camera_fixture/'.length));
      if (assetName === 'core.js') {
        await route.fulfill({ status: 200, body: fs.readFileSync(args.core), contentType: 'application/javascript' });
        return;
      }
      if (assetName === 'model.model3.json') {
        await route.fulfill({ status: 200, body: fixture.modelJson, contentType: 'application/json' });
        return;
      }
      const asset = fixture.assets.get(assetName);
      if (!asset) {
        missingFixtureAssets.add(assetName);
        await route.fulfill({ status: 404, body: 'missing benchmark fixture', contentType: 'text/plain' });
        return;
      }
      await route.fulfill({ status: 200, body: fs.readFileSync(asset.file), contentType: asset.contentType });
    });
    await page.goto(`${origin}/src/__benchmarks__/cameraProductionBrowserHarness.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof (window as Window & { runCameraProductionExport?: unknown }).runCameraProductionExport === 'function');
    const browserResult = await page.evaluate(async serializedInput => {
      const currentWindow = window as Window & {
        runCameraProductionExport?: (value: CameraProductionBrowserInput) => Promise<CameraProductionBrowserResult>;
      };
      if (!currentWindow.runCameraProductionExport) throw new Error('Camera export harness did not initialize.');
      return currentWindow.runCameraProductionExport(JSON.parse(serializedInput) as CameraProductionBrowserInput);
    }, JSON.stringify(input));
    electronModelJsonReadCount = await page.evaluate(() =>
      (window as Window & { __cameraModelJsonReadCount?: number }).__cameraModelJsonReadCount ?? 0);
    const assetTransport = await page.evaluate(() => {
      const diagnosticWindow = window as Window & {
        __cameraAssetTransportRewriteCount?: number;
        __cameraAssetTransportKinds?: Record<'fetch' | 'xhr' | 'image', number>;
        __cameraAssetTransportAliases?: Record<string, number>;
        __cameraAssetTransportResponses?: Record<string, number>;
      };
      return {
        rewriteCount: diagnosticWindow.__cameraAssetTransportRewriteCount ?? 0,
        kinds: diagnosticWindow.__cameraAssetTransportKinds ?? { fetch: 0, xhr: 0, image: 0 },
        aliases: diagnosticWindow.__cameraAssetTransportAliases ?? {},
        responses: diagnosticWindow.__cameraAssetTransportResponses ?? {},
      };
    });
    const resultWithFixtureDiagnostics: CameraProductionBrowserResult & {
      fixtureRequests: Record<string, number>;
      fixtureRequestSchemes: Record<string, number>;
      fixtureResponseStatuses: Record<string, number>;
      fixtureRequestFailures: Record<string, number>;
      assetTransport: {
        rewriteCount: number;
        kinds: Record<'fetch' | 'xhr' | 'image', number>;
        aliases: Record<string, number>;
        responses: Record<string, number>;
      };
      missingFixtureAssets: string[];
      modelLoadErrorCount: number;
      modelLoadErrors: string[];
      modelLoadFailureAssetAliases: string[];
      electronModelJsonReadCount: number;
    } = {
      ...browserResult,
      fixtureRequests: Object.fromEntries(fixtureRequests),
      fixtureRequestSchemes: Object.fromEntries(fixtureRequestSchemes),
      fixtureResponseStatuses: Object.fromEntries(fixtureResponseStatuses),
      fixtureRequestFailures: Object.fromEntries(fixtureRequestFailures),
      assetTransport,
      missingFixtureAssets: [...missingFixtureAssets],
      modelLoadErrorCount,
      modelLoadErrors: [...modelLoadErrors],
      modelLoadFailureAssetAliases: [...modelLoadFailureAssetAliases],
      electronModelJsonReadCount,
    };
    const outputStat = await fs.promises.stat(outputPath);
    const verifiedResult = { ...resultWithFixtureDiagnostics, encodedSizeBytes: outputStat.size };
    const decoded = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-map', '0:v:0', '-f', 'framemd5', '-'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const decodedFrames = decoded.split('\n').filter(line => /^0,/.test(line));
    const decodedHashes = new Set(decodedFrames.map(line => line.split(',').at(-1)?.trim() ?? ''));
    const versions = {
      browserVersion: browser.version(),
      ffmpegVersion: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n', 1)[0],
    };
    console.log('CAMERA_PRODUCTION_BROWSER_RESULT ' + JSON.stringify({
      ...verifiedResult,
      ...versions,
      outputBytes: outputStat.size,
      decodedFrameCount: decodedFrames.length,
      uniqueDecodedFrameHashes: decodedHashes.size,
    }));
    expect(verifiedResult.frameCount).toBe(args.expectedFrames.length);
    expect(verifiedResult.renderedFrameCount).toBe(args.expectedFrames.length);
    expect(verifiedResult.uniqueRenderedFrameHashes, JSON.stringify(verifiedResult)).toBeGreaterThan(1);
    expect(verifiedResult.firstFrameNonzeroPixelCount).toBeGreaterThan(0);
    expect(verifiedResult.firstFramePixelsDistinctFromCorner).toBeGreaterThan(0);
    expect(verifiedResult.fixtureRequests['model.model3.json']).toBeGreaterThan(0);
    expect(verifiedResult.fixtureRequests['model.moc3']).toBeGreaterThan(0);
    expect(Object.keys(verifiedResult.fixtureRequests).some(name => name.startsWith('texture-'))).toBe(true);
    expect(Object.keys(verifiedResult.fixtureRequests).some(name => name.startsWith('motion-'))).toBe(true);
    expect(verifiedResult.missingFixtureAssets).toEqual([]);
    expect(verifiedResult.modelLoadErrorCount).toBe(0);
    expect(verifiedResult.modelState.characterPresent).toBe(true);
    expect(verifiedResult.modelState.snapshotAvailable).toBe(true);
    expect(verifiedResult.modelState.uniqueParameterSnapshots).toBeGreaterThan(1);
    expect(verifiedResult.modelState.visibleModelBounds?.first.width ?? 0).toBeGreaterThan(0);
    expect(verifiedResult.modelState.visibleModelBounds?.first.height ?? 0).toBeGreaterThan(0);
    expect(verifiedResult.modelState.visibleModelBoundsIntersectStage).toBe(true);
    expect(verifiedResult.playback.updateCount).toBeGreaterThan(0);
    expect(verifiedResult.playback.maxSameTimeCompositionUnits).toBeLessThan(1e-8);
    expect(verifiedResult.playback.seekParityCompositionUnits).toBeLessThan(1e-8);
    expect(verifiedResult.maxCameraParityCompositionUnits).toBeLessThan(1e-8);
    expect(verifiedResult.maxCameraParityZoom).toBeLessThan(1e-12);
    expect(verifiedResult.maxCameraParityRotation).toBeLessThan(1e-12);
    expect(verifiedResult.encodedSizeBytes).toBeGreaterThan(0);
    expect(outputStat.size).toBeGreaterThan(0);
    expect(decodedFrames).toHaveLength(args.expectedFrames.length);
    expect(decodedHashes.size).toBeGreaterThan(1);
    return {
      ...verifiedResult,
      ...versions,
      outputBytes: outputStat.size,
      decodedFrameCount: decodedFrames.length,
      uniqueDecodedFrameHashes: decodedHashes.size,
    };
  } finally {
    await browser?.close();
    await server?.close();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    await invokeFFmpegHandler('cancelExport').catch(() => undefined);
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
}

const ffmpegHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => { ffmpegHandlers.set(name, handler); },
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
}));

import { registerFFmpegHandlers } from '../../electron/ffmpeg-export';

vi.hoisted(() => {
  vi.stubGlobal('document', { body: { classList: { add: () => {}, remove: () => {} } }, documentElement: { setAttribute: () => {}, removeAttribute: () => {}, style: { setProperty: () => {} } }, createElement: () => ({ getContext: () => null, style: {} }) });
});

vi.mock('../engine/Live2DRuntimeAdapter', async original => ({
  ...await original<typeof import('../engine/Live2DRuntimeAdapter')>(), getLive2DRuntimeAdapter: vi.fn(),
}));

// Compare the actual prior production algorithm, never a synthetic prototype.
// The generated copy is workspace-only; the pinned Git object is its source.
vi.mock('../engine/CameraFollowHistory', async original => {
  if (process.env.AEON_CAMERA_BENCHMARK_POLICY !== 'baseline') return original();
  const { execFileSync } = await import('node:child_process');
  const filesystem = await import('node:fs');
  const paths = await import('node:path');
  const { pathToFileURL: fileUrl } = await import('node:url');
  const directory = paths.resolve('.superpowers/sdd/camera-production-baseline-runtime');
  filesystem.mkdirSync(directory, { recursive: true });
  const file = paths.join(directory, 'CameraFollowHistory.ts');
  const source = execFileSync('git', ['show', 'acfee6cbc5b87fe2d18dcebd401f786d9199dd20:src/engine/CameraFollowHistory.ts'], { encoding: 'utf8' })
    .replace("from './CameraStateResolver'", "from '../../../src/engine/CameraStateResolver'");
  // Diagnostics do not alter the algorithm or cache contents.
  filesystem.writeFileSync(file, source + `
export function getCameraFollowHistoryDiagnostics(trajectory: CameraAnchorTrajectory) {
  const contexts = followCheckpointCache.get(trajectory);
  return { anchorQueries: 0, indexedPoints: 0, contexts: contexts?.size ?? 0,
    checkpoints: [...contexts?.values() ?? []].reduce((sum, frames) => sum + frames.size, 0) };
}
`);
  return await import(fileUrl(file).href) as typeof import('../engine/CameraFollowHistory');
});

const enabled = process.env.AEON_CAMERA_BENCHMARK === '1';
// Imports need a canvas boundary even when skipped. Restore it immediately
// in normal suites; skipped tests do not execute afterEach cleanup.
if (!enabled) vi.unstubAllGlobals();
const duration = 600;
const runtime = { runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true } as const;
const bytes = (file: string): ArrayBuffer => new Uint8Array(fs.readFileSync(file)).buffer;
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const timed = async <T,>(run: () => T | Promise<T>) => {
  const start = performance.now(); const value = await run(); return { value, ms: performance.now() - start };
};

afterEach(() => { gsap.globalTimeline.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.skipIf(!enabled)('measures real prepared history across ten-minute playback, seek, Bake and capture', async () => {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 is required.');
  const output = process.env.AEON_CAMERA_BENCHMARK_OUTPUT ?? '.superpowers/sdd/camera-production-current.json';
  const progress: Record<string, unknown> = {};
  const persist = (stage: string, data: unknown) => { progress[stage] = data; fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output + '.progress.json', JSON.stringify(progress, null, 2) + '\n'); };
  const entry = process.env.AEON_CUBISM_TEST_MODEL;
  const core = resolveCubismWebCorePath();
  if (!entry || !core) throw new Error('Real model and Core fixtures are required.');
  const source: RealModelDocument = JSON.parse(fs.readFileSync(entry, 'utf8'));
  const motion = process.env.AEON_CUBISM_TEST_MOTION ?? Object.keys(source.FileReferences.Motions)[0];
  const motionFile = path.resolve(path.dirname(entry), source.FileReferences.Motions[motion][0].File);
  const motionData: { Meta: { Duration: number; Fps: number; Loop: boolean } } = JSON.parse(fs.readFileSync(motionFile, 'utf8'));
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('WebGLBuffer', class {});
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=core-load\n');
  vm.runInThisContext(fs.readFileSync(core, 'utf8'), { filename: 'live2dcubismcore.min.js' });
  Object.assign(window, { Live2DCubismCore: (globalThis as typeof globalThis & { Live2DCubismCore?: unknown }).Live2DCubismCore });
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=sdk-load\n');
  const sdk = await import('untitled-pixi-live2d-engine/cubism');
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=sdk-ready\n');
  await sdk.cubismReady();
  let modelCount = 0;
  let coreFrames = 0;
  let recordDense: { start: number; end: number } | null = null;
  const densePoses: { time: number; position: { x: number; y: number } }[] = [];
  const adapter = new CubismPixiLive2DAdapter();
  vi.spyOn(adapter, 'createModel').mockImplementation(async () => {
    const json = structuredClone(source);
    json.FileReferences.Motions = { [motion]: json.FileReferences.Motions[motion] };
    json.FileReferences.Expressions = [];
    json.url = pathToFileURL(entry).href;
    for (const definition of json.FileReferences.Motions[motion]) delete definition.Sound;
    const factory = sdk.Live2DFactory.runtimes[0];
    const settings = factory.createModelSettings(json);
    const native = factory.createCoreModel(bytes(path.resolve(path.dirname(entry), json.FileReferences.Moc)));
    const internal = factory.createInternalModel(native, settings, { motionPreload: sdk.MotionPreloadStrategy.NONE, eyeBlink: false });
    const model = new sdk.Live2DModel({ autoUpdate: false, autoFocus: false });
    model.internalModel = internal;
    // Real Core geometry and production motion stages; this benchmark has no GPU/texture context.
    Object.assign(model, { renderForBake: () => {} });
    installCubismPixiModelRuntime(model);
    const geometry = model as unknown as {
      setSceneTime: (time: number, delta?: number) => void;
      renderForBake: (renderer: unknown, target?: unknown) => void;
      updateDrawableBounds: () => void;
    };
    expect(typeof geometry.updateDrawableBounds).toBe('function');
    const initialHeight = model.getLocalBounds().height;
    const setTime = geometry.setSceneTime.bind(model);
    const render = geometry.renderForBake.bind(model);
    let sceneTime = 0;
    geometry.setSceneTime = (time, delta) => { sceneTime = time; setTime(time, delta); };
    geometry.renderForBake = (renderer, target) => {
      render(renderer, target);
      if (!recordDense || sceneTime < recordDense.start || sceneTime > recordDense.end) return;
      geometry.updateDrawableBounds();
      const bounds = model.getLocalBounds();
      // Independent direct posed-bounds formula in composition units. No
      // production anchor helper, prepared sampler or camera evaluator oracle.
      const progress = Math.max(0, Math.min(1, (sceneTime - 10) / 0.08));
      densePoses.push({ time: sceneTime, position: {
        x: 0.65 - 0.3 * progress + (bounds.x + bounds.width / 2 - model.pivot.x) / initialHeight * 1080 / 1920,
        y: 0.7 - 0.2 * progress + (bounds.y + bounds.height / 2 - model.pivot.y) / initialHeight,
      } });
    };
    const update = model.update.bind(model);
    model.update = delta => { coreFrames++; update(delta); };
    modelCount++;
    return model as unknown as Live2DModelDisplayObject;
  });
  vi.spyOn(adapters, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
  vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue(runtime);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const value = String(url); const file = value.startsWith('asset://')
      ? decodeURIComponent(new URL(value).pathname) : value.startsWith('file:') ? fileURLToPath(value) : path.resolve(value);
    const data = fs.readFileSync(file);
    return { ok: true, json: async () => JSON.parse(data.toString()), arrayBuffer: async () => new Uint8Array(data).buffer };
  }));
  vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
  vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
  vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
  vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
  vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
  vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
  const root = new Container();
  let rendered = 0;
  let captureStarted = false;
  let lastRenderedCamera: ReturnType<typeof cameraController.getState> | undefined;
  const app = { stage: root, canvas: document.createElement('canvas'), ticker: { add: () => {}, remove: () => {} }, renderer: {
    width: 1920, height: 1080, resolution: 1, screen: { width: 1920, height: 1080 }, background: { color: 0, alpha: 1 },
    resize: () => {}, resetState: () => {}, render: () => { rendered++; if (captureStarted) lastRenderedCamera = cameraController.getState(); },
  } } as unknown as Application;
  vi.spyOn(stageManager, 'getApp').mockReturnValue(app);
  vi.spyOn(stageManager, 'getLayer').mockReturnValue(root);
  const statements: CurrentSceneDocument['statements'] = [
    { id: 'enter', type: 'characterPresence', time: 0, params: { mode: 'enter', id: 'hero', position: [0.65, 0.7], durationSeconds: 0 } },
    { id: 'motion', type: 'characterPerformance', time: 0, params: { target: 'hero', motion: { kind: 'resource', key: motion, durationSeconds: duration } } },
    { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
    { id: 'follow', type: 'camera', time: 0, params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 0.9 } },
    { id: 'walk', type: 'characterTransform', time: 10, params: { id: 'hero', position: [0.35, 0.5], durationSeconds: 0.08, ease: 'linear' } },
    { id: 'leave', type: 'characterPresence', time: 300, params: { mode: 'exit', id: 'hero', durationSeconds: 0 } },
    { id: 'end', type: 'camera', time: duration, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
    { id: 'return', type: 'characterPresence', time: 302, params: { mode: 'enter', id: 'hero', position: [0.75, 0.7], durationSeconds: 0 } },
  ];
  const scene = (await new SemanticScenePipeline({ resolveAsset: source => source }).processDocument({
    schemaVersion: 5, sceneId: 'camera-production', meta: { title: 'Real camera production benchmark', resolution: [1920, 1080], fps: 60,
      durationSeconds: duration, characters: [{ id: 'hero', name: 'Real fixture', model: pathToFileURL(entry).href }] }, statements,
  })).prepared;
  const preparedModelReferences = scene.actions.filter(action => action.action === 'addCharacter').map(action => {
    const model = action.params.model;
    if (model && typeof model === 'object' && !Array.isArray(model)) {
      const reference = model as Record<string, unknown>;
      return {
        kind: 'prepared-asset-reference',
        unavailable: reference.unavailable === true,
        sourceScheme: uriScheme(reference.source),
        runtimeUriScheme: uriScheme(reference.runtimeUri),
      };
    }
    return { kind: typeof model, scheme: uriScheme(model) };
  });
  const bake = new BakeEngine(app);
  let prepared: BakeResult | undefined;
  let preparationMs = 0;
  const supplementaryExport = process.env.AEON_CAMERA_BENCHMARK_SUPPLEMENT === '1';
  const preparedTrackCachePath = process.env.AEON_CAMERA_BENCHMARK_PREPARED_TRACKS;
  let tracks: readonly PreparedCameraAnchorTrajectory[];
  let anchorRevision: string | number;
  let loadIncludingPreparationMs = 0;
  let diagnosticTrackReuse = false;
  const engine = new ScriptEngine(() => ({ prepareCameraAnchorsPrepared: async (value, paths, token, options) => {
    const measured = await timed(() => bake.prepareCameraAnchorsPrepared(value, paths, token, options));
    prepared = measured.value; preparationMs = measured.ms;
    return measured.value;
  }, cancel: () => bake.cancel(), destroy: () => {} }));
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  gc?.(); const heapBefore = process.memoryUsage();
  fs.writeSync(1, 'CAMERA_BENCHMARK stage=prepare\n');
  try {
    if (supplementaryExport && preparedTrackCachePath && fs.existsSync(preparedTrackCachePath)) {
      const cached = JSON.parse(fs.readFileSync(preparedTrackCachePath, 'utf8')) as {
        anchorRevision: string | number;
        anchorTrajectories: PreparedCameraAnchorTrajectory[];
      };
      if (!cached.anchorTrajectories.length) throw new Error('Prepared diagnostic track cache is empty.');
      tracks = cached.anchorTrajectories;
      anchorRevision = cached.anchorRevision;
      diagnosticTrackReuse = true;
      persist('track-cache', { diagnosticTrackReuse, trackCount: tracks.length });
      fs.writeSync(1, 'CAMERA_BENCHMARK stage=diagnostic-track-cache-reuse\n');
    } else {
      const load = await timed(() => engine.loadPreparedScene(scene));
      loadIncludingPreparationMs = load.ms;
      persist('preparation', { preparationMs, loadMs: load.ms, coreFrames, modelCount });
      tracks = prepared!.anchorTrajectories!;
      anchorRevision = prepared!.anchorRevision!;
      if (supplementaryExport && preparedTrackCachePath) {
        fs.mkdirSync(path.dirname(preparedTrackCachePath), { recursive: true });
        fs.writeFileSync(preparedTrackCachePath, JSON.stringify({ anchorRevision, anchorTrajectories: tracks }));
      }
    }
    const head = tracks.find(track => track.part === 'center')!;
    fs.writeSync(1, `CAMERA_BENCHMARK preparedMs=${preparationMs} samples=${head.samples.length} models=${modelCount} coreFrames=${coreFrames}\n`);
    fs.writeSync(1, JSON.stringify({ sceneDuration: scene.durationSeconds, validity: head.validity, lastSample: head.samples.at(-1), actionSummary: scene.actions.map(action => ({ action: action.action, time: action.time, duration: action.params.duration })) }) + '\n');
    persist('tracks', { validity: head.validity, samples: head.samples.length, trackCount: tracks.length });
    expect(head.samples.length).toBeGreaterThan(8900);
    expect(head.validity[0].end).toBe(300);
    expect(head.validity[1].start).toBe(302);
    expect(head.validity).toHaveLength(2);
    expect(Math.hypot(head.samples[1].position.x - head.samples[0].position.x,
      head.samples[1].position.y - head.samples[0].position.y)).toBeGreaterThan(1e-8);
    if (supplementaryExport) {
      const timeline = preparedSceneToRuntimeTimelineScene(scene).timeline;
      const exportFps = 24;
      const exportStart = 10;
      const exportEnd = 11;
      const expectedFrames = Array.from({ length: (exportEnd - exportStart) * exportFps }, (_, index) => {
        const time = exportStart + index / exportFps;
        const state = evaluateCameraChannels({
          timeline,
          sceneTime: time,
          logicalReferenceSize: { width: 1920, height: 1080 },
          anchorTrajectories: tracks,
          trajectoryRevision: anchorRevision,
        });
        return { time, position: state.position, zoom: state.zoom, rotation: state.rotation };
      });
      fs.writeSync(1, 'CAMERA_BENCHMARK stage=real-webgl-and-encoded-export-supplement\n');
      fs.writeSync(1, 'CAMERA_BENCHMARK preparedModelReferences=' + JSON.stringify(preparedModelReferences) + '\n');
      const realExport = await measureRealBrowserExport({
        scene,
        anchorRevision,
        anchorTrajectories: tracks,
        expectedFrames,
        modelEntry: entry,
        motion,
        model: source,
        core,
      });
      const result = {
        policy: 'current-browser-supplement',
        preparationPolicy: process.env.AEON_CAMERA_BENCHMARK_POLICY === 'baseline' ? 'baseline' : 'production',
        browserAlgorithmSource: 'current-worktree Vite module graph; Node Vitest baseline mock is not applied',
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, gc: !!gc },
        input: {
          fixture: { prunedMotionCatalog: true, physics: false, autoEyeBlink: false },
          preparedModelReferences,
          duration,
          motionMeta: motionData.Meta,
          modelCount,
          coreFrames,
          trackCount: tracks.length,
          samples: tracks.reduce((sum, track) => sum + track.samples.length, 0),
        },
        timingsMs: { loadIncludingPreparation: loadIncludingPreparationMs, preparation: preparationMs },
        diagnosticTrackReuse,
        normalPlaybackAndEncodedExport: realExport,
      };
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
      fs.writeSync(1, 'CAMERA_BENCHMARK_RESULT ' + JSON.stringify(result) + '\n');
      return;
    }
    // Count sample-array reads at the public evaluator seam without changing coordinates/order.
    let reads = 0;
    let baselineQueries = 0;
    const validity = new Proxy(head.validity, { get(target, property, receiver) {
      if (property === 'find') return (...args: Parameters<typeof target.find>) => { baselineQueries++; return target.find(...args); };
      return Reflect.get(target, property, receiver);
    } });
    const countedHead = { ...head, validity, samples: new Proxy(head.samples, { get(target, property, receiver) {
      if (property === 'filter') return (...args: Parameters<typeof target.filter>) => { reads += target.length; return target.filter(...args); };
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++; return Reflect.get(target, property, receiver);
    } }) };
    const timeline = preparedSceneToRuntimeTimelineScene(scene).timeline;
    const evaluation = { timeline, logicalReferenceSize: { width: 1920, height: 1080 },
      anchorTrajectories: [countedHead], trajectoryRevision: prepared!.anchorRevision };
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=cold-query\n');
    gc?.(); const derivedHeapBefore = process.memoryUsage().heapUsed;
    const coreFramesBeforeQueries = coreFrames;
    const first = await timed(() => evaluateCameraChannels({ ...evaluation, sceneTime: 599.12345 }));
    gc?.(); const derivedHeapAfter = process.memoryUsage().heapUsed;
    const coldReads = reads; const coldBaselineQueries = baselineQueries; baselineQueries = 0; const coldDiagnostics = getCameraFollowHistoryDiagnostics(countedHead); reads = 0;
    const warm = await timed(() => { for (let index = 0; index < 100; index++) evaluateCameraChannels({ ...evaluation, sceneTime: 599.12345 }); });
    const warmReads = reads; const warmBaselineQueries = baselineQueries; const warmDiagnostics = getCameraFollowHistoryDiagnostics(countedHead);
    expect(coreFrames).toBe(coreFramesBeforeQueries);
    const firstSeek = await timed(() => engine.seek(599.12345));
    const warmSeek = await timed(async () => { for (let index = 0; index < 20; index++) await engine.seek(599.12345); });
    persist('queries', { firstMs: first.ms, coldReads, coldDiagnostics, coldBaselineQueries, warmBaselineQueries, warm100Ms: warm.ms, warmReads, warmDiagnostics, firstSeekMs: firstSeek.ms, warm20SeeksMs: warmSeek.ms, gc: !!gc, derivedHeapBefore, derivedHeapAfter, derivedHeapDelta: derivedHeapAfter - derivedHeapBefore });
    const checkTimes = [0, 0.012345, 10.01234, 299.99999, 300, 301, 302, 302.00001, 598.12345, 599.12345];
    const expected = checkTimes.map(sceneTime => evaluateCameraChannels({ ...evaluation, sceneTime }));
    const historyIntegrationErrors = checkTimes.map((time, index) => {
      const reference = referencePreparedFollow(head, time);
      const actual = expected[index].position;
      return { time, compositionUnits: Math.hypot((actual.x - reference.x) * 1920, (actual.y - reference.y) * 1080) };
    });
    expect(Math.max(...historyIntegrationErrors.map(sample => sample.compositionUnits))).toBeLessThan(0.5);
    for (const fps of [24, 30, 60, 120]) {
      for (let frame = 0; frame <= fps; frame++) evaluateCameraChannels({ ...evaluation, sceneTime: 598 + frame / fps });
      for (let index = checkTimes.length - 1; index >= 0; index--) expect(evaluateCameraChannels({ ...evaluation, sceneTime: checkTimes[index] })).toEqual(expected[index]);
    }
    const coldTrack = { ...head, samples: [...head.samples] };
    expect(evaluateCameraChannels({ ...evaluation, anchorTrajectories: [coldTrack], sceneTime: 599.12345 })).toEqual(first.value);
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=dense-reference\n');
    recordDense = { start: 0, end: 5 };
    const dense = await timed(() => bake.bakePreparedRange(scene, new Map(), 99, 0, 5, 1 / 240, undefined, true, {
      scene, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: tracks, anchorRevision: prepared!.anchorRevision!,
    }));
    recordDense = { start: 9.95, end: 10.15 };
    const fastDense = await timed(() => bake.bakePreparedRange(scene, new Map(), 98, 9.95, 10.15, 1 / 240, undefined, true, {
      scene, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: tracks, anchorRevision: prepared!.anchorRevision!,
    }));
    recordDense = null;
    const trajectoryErrors = densePoses.filter(sample => sample.time > 0).map(sample => {
      const approximate = sampleCameraAnchorTrajectory(head, sample.time)!;
      return Math.hypot((approximate.x - sample.position.x) * 1920, (approximate.y - sample.position.y) * 1080);
    });
    expect(trajectoryErrors.length).toBeGreaterThan(1000);
    expect(Math.max(...trajectoryErrors)).toBeLessThan(1);
    const approximation = { cadenceHz: 15, referenceHz: 240, referenceWindows: [[0, 5], [9.95, 10.15]], samples: trajectoryErrors.length,
      maxCompositionPixels: Math.max(...trajectoryErrors), rmsCompositionPixels: Math.sqrt(trajectoryErrors.reduce((sum, error) => sum + error * error, 0) / trajectoryErrors.length), denseBakeMs: dense.ms, fastDenseBakeMs: fastDense.ms };
    persist('approximation', approximation);
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=bake\n');
    const baked = await timed(() => bake.bakePreparedRange(scene, new Map(), 100, 598, 600, 1 / 24, undefined, true, {
      scene, logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: tracks, anchorRevision: prepared!.anchorRevision!,
    }));
    for (const sample of baked.value.cameraStates ?? []) {
      await engine.seek(sample.time); expect(engine.getCameraEvaluation()).toEqual(sample.state);
      engine.getMasterTimeline()!.seek(sample.time, false); expect(engine.getCameraEvaluation()).toEqual(sample.state);
    }
    persist('bake', { ms: baked.ms, samples: baked.value.cameraStates?.length });
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=capture\n');
    let encoded = 0;
    const capture = new FrameCaptureEngine({ getApp: () => app, getWidth: () => 1920, getHeight: () => 1080, pauseTicker: () => {}, resumeTicker: () => {} }, engine,
      { reset: () => {}, syncEffects: () => {} }, { setExportMode: () => {}, waitForAllLoaded: async () => {}, updateAll: async () => {} }, cameraController);
    const renderedBeforeCapture = rendered;
    const exportTiming = await timed(() => capture.capture({ fps: 24, rangeStart: 598, rangeEnd: 600, width: 1920, height: 1080,
      bitrateBps: 1, outputPath: '/tmp/camera-production.mp4', codec: 'h264', backend: { init: async () => { captureStarted = true; }, encodeFrame: async () => {
        const evaluated = engine.getCameraEvaluation();
        expect(evaluated).toBeDefined(); expect(lastRenderedCamera).toBeDefined();
        expect(lastRenderedCamera!.position).toEqual(evaluated!.position);
        expect(lastRenderedCamera!.zoom).toBe(evaluated!.zoom);
        expect(lastRenderedCamera!.rotation).toBe(evaluated!.rotation);
        encoded++;
      }, finish: async () => {} }, onProgress: () => {} }));
    const browserExportFps = 24;
    const browserExportStart = 10;
    const browserExportEnd = 11;
    const browserExpectedFrames = Array.from({ length: (browserExportEnd - browserExportStart) * browserExportFps }, (_, index) => {
      const time = browserExportStart + index / browserExportFps;
      const state = evaluateCameraChannels({
        timeline,
        sceneTime: time,
        logicalReferenceSize: { width: 1920, height: 1080 },
        anchorTrajectories: tracks,
        trajectoryRevision: prepared!.anchorRevision,
      });
      return { time, position: state.position, zoom: state.zoom, rotation: state.rotation };
    });
    fs.writeSync(1, 'CAMERA_BENCHMARK stage=real-webgl-and-encoded-export\n');
    const realExport = await measureRealBrowserExport({
      scene,
      anchorRevision: prepared!.anchorRevision!,
      anchorTrajectories: tracks,
      expectedFrames: browserExpectedFrames,
      modelEntry: entry,
      motion,
      model: source,
      core,
    });
    persist('realExport', realExport);
    gc?.(); const heapAfter = process.memoryUsage();
    const prefixWriterProbe = [];
    for (const count of [64, 128, 256]) {
      const writers = Array.from({ length: count }, (_, index) => ({ _id: `zoom-${index}`, action: 'cameraMotion' as const,
        time: index / count, params: { zoom: 2 + index / count, duration: 0, _cameraProperties: ['zoom'] } }));
      const sample = await timed(() => {
        for (let repeat = 0; repeat < 3; repeat++) evaluateCameraChannels({ timeline: writers, sceneTime: 1,
          logicalReferenceSize: { width: 1920, height: 1080 }, anchorTrajectories: [] });
      });
      prefixWriterProbe.push({ writers: count, threeEvaluationsMs: sample.ms });
    }
    const result = { policy: process.env.AEON_CAMERA_BENCHMARK_POLICY ?? 'production', environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, gc: !!gc },
      input: { fixture: { prunedMotionCatalog: true, physics: false, textures: false, autoEyeBlink: false }, duration, characterCount: 1, motion, motionMeta: motionData.Meta, modelSha256: digest(entry), motionSha256: digest(motionFile),
        modelCount, coreFrames, trackCount: tracks.length, samples: tracks.reduce((sum, track) => sum + track.samples.length, 0), events: head.events.length,
        validity: head.validity, retainedTrajectoryJsonBytes: Buffer.byteLength(JSON.stringify(tracks)) },
      timingsMs: { loadIncludingPreparation: loadIncludingPreparationMs, preparation: preparationMs, firstColdEvaluation: first.ms, warm100Evaluations: warm.ms,
        firstSeekAfterPreparation: firstSeek.ms, warm20Seeks: warmSeek.ms, bake49Samples: baked.ms, capture48Frames: exportTiming.ms },
      observations: checkTimes.map((time, index) => ({ time, state: expected[index] })), historyIntegrationErrors, prefixWriterProbe, approximation, diagnostics: { cold: coldDiagnostics, warm100: warmDiagnostics, coldBaselineQueries, warmBaselineQueries }, sampleArrayReads: { cold: coldReads, warm100: warmReads }, memory: { derivedHeapBefore, derivedHeapAfter, derivedHeapDelta: derivedHeapAfter - derivedHeapBefore, heapBefore, heapAfter, heapUsedDelta: heapAfter.heapUsed - heapBefore.heapUsed },
      captureScheduling: { frames: encoded, rendered: rendered - renderedBeforeCapture, allPipelineRenders: rendered,
        framesPerSecond: encoded / (exportTiming.ms / 1000), renderer: 'injected empty renderer', gpu: false, imageEncoding: false, videoEncoding: false },
      browserPreparationPolicy: process.env.AEON_CAMERA_BENCHMARK_POLICY === 'baseline' ? 'baseline' : 'production',
      browserAlgorithmSource: 'current-worktree Vite module graph; Node Vitest baseline mock is not applied',
      normalPlaybackAndEncodedExport: realExport,
      deterministicParity: 'repeated/reverse/subframe/cold/warm/24/30/60/120 fps passed',
      anchorProbe: [0, 1, 100, 299, 302, 599].map(time => ({ time, position: sampleCameraAnchorTrajectory(head, time) })) };
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    fs.writeSync(1, 'CAMERA_BENCHMARK_RESULT ' + JSON.stringify(result) + '\n');
  } finally { engine.destroy(); bake.destroy(); root.destroy({ children: true }); }
}, 43_200_000);
