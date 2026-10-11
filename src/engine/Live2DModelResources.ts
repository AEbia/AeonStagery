/**
 * AeonStagery — Live2D Model Resources
 *
 * Owns model loading, cancellation, pooling, and texture lifetime. Stage
 * orchestration only borrows instances through loadCharacter/releaseModel.
 */

import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { extractLive2DModelData } from './Live2DModelData';
import type * as PIXI from 'pixi.js';
import { getLive2DRuntimeAdapter, type Live2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import { Live2DCompositeModel } from './Live2DCompositeModel';
import { getUnsupportedLive2DRuntimeMessage } from './Live2DRuntimeResolver';
import type { Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import { resolveLive2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import { captureModelNeutralPoseOnce } from './live2d/characterStatePurge';

export type Live2DResourceModel = PIXI.Container & {
  anchor: PIXI.ObservablePoint;
  autoUpdate?: boolean;
  tint?: number;
};

export type LoadedLive2DModel = {
  model: Live2DResourceModel;
  modelUrl: string;
  runtime: Live2DRuntimeDescriptor;
  isCurrent: () => boolean;
};

export class Live2DModelLoadError extends Error {
  constructor(message: string, readonly fullPath: string) {
    super(message);
    this.name = 'Live2DModelLoadError';
  }
}

type LoadRequest = {
  epoch: number;
  cancelled: boolean;
  completed: boolean;
  promise: Promise<void>;
};

type OwnedModel = {
  url: string;
  runtime: Live2DRuntimeDescriptor;
  epoch: number;
  pooled: boolean;
  // Constituents are owned separately; the composite has no texture of its own.
  constituents?: Live2DResourceModel[];
};

type WmdlConfig = {
  modelRelativePath: string;
  subModels?: { modelRelativePath: string; offsetX?: number; offsetY?: number }[];
};

export class Live2DModelResources {
  private _modelDataCache: Map<string, Promise<{ motions: string[], expressions: string[] }>> = new Map();
  private readonly pool = new Map<string, Live2DResourceModel[]>();
  private readonly preloads = new Map<string, Promise<void>>();
  private readonly loads = new Map<string, LoadRequest>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly owned = new Map<Live2DResourceModel, OwnedModel>();
  private readonly textureRefs = new Map<string, number>();
  private epoch = 0;
  private wmdlConfigRegistry: WmdlConfigRegistry | null = null;

  constructor(
    private getBasePath: () => string,
    private getAdapter: (runtime: Live2DRuntimeDescriptor) => Live2DRuntimeAdapter = getLive2DRuntimeAdapter,
  ) {}

  public setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.wmdlConfigRegistry = registry;
  }

  get hasPendingLoads(): boolean {
    return this.tasks.size > 0;
  }

  async waitForLoads(): Promise<void> {
    // Keep cancelled tasks until settlement: clear() must not hide in-flight work.
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  /**
   * Serialized per character. A cancelled/failed delivery is reclaimed here.
   * The caller checks isCurrent() after its asynchronous stage preparation.
   */
  async loadCharacter(
    id: string,
    modelPath: string,
    deliver: (loaded: LoadedLive2DModel) => Promise<void>,
    fallbackRenderer?: () => unknown,
  ): Promise<void> {
    const epoch = this.epoch;
    while (this.loads.has(id)) {
      const previous = this.loads.get(id)!;
      await previous.promise;
      if (epoch !== this.epoch) return;
      if (previous.completed && !previous.cancelled) return;
    }
    if (epoch !== this.epoch) return;
    const request: LoadRequest = {
      epoch, cancelled: false, completed: false, promise: Promise.resolve(),
    };
    const isCurrent = () => !request.cancelled && request.epoch === this.epoch;
    this.loads.set(id, request);
    request.promise = this.track(async () => {
      let loaded: LoadedLive2DModel | null = null;
      let deliveryOwner: OwnedModel | undefined;
      try {
        if (!isCurrent()) return;
        loaded = await this.acquire(modelPath, request.epoch, isCurrent, fallbackRenderer);
        if (loaded) deliveryOwner = this.owned.get(loaded.model);
        if (!loaded || !isCurrent()) return;
        await deliver(loaded);
        request.completed = isCurrent();
      } finally {
        // An exit can return the model during delivery. A new character may
        // already have borrowed it before this cancelled callback settles.
        if (loaded && !request.completed && this.owned.get(loaded.model) === deliveryOwner) {
          this.releaseModel(loaded.model);
        }
        if (this.loads.get(id) === request) this.loads.delete(id);
      }
    });
    await request.promise;
  }

  cancelLoad(id: string): void {
    const request = this.loads.get(id);
    if (request) request.cancelled = true;
  }

  /** Idempotent return; pooled instances retain their texture references. */
  releaseModel(model: Live2DResourceModel): void {
    const owner = this.owned.get(model);
    if (!owner || owner.pooled) return;
    model.parent?.removeChild(model);
    try {
      model.autoUpdate = false;
      this.getAdapter(owner.runtime).getControls().quiesceModel(model);
      Reflect.deleteProperty(model, '_characterEntry');
      this.resetVisualState(model);
      const pool = this.pool.get(owner.url) ?? [];
      if (owner.epoch === this.epoch && pool.length < 10) {
        owner.pooled = true;
        pool.push(model);
        this.pool.set(owner.url, pool);
        return;
      }
    } catch (error) {
      console.warn('[Live2D] Failed to recycle model:', error);
    }
    this.destroyOwnedModel(model, owner.epoch !== this.epoch);
  }

  /**
   * Cancel pending work and destroy pooled instances, preserving SDK/browser
   * textures shared with bake models. Borrowed instances live until returned.
   */
  clear(): void {
    this.epoch++;
    for (const request of this.loads.values()) request.cancelled = true;
    this.loads.clear();
    this.preloads.clear();
    for (const pool of this.pool.values()) {
      for (const model of pool) this.destroyOwnedModel(model, true);
    }
    this.pool.clear();
  }

  /** A concurrent caller waits for the same preload, including composed children. */
  async preloadModel(modelUrl: string): Promise<void> {
    if (this.pool.get(modelUrl)?.length) return;
    const pending = this.preloads.get(modelUrl);
    if (pending) return pending;
    const epoch = this.epoch;
    const isCurrent = () => epoch === this.epoch;
    const task = this.track(async () => {
      try {
        const config = this.getWmdlConfig(modelUrl);
        if (config) {
          if (!config.modelRelativePath) return;
          for (const path of [config.modelRelativePath, ...(config.subModels ?? []).map(sub => sub.modelRelativePath)]) {
            if (!isCurrent()) return;
            if (path) await this.preloadModel(this.pathToUrl(path));
          }
          return;
        }
        const probe = await this.probeModelPath(modelUrl);
        if (!isCurrent()) return;
        const runtime = probe.runtime ?? resolveLive2DRuntimeDescriptor(modelUrl);
        const adapter = this.getAdapter(runtime);
        if (!runtime.supported) throw new Error(adapter.getUnsupportedMessage(modelUrl) ?? 'Unsupported Live2D runtime.');
        await adapter.init();
        if (!isCurrent() || !adapter.isReady()) return;
        const model = await this.createConcrete(modelUrl, runtime, epoch);
        this.releaseModel(model);
      } catch (error) {
        console.warn(`[Live2D] Preload failed for ${modelUrl}:`, error);
      } finally {
        if (this.preloads.get(modelUrl) === task) this.preloads.delete(modelUrl);
      }
    });
    this.preloads.set(modelUrl, task);
    return task;
  }

  private track(task: () => Promise<void>): Promise<void> {
    // Install ownership before any synchronous pool hit or callback can finish.
    const promise = Promise.resolve().then(task);
    this.tasks.add(promise);
    void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
    return promise;
  }

  private getWmdlConfig(path: string): WmdlConfig | undefined {
    return this.wmdlConfigRegistry?.get(path) as WmdlConfig | undefined;
  }

  private retainTexture(url: string): void {
    this.textureRefs.set(url, (this.textureRefs.get(url) ?? 0) + 1);
  }

  private releaseTexture(url: string): number {
    const count = Math.max(0, (this.textureRefs.get(url) ?? 1) - 1);
    if (count) this.textureRefs.set(url, count);
    else this.textureRefs.delete(url);
    return count;
  }

  private async createConcrete(
    url: string, runtime: Live2DRuntimeDescriptor, epoch: number, fallbackRenderer?: () => unknown,
  ): Promise<Live2DResourceModel> {
    // Reserve before await: an existing instance must not destroy textures while
    // another instance using that URL is still being constructed.
    this.retainTexture(url);
    const adapter = this.getAdapter(runtime);
    let model: Live2DResourceModel | null = null;
    try {
      try {
        model = await adapter.createModel(url, {
          autoHitTest: false, autoFocus: false, autoUpdate: false, idleMotionGroup: '',
        });
      } catch (error) {
        if (runtime.runtimeFamily !== 'cubism2' || !fallbackRenderer) throw error;
        console.warn(`[Live2D] Failed to load model ${url}, using placeholder`, error);
        model = adapter.createFallbackModel(fallbackRenderer());
      }
      if (!model) throw new Error(`Live2D runtime returned no model for ${url}`);
      this.owned.set(model, { url, runtime, epoch, pooled: false });
      captureModelNeutralPoseOnce(model);
      this.resetVisualState(model);
      return model;
    } catch (error) {
      if (model && this.owned.has(model)) this.destroyOwnedModel(model, true);
      else this.releaseTexture(url);
      throw error;
    }
  }

  private async takeConcrete(
    url: string, runtime: Live2DRuntimeDescriptor, epoch: number, isCurrent: () => boolean,
    fallbackRenderer?: () => unknown,
  ): Promise<Live2DResourceModel | null> {
    const preload = this.preloads.get(url);
    if (preload) await preload;
    if (!isCurrent()) return null;
    const pool = this.pool.get(url);
    const model = pool?.pop() ?? await this.createConcrete(url, runtime, epoch, fallbackRenderer);
    if (pool && pool.length === 0 && this.pool.get(url) === pool) this.pool.delete(url);
    this.owned.set(model, { ...this.owned.get(model)!, pooled: false });
    if (!isCurrent()) {
      this.releaseModel(model);
      return null;
    }
    this.resetVisualState(model);
    return model;
  }

  private async acquire(
    modelPath: string, epoch: number, isCurrent: () => boolean, fallbackRenderer?: () => unknown,
  ): Promise<LoadedLive2DModel | null> {
    if (!modelPath) return null;
    const probe = await this.probeModelPath(modelPath);
    if (!isCurrent()) return null;
    if (!probe.exists) {
      throw new Live2DModelLoadError('模型文件无法读取。', probe.fullPath || modelPath);
    }
    const runtime = probe.runtime ?? resolveLive2DRuntimeDescriptor(modelPath);
    const unsupported = getUnsupportedLive2DRuntimeMessage(modelPath, runtime);
    if (unsupported) throw new Live2DModelLoadError(unsupported, probe.fullPath);
    const adapter = this.getAdapter(runtime);
    await adapter.init();
    if (!isCurrent() || !adapter.isReady()) return null;
    const url = this.resolvedPathToUrl(probe.fullPath || modelPath);
    const config = this.getWmdlConfig(modelPath);
    const acquired: Live2DResourceModel[] = [];
    let model: Live2DResourceModel | null = null;
    try {
      // Recycle whole composites first, preserving their installed sync hooks.
      const pooled = this.pool.get(url);
      model = pooled?.pop() ?? null;
      if (pooled && !pooled.length) this.pool.delete(url);
      if (model) this.owned.set(model, { ...this.owned.get(model)!, pooled: false });
      else if (config) {
        if (!config.modelRelativePath || (runtime.runtimeFamily !== 'cubism2' && runtime.runtimeFamily !== 'wmdl')) {
          throw new Live2DModelLoadError('组合模型配置无效或运行时不受支持。', probe.fullPath);
        }
        const main = await this.takeConcrete(this.pathToUrl(config.modelRelativePath), runtime, epoch, isCurrent);
        if (!main) return null;
        acquired.push(main);
        const subs: Live2DResourceModel[] = [];
        for (const sub of config.subModels ?? []) {
          if (!sub.modelRelativePath) continue;
          let child: Live2DResourceModel | null;
          try {
            child = await this.takeConcrete(this.pathToUrl(sub.modelRelativePath), runtime, epoch, isCurrent);
          } catch (error) {
            console.warn(`[Live2D] Failed to load sub-model: ${sub.modelRelativePath}`, error);
            if (!isCurrent()) return null;
            continue;
          }
          if (!child) return null;
          acquired.push(child);
          child.x = sub.offsetX ?? 0;
          child.y = sub.offsetY ?? 0;
          subs.push(child);
        }
        model = new Live2DCompositeModel(main, subs);
        this.owned.set(model, { url, runtime, epoch, pooled: false, constituents: acquired.slice() });
      } else {
        model = await this.takeConcrete(url, runtime, epoch, isCurrent, fallbackRenderer);
        if (!model) return null;
      }
      if (!isCurrent()) return null;
      this.resetVisualState(model);
      if (runtime.adapterId === 'pixi-live2d-display-cubism2') {
        const controls = adapter.getControls();
        for (const concrete of controls.getConcreteModels(model)) controls.isolateMask(concrete);
      }
      return { model, modelUrl: url, runtime, isCurrent };
    } catch (error) {
      if (model) this.releaseModel(model);
      throw error;
    } finally {
      if (!model || !isCurrent()) {
        if (model) this.releaseModel(model);
        else for (const concrete of acquired) this.releaseModel(concrete);
      }
    }
  }

  private resetVisualState(model: Live2DResourceModel): void {
    model.visible = false;
    model.alpha = 0;
    model.filters = null;
    model.renderable = true;
    if ('tint' in model) model.tint = 0xFFFFFF;
    if (model instanceof Live2DCompositeModel) {
      for (const child of this.owned.get(model)?.constituents ?? []) {
        child.visible = true;
        child.alpha = 1;
        child.filters = null;
        child.renderable = true;
        if ('tint' in child) child.tint = 0xFFFFFF;
      }
    }
  }

  private destroyOwnedModel(model: Live2DResourceModel, keepSharedTextures: boolean): void {
    const owner = this.owned.get(model);
    if (!owner) return;
    this.owned.delete(model);
    try {
      if (owner.constituents) {
        for (const child of owner.constituents) this.destroyOwnedModel(child, keepSharedTextures);
        // Constituent disposal already went through its own runtime adapter.
        model.removeChildren();
        if (model instanceof Live2DCompositeModel) {
          model.mainModel = null;
          model.subModels = [];
        }
        model.destroy();
      } else {
        const remaining = this.releaseTexture(owner.url);
        this.getAdapter(owner.runtime).getControls().disposeModel(model, {
          mode: 'destroy', keepTextures: keepSharedTextures || remaining > 0, detach: true,
        });
      }
    } catch (error) {
      console.warn('[Live2D] Failed to destroy owned model:', error);
    }
  }

  /**
   * Helper to normalize and resolve paths to clean asset URLs
   */
  public pathToUrl(modelPath: string): string {
    let fullPath = this.normalizeModelPath(modelPath);
    const isAbsolute = fullPath.startsWith('asset://') || fullPath.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(fullPath) || fullPath.startsWith('/');
    if (!isAbsolute) {
      fullPath = `${this.getBasePath()}/${fullPath}`.replace(/\\/g, '/');
    }
    return this.resolvedPathToUrl(fullPath);
  }

  /**
   * Convert an already-resolved filesystem path to an asset URL.
   * Unlike normalizeModelPath(), this must preserve a leading slash on POSIX.
   */
  private resolvedPathToUrl(resolvedPath: string): string {
    let fullPath = resolvedPath.replace(/\\/g, '/').trim();
    if (fullPath.startsWith('asset://')) return fullPath;
    if (fullPath.startsWith('file://')) {
      fullPath = fullPath.slice('file://'.length);
      if (/^\/[a-zA-Z]:\//.test(fullPath)) fullPath = fullPath.slice(1);
    }
    return encodeURI(`asset://localhost/${fullPath}`);
  }

  private normalizeModelPath(modelPath: string): string {
    if (!modelPath) return modelPath;
    const normalized = modelPath.replace(/\\/g, '/').trim();
    if (normalized.startsWith('/') && !normalized.startsWith('//') && !/^\/[a-zA-Z]:\//.test(normalized)) {
      return normalized.replace(/^\/+/, '');
    }
    return normalized;
  }

  private normalizeFilesystemPath(modelPath: string): string {
    let normalized = this.normalizeModelPath(modelPath).replace(/\\/g, '/').trim();

    if (normalized.startsWith('asset://localhost/')) {
      normalized = normalized.slice('asset://localhost/'.length);
    } else if (normalized.startsWith('asset:///')) {
      normalized = normalized.slice('asset:///'.length);
    } else if (normalized.startsWith('asset://')) {
      normalized = normalized.slice('asset://'.length).replace(/^\/+/, '');
    } else if (normalized.startsWith('file://')) {
      normalized = normalized.slice('file://'.length);
    }

    if (/^\/[a-zA-Z]:\//.test(normalized)) {
      normalized = normalized.slice(1);
    }

    try {
      return decodeURIComponent(normalized);
    } catch {
      return normalized;
    }
  }

  private async resolveModelFilePath(modelPath: string): Promise<string> {
    let fullPath = this.normalizeFilesystemPath(modelPath);
    const isAbsolute = fullPath.startsWith('asset://') || fullPath.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(fullPath) || fullPath.startsWith('/');
    if (!isAbsolute) {
      const projectResources = (window as any).AeonStagery?.services?.projectResources;
      if (projectResources?.getCurrentProject?.()) {
        fullPath = await projectResources.resolveForRead(fullPath);
      } else {
        fullPath = `${this.getBasePath()}/${fullPath}`.replace(/\\/g, '/');
      }
    }
    if (fullPath.startsWith('file://')) {
      fullPath = fullPath.slice('file://'.length);
      if (/^\/[a-zA-Z]:\//.test(fullPath)) fullPath = fullPath.slice(1);
    }
    return fullPath.replace(/\\/g, '/');
  }

  private toAssetUrl(fullPath: string): string {
    return fullPath.startsWith('asset://') ? fullPath : encodeURI(`asset://localhost/${fullPath.replace(/\\/g, '/')}`);
  }

  private isAbsolutePath(pathValue: string): boolean {
    return pathValue.startsWith('asset://') ||
      pathValue.startsWith('file://') ||
      /^[a-zA-Z]:[/\\]/.test(pathValue) ||
      pathValue.startsWith('/');
  }

  private dirname(pathValue: string): string {
    const normalized = pathValue.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index === -1 ? '' : normalized.slice(0, index);
  }

  private joinPath(baseDir: string, childPath: string): string {
    const child = childPath.replace(/\\/g, '/');
    if (this.isAbsolutePath(child)) return child;
    if (!baseDir) return child;
    return `${baseDir}/${child}`.replace(/\/+/g, '/');
  }

  private async readModelJson(modelPath: string, resolvedFullPath?: string): Promise<{ fullPath: string; json: any } | null> {
    if (!modelPath) return null;

    const fullPath = resolvedFullPath ?? await this.resolveModelFilePath(modelPath);
    const api = (window as any).aeonStageryAPI;

    try {
      if (api && api.fs && api.fs.readTextFile) {
        const result = await api.fs.readTextFile(fullPath);
        if (result && result.success && result.data) {
          return { fullPath, json: JSON.parse(result.data) };
        }

        const fallbackPath = this.normalizeFilesystemPath(modelPath);
        if (fallbackPath && fallbackPath !== fullPath) {
          const fallbackResult = await api.fs.readTextFile(fallbackPath);
          if (fallbackResult && fallbackResult.success && fallbackResult.data) {
            return { fullPath: fallbackPath, json: JSON.parse(fallbackResult.data) };
          }
        }
        return null;
      }

      const response = await fetch(this.toAssetUrl(fullPath));
      if (!response.ok) return null;
      return { fullPath, json: await response.json() };
    } catch (err) {
      console.warn(`[Live2D] Failed to read model JSON from ${fullPath}:`, err);
      return null;
    }
  }

  private async probeModelPath(modelPath: string): Promise<{ exists: boolean; fullPath: string; error?: string; runtime?: Live2DRuntimeDescriptor }> {
    if (!modelPath) {
      return { exists: false, fullPath: '', error: 'empty model path' };
    }

    const modelData = await this.readModelJson(modelPath);
    if (!modelData) {
      return {
        exists: false,
        fullPath: await this.resolveModelFilePath(modelPath),
        error: 'unable to read model file',
      };
    }

    if (modelPath.toLowerCase().endsWith('.wmdl')) {
      if (!modelData.json || typeof modelData.json.modelRelativePath !== 'string' || !modelData.json.modelRelativePath.trim()) {
        return {
          exists: false,
          fullPath: modelData.fullPath,
          error: 'invalid wmdl config: missing modelRelativePath',
        };
      }

      const wmdlDir = this.dirname(modelData.fullPath);
      const childPaths = [
        modelData.json.modelRelativePath,
        ...(Array.isArray(modelData.json.subModels)
          ? modelData.json.subModels.map((subModel: any) => subModel?.modelRelativePath).filter(Boolean)
          : []),
      ];
      for (const childPath of childPaths) {
        const childFullPath = this.joinPath(wmdlDir, childPath);
        const childData = await this.readModelJson(childFullPath);
        if (!childData) continue;
        const childRuntime = resolveLive2DRuntimeDescriptor(childData.fullPath, childData.json);
        if (childRuntime.runtimeFamily === 'cubism3-plus') {
          return {
            exists: true,
            fullPath: modelData.fullPath,
            runtime: {
              ...childRuntime,
              supported: false,
            },
            error: 'composed cubism3-plus models are not supported yet',
          };
        }
        if (!childRuntime.supported) {
          return {
            exists: true,
            fullPath: modelData.fullPath,
            runtime: childRuntime,
          };
        }
      }
    }

    return {
      exists: true,
      fullPath: modelData.fullPath,
      runtime: resolveLive2DRuntimeDescriptor(modelData.fullPath, modelData.json),
    };
  }

  /**
   * Static retrieval of motions/expressions from a model.json path.
   * This works even if the character is not loaded or on stage.
   */
  async getModelDataFromPath(modelPath: string): Promise<{ motions: string[], expressions: string[] }> {
    if (!modelPath) {
      console.warn('[Live2D] getModelDataFromPath called with empty modelPath, returning empty data');
      return { motions: [], expressions: [] };
    }

    // Direct composed model (.wmdl) check - pure in-memory lookup
    if (modelPath.endsWith('.wmdl')) {
      const wmdlConfig = this.wmdlConfigRegistry?.get(modelPath);
      if (wmdlConfig && wmdlConfig.modelRelativePath) {
        return this.getModelDataFromPath(wmdlConfig.modelRelativePath);
      }
      return { motions: [], expressions: [] };
    }

    // Resolve on each request so project switches and mount changes cannot reuse
    // data from a different file with the same relative model path.
    const fullPath = await this.resolveModelFilePath(modelPath);
    const modelUrl = this.toAssetUrl(fullPath);

    const cached = this._modelDataCache.get(modelUrl);
    if (cached) return cached;

    // Cache the entire read/parse operation, including in-flight requests.
    const fetchTask = this.readModelJson(modelPath, fullPath)
      .then((modelData) => {
        if (!modelData) {
          this._modelDataCache.delete(modelUrl);
          return { motions: [], expressions: [] };
        }
        const { motions, expressions } = extractLive2DModelData(modelData.json, modelData.fullPath);
        return { motions, expressions };
      })
      .catch((err) => {
        this._modelDataCache.delete(modelUrl);
        console.error(`[Live2D] Failed to fetch model data from ${fullPath}:`, err);
        return { motions: [], expressions: [] };
      });

    this._modelDataCache.set(modelUrl, fetchTask);
    return fetchTask;
  }

  /** Resolve a catalog/resource motion key to the runtime group in a model. */
  public async resolveMotionKey(modelPath: string, requestedKey: string): Promise<string> {
    const key = requestedKey.trim();
    if (!key) return key;
    const data = await this.getModelDataFromPath(modelPath);
    if (data.motions.includes(key)) return key;
    const leaf = key.split('/').at(-1) ?? key;
    const candidates = data.motions.filter((motion) => {
      const motionLeaf = motion.split('/').at(-1) ?? motion;
      return motionLeaf === leaf || motion.endsWith(`/${leaf}`);
    });
    return candidates.length === 1 ? candidates[0] : key;
  }
}
