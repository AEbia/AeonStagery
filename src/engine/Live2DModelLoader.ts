/**
 * AeonStagery — Live2D Model Loader
 *
 * Extracted from Live2DManager. Handles model preloading, model.json data
 * fetching with caching, and preload pool management.
 */

import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { extractLive2DModelData } from './Live2DModelData';
import { getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import type { Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import { resolveLive2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import { captureModelNeutralPoseOnce } from './live2d/characterStatePurge';

export class Live2DModelLoader {
  private _modelDataCache: Map<string, Promise<{ motions: string[], expressions: string[] }>> = new Map();
  public preloadedModels: Map<string, any[]> = new Map();
  public preloadingModels: Map<string, Promise<void>> = new Map();
  private wmdlConfigRegistry: WmdlConfigRegistry | null = null;

  constructor(
    private getBasePath: () => string,
  ) {}

  public setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.wmdlConfigRegistry = registry;
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
  public resolvedPathToUrl(resolvedPath: string): string {
    let fullPath = resolvedPath.replace(/\\/g, '/').trim();
    if (fullPath.startsWith('asset://')) return fullPath;
    if (fullPath.startsWith('file://')) {
      fullPath = fullPath.slice('file://'.length);
      if (/^\/[a-zA-Z]:\//.test(fullPath)) fullPath = fullPath.slice(1);
    }
    return encodeURI(`asset://localhost/${fullPath}`);
  }

  public normalizeModelPath(modelPath: string): string {
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
    } else if (normalized.startsWith('file:///')) {
      normalized = normalized.slice('file:///'.length);
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
    if (fullPath.startsWith('file:///')) fullPath = fullPath.replace('file:///', '');
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

  public async probeModelPath(modelPath: string): Promise<{ exists: boolean; fullPath: string; error?: string; runtime?: Live2DRuntimeDescriptor }> {
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
   * Preload a model into browser/SDK cache without adding to stage.
   * The caller (Live2DManager) handles the characters guard before calling this.
   */
  async preloadModel(modelUrl: string): Promise<void> {
    // A soft scene reload recycles detached instances into this pool. Reuse
    // that completed preload instead of creating another Cubism model, which
    // would expand Core memory and make activeOfficialModels more expensive
    // to refresh on every subsequent model creation.
    if (this.preloadedModels.get(modelUrl)?.length) return;

    // Prevent concurrent preloads for the same URL (ABA race)
    if (this.preloadingModels.has(modelUrl)) return;

    // Direct composed model (.wmdl) check
    const decoded = decodeURIComponent(modelUrl);
    if (decoded.endsWith('.wmdl') || decoded.includes('.wmdl?')) {
      let modelPath = decoded;
      if (modelPath.startsWith('asset://localhost/')) {
        modelPath = modelPath.replace('asset://localhost/', '');
      } else if (modelPath.startsWith('asset:///')) {
        modelPath = modelPath.replace('asset:///', '');
      }

      let wmdlConfig = this.wmdlConfigRegistry?.get(modelPath);
      if (!wmdlConfig) {
        const base = this.getBasePath().replace(/\\/g, '/');
        const relPath = modelPath.replace(base, '').replace(/^\/+/, '');
        wmdlConfig = this.wmdlConfigRegistry?.get(relPath);
      }

      if (wmdlConfig) {
        if (!wmdlConfig.modelRelativePath) {
          console.warn(`[Live2D] Invalid composed model config for ${modelUrl}: missing modelRelativePath`);
          this.preloadingModels.delete(modelUrl);
          return;
        }
        const rawTask = (async () => {
          try {
            console.log(`[Live2D] Pre-loading composed model: ${modelUrl}`);
            const mainModelUrl = this.pathToUrl(wmdlConfig.modelRelativePath);
            await this.preloadModel(mainModelUrl);

            if (wmdlConfig.subModels && Array.isArray(wmdlConfig.subModels)) {
              for (const sub of wmdlConfig.subModels) {
                if (!sub?.modelRelativePath) {
                  console.warn(`[Live2D] Skipping invalid composed sub-model entry for ${modelUrl}`);
                  continue;
                }
                const subUrl = this.pathToUrl(sub.modelRelativePath);
                await this.preloadModel(subUrl);
              }
            }
          } catch (err) {
            console.warn(`[Live2D] Preload failed for composed model ${modelUrl}:`, err);
          }
        })();
        this.preloadingModels.set(modelUrl, rawTask);
        return rawTask;
      }
    }

    const rawTask = (async () => {
      try {
        const probe = await this.probeModelPath(modelUrl);
        const runtime = probe.runtime ?? resolveLive2DRuntimeDescriptor(modelUrl);
        const adapter = getLive2DRuntimeAdapter(runtime);
        if (!runtime.supported) {
          throw new Error(adapter.getUnsupportedMessage(modelUrl) ?? 'Unsupported Live2D runtime.');
        }

        // The runtime adapter owns readiness gating for every runtime family.
        await adapter.init();
        if (!adapter.isReady()) return;

        console.log(`[Live2D] Pre-loading model: ${modelUrl}`);
        const model = await adapter.createModel(modelUrl, {
          autoHitTest: false,
          autoFocus: false,
          autoUpdate: false,
        });
        // Pristine pose: from the first `internalModel.update()` onwards the
        // Cubism 2 SDK overwrites its saved parameter buffer with the live
        // motion pose, so this is the only moment the idle pose is readable.
        captureModelNeutralPoseOnce(model);
        // 核心修复：预加载时就设为不可见且透明，防止被复用瞬间闪现
        model.visible = false;
        model.alpha = 0;
        // 存储预加载好的实例，供 addCharacter 直接拾取
        if (!this.preloadedModels.has(modelUrl)) {
          this.preloadedModels.set(modelUrl, []);
        }
        this.preloadedModels.get(modelUrl)!.push(model);
      } finally {
        this.preloadingModels.delete(modelUrl);
      }
    })();

    // Store a never-rejecting promise so addCharacter can safely await it
    const safeTask = rawTask.catch(err => {
      console.warn(`[Live2D] Preload failed for ${modelUrl}:`, err);
    });
    this.preloadingModels.set(modelUrl, safeTask);
    return safeTask;
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
