import { DocumentStore } from '../../ui/store/DocumentStore';
import { ValidationStore } from '../../ui/store/ValidationStore';
import { ProjectResourceService } from '../../services/io/ProjectResourceService';
import type { ResourceResolution } from '../../api/types/project';
import { ProjectResourceResolutionError } from '../../api/types/project';
import type { ValidationIssue } from '../../api/types/validation';
import { extractLive2DModelData } from '../Live2DModelData';
import type { CharacterPerformanceParams, CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry, validateSemanticSceneStructure } from '../../services/semantic-scene';

interface AssetCacheEntry {
  exists: boolean;
  /** Structured mount resolution when the reference is an external mount. */
  resolution: ResourceResolution | null;
  checkedAt: number;
}

interface ModelCacheEntry {
  exists: boolean;
  motions: string[];
  expressions: string[];
  resolution: ResourceResolution | null;
  checkedAt: number;
}

export class ValidationDaemon {
  private documentStore: DocumentStore;
  private validationStore: ValidationStore;
  private projectResources: ProjectResourceService;
  private getBasePath: () => string;
  private resolveModelData?: (modelPath: string) => Promise<{ motions: string[]; expressions: string[] }>;

  private assetCache: Map<string, AssetCacheEntry> = new Map();
  private modelCache: Map<string, ModelCacheEntry> = new Map();
  private isRunning: boolean = false;
  private unsubscribeStore: (() => void) | null = null;
  private asyncTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastVersion: number = -1;

  constructor(
    documentStore: DocumentStore,
    validationStore: ValidationStore,
    projectResources: ProjectResourceService,
    getBasePath: () => string,
    resolveModelData?: (modelPath: string) => Promise<{ motions: string[]; expressions: string[] }>
  ) {
    this.documentStore = documentStore;
    this.validationStore = validationStore;
    this.projectResources = projectResources;
    this.getBasePath = getBasePath;
    this.resolveModelData = resolveModelData;
  }

  /** Start the validation daemon and register listeners */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Subscribe to document store changes
    this.unsubscribeStore = this.documentStore.subscribe(() => {
      this.handleDocumentChange();
    });

    // 2. Register global Window Focus listener
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleWindowFocus);
    }

    // Initial run
    this.handleDocumentChange();
  }

  /** Stop the daemon and cleanup resources */
  dispose(): void {
    this.isRunning = false;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    if (this.asyncTimeoutId) {
      clearTimeout(this.asyncTimeoutId);
      this.asyncTimeoutId = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.handleWindowFocus);
    }
    this.assetCache.clear();
    this.modelCache.clear();
  }

  /** Clear all I/O caches and model data maps */
  clearAssetCache(): void {
    this.assetCache.clear();
    this.modelCache.clear();
    console.log('[ValidationDaemon] Asset and Model caches cleared.');
  }

  /** Trigger Stage 2 validation immediately without debouncing */
  triggerAsyncValidation(): void {
    if (this.asyncTimeoutId) {
      clearTimeout(this.asyncTimeoutId);
      this.asyncTimeoutId = null;
    }
    this.runAsyncValidation();
  }

  private handleDocumentChange(): void {
    if (!this.isRunning) return;
    const semanticDocument = this.documentStore.getCurrentSceneDocumentSnapshot();
    const version = this.documentStore.version;

    if (!semanticDocument || version === this.lastVersion) return;
    this.lastVersion = version;

    // ─── Stage 1: Fast CPU Synchronous Validation ──────────────────
    // Executes in microseconds, immediately updates Store so red borders appear instantly
    this.validationStore._setSourceIssues('structure', validateSemanticSceneStructure(semanticDocument));

    // ─── Stage 2: Background I/O Async Checks (Debounced) ──────────
    // Debounce to prevent heavy disk checks during high frequency timeline dragging/typing
    if (this.asyncTimeoutId) {
      clearTimeout(this.asyncTimeoutId);
    }
    this.asyncTimeoutId = setTimeout(() => {
      this.asyncTimeoutId = null;
      void this.runSemanticAsyncValidation(semanticDocument);
    }, 400);
  }

  private handleWindowFocus = (): void => {
    if (!this.isRunning || !this.documentStore.getCurrentSceneDocumentSnapshot()) return;
    console.log('[ValidationDaemon] Window focused. Flushing caches and re-checking files...');
    this.clearAssetCache();
    this.triggerAsyncValidation();
  };

  /** Execute async asset checks; results update only the `scene-assets` slice. */
  private async runAsyncValidation(): Promise<void> {
    const semanticDocument = this.documentStore.getCurrentSceneDocumentSnapshot();
    if (!semanticDocument) return;
    await this.runSemanticAsyncValidation(semanticDocument);
  }

  private async runSemanticAsyncValidation(document: CurrentSceneDocument): Promise<void> {
    this.validationStore._setLoading(true);
    try {
      const issues: ValidationIssue[] = [];
      const assetChecks: Array<Promise<void>> = [];
      const visit = (statement: SceneStatement, sourceId = statement.id) => {
        for (const asset of sceneStatementDefinitionRegistry.collectAssetReferences(statement)) {
          assetChecks.push((async () => {
            const probe = await this.probeAsset(asset.value);
            if (probe.exists) return;
            // A whole missing library (unbound / stale root / unreadable) is
            // surfaced once per mount by the project dependency scan;
            // repeating it per statement produced dozens of generic
            // "资源不存在" rows before.
            if (probe.unreadable || isAggregateMountStatus(probe.resolution)) return;
            issues.push({
              severity: 'error',
              code: 'resource.missing',
              message: probe.resolution?.status === 'asset-missing'
                ? `外部资源库中的资源不存在: "${probe.resolution.mountId}/${probe.resolution.relativePath}"`
                : probe.resolution?.status === 'invalid-reference'
                  ? `资源引用无效: ${asset.value}`
                  : `资源不存在: ${asset.value}`,
              actionId: sourceId,
              actionType: statement.type,
              location: `scene.statements["${sourceId}"].params`,
            });
          })());
        }
      };
      for (const statement of document.statements) {
        visit(statement);
        for (const companion of statement.companions ?? []) {
          visit({ id: companion.id, time: statement.time, type: companion.type, params: companion.params } as SceneStatement, statement.id);
        }
      }
      await Promise.all(assetChecks);

      const modelDataByPath = new Map<string, Awaited<ReturnType<ValidationDaemon['getModelData']>>>();
      const loadModelData = async (modelPath: string) => {
        const cached = modelDataByPath.get(modelPath);
        if (cached) return cached;
        const modelData = await this.getModelData(modelPath);
        modelDataByPath.set(modelPath, modelData);
        return modelData;
      };

      const defaultModelByCharacter = new Map<string, string>();
      for (const character of document.meta.characters ?? []) {
        if (character.model) {
          defaultModelByCharacter.set(character.id, character.model);
          const modelData = await loadModelData(character.model);
          if (!modelData.exists && !isAggregateMountStatus(modelData.resolution)) {
            issues.push({
              severity: 'error',
              code: 'resource.missing',
              message: `角色 "${character.id}" 的 Live2D 配置文件不存在: "${character.model}"`,
            });
          }
        }
        for (const variant of character.variants ?? []) {
          const modelData = await loadModelData(variant.model);
          if (!modelData.exists && !isAggregateMountStatus(modelData.resolution)) {
            issues.push({
              severity: 'error',
              code: 'resource.missing',
              message: `角色 "${character.id}" 的变体模型不存在: "${variant.model}"`,
            });
          }
        }
      }

      const activeModelByCharacter = new Map(defaultModelByCharacter);
      const orderedStatements = [...document.statements]
        .map((statement, index) => ({ statement, index }))
        .sort((a, b) => a.statement.time - b.statement.time || a.index - b.index);
      for (const { statement } of orderedStatements) {
        if (statement.type === 'characterPresence') {
          if (statement.params.mode === 'enter') {
            activeModelByCharacter.set(
              statement.params.id,
              statement.params.model ?? defaultModelByCharacter.get(statement.params.id) ?? '',
            );
          } else {
            activeModelByCharacter.delete(statement.params.id);
          }
          continue;
        }
        if (statement.type !== 'characterPerformance') continue;

        const modelPath = activeModelByCharacter.get(statement.params.target);
        if (!modelPath) continue;
        const modelData = await loadModelData(modelPath);
        if (!modelData.exists) continue;
        appendModelKeyIssue(issues, statement, 'motion', modelData.motions);
        appendModelKeyIssue(issues, statement, 'expression', modelData.expressions);
      }
      if (this.documentStore.version === this.lastVersion) this.validationStore._setSourceIssues('scene-assets', issues);
    } catch (error) {
      console.error('[ValidationDaemon] Semantic validation failed:', error);
    } finally {
      this.validationStore._setLoading(false);
    }
  }

  private resolveValidationPath(targetPath: string): string {
    if (!targetPath) return '';
    let fullPath = targetPath;
    
    // Check if it's already an absolute path or has asset/file protocol
    const isAbsolute = fullPath.startsWith('asset://') || 
                       fullPath.startsWith('file://') || 
                       /^[a-zA-Z]:[/\\]/.test(fullPath) || 
                       fullPath.startsWith('/');

    if (!isAbsolute) {
      const basePath = this.getBasePath();
      fullPath = basePath ? `${basePath}/${targetPath}`.replace(/\\/g, '/') : targetPath;
    }

    // Strip protocols for filesystem checking
    if (fullPath.startsWith('file:///')) {
      fullPath = fullPath.substring(8);
    } else if (fullPath.startsWith('file://')) {
      fullPath = fullPath.substring(7);
    } else if (fullPath.startsWith('asset://localhost/')) {
      fullPath = fullPath.substring(18);
    } else if (fullPath.startsWith('asset://')) {
      fullPath = fullPath.substring(8);
    }

    return fullPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  /**
   * Existence probe with structured mount diagnostics: mount references go
   * through resolveStatus, plain paths keep the historical fs/HEAD check.
   * A filesystem failure marks the probe `unreadable` instead of throwing, so
   * one unreadable mount never costs the whole async validation pass.
   */
  private async probeAsset(filePath: string): Promise<{
    exists: boolean;
    resolution: ResourceResolution | null;
    unreadable?: boolean;
  }> {
    const cached = this.assetCache.get(filePath);
    if (cached && Date.now() - cached.checkedAt < 5000) {
      return cached;
    }

    let exists = false;
    let unreadable = false;
    let resolution: ResourceResolution | null = null;
    if (filePath.trim().startsWith('@mount/') && this.projectResources.getCurrentProject()) {
      try {
        resolution = await this.projectResources.resolveStatus(filePath);
        exists = resolution.status === 'ready';
      } catch (error) {
        console.error(`[ValidationDaemon] Failed to probe mounted asset "${filePath}":`, error);
        unreadable = true;
      }
    } else {
      exists = await this.checkFileOnDisk(filePath);
    }

    const entry = { exists, resolution, ...(unreadable ? { unreadable } : {}), checkedAt: Date.now() };
    this.assetCache.set(filePath, entry);
    return entry;
  }

  private async checkFileOnDisk(targetPath: string): Promise<boolean> {
    const api = (window as any).aeonStageryAPI;
    let fullPath: string;
    try {
      fullPath = await this.resolveProjectAwarePath(targetPath);
    } catch (error) {
      if (error instanceof ProjectResourceResolutionError) return false;
      throw error;
    }
    try {
      if (api?.fs?.exists) {
        return await api.fs.exists(fullPath);
      }
      const res = await fetch('/' + fullPath, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async resolveProjectAwarePath(targetPath: string): Promise<string> {
    if (!targetPath) return '';
    if (!this.projectResources.getCurrentProject()) {
      return this.resolveValidationPath(targetPath);
    }
    if (/^(https?:|asset:|file:)/i.test(targetPath) || /^[a-zA-Z]:[/\\]/.test(targetPath) || targetPath.startsWith('/')) {
      return this.resolveValidationPath(targetPath);
    }
    const resolved = await this.projectResources.resolveForRead(targetPath);
    return resolved.replace(/\\/g, '/');
  }

  private async loadJsonFile(fullPath: string): Promise<any> {
    const api = (window as any).aeonStageryAPI;
    try {
      if (api?.fs?.exists) {
        const exists = await api.fs.exists(fullPath);
        if (exists && api.fs.readTextFile) {
          const res = await api.fs.readTextFile(fullPath);
          if (res.success && res.data) {
            return JSON.parse(res.data);
          }
        }
      } else {
        const headRes = await fetch('/' + fullPath, { method: 'HEAD' });
        if (headRes.ok) {
          const textRes = await fetch('/' + fullPath);
          const jsonStr = await textRes.text();
          return JSON.parse(jsonStr);
        }
      }
    } catch (e) {
      console.warn(`[ValidationDaemon] Failed to load JSON file: ${fullPath}`, e);
    }
    return null;
  }

  private async getModelData(modelPath: string): Promise<{
    exists: boolean;
    motions: string[];
    expressions: string[];
    resolution: ResourceResolution | null;
  }> {
    const cached = this.modelCache.get(modelPath);
    if (cached && Date.now() - cached.checkedAt < 5000) {
      return cached;
    }

    try {
      const probe = await this.probeAsset(modelPath);
      const exists = probe.exists;

      if (!exists) {
        const entry = { exists: false, motions: [], expressions: [], resolution: probe.resolution, checkedAt: Date.now() };
        this.modelCache.set(modelPath, entry);
        return entry;
      }

      if (this.resolveModelData) {
        try {
          const sharedData = await this.resolveModelData(modelPath);
          const entry = {
            exists: true,
            motions: sharedData.motions || [],
            expressions: sharedData.expressions || [],
            resolution: probe.resolution,
            checkedAt: Date.now()
          };
          this.modelCache.set(modelPath, entry);
          return entry;
        } catch (err) {
          console.warn(`[ValidationDaemon] Shared model-data resolver failed for "${modelPath}", falling back to direct JSON parsing.`, err);
        }
      }

      const fullPath = await this.resolveProjectAwarePath(modelPath);
      const parsedData = await this.readModelDataFromJson(fullPath);
      const entry = { exists: true, motions: parsedData.motions, expressions: parsedData.expressions, resolution: probe.resolution, checkedAt: Date.now() };
      this.modelCache.set(modelPath, entry);
      return entry;
    } catch (err) {
      const entry = { exists: false, motions: [], expressions: [], resolution: null as ResourceResolution | null, checkedAt: Date.now() };
      this.modelCache.set(modelPath, entry);
      return entry;
    }
  }

  private async readModelDataFromJson(fullPath: string): Promise<{ motions: string[]; expressions: string[] }> {
    const api = (window as any).aeonStageryAPI;
    let jsonStr = '';

    if (api?.fs?.readTextFile) {
      const res = await api.fs.readTextFile(fullPath);
      if (res.success && res.data) {
        jsonStr = res.data;
      }
    } else {
      const textRes = await fetch('/' + fullPath);
      jsonStr = await textRes.text();
    }

    if (!jsonStr) {
      return { motions: [], expressions: [] };
    }

    const json = JSON.parse(jsonStr);
    const motionsSet = new Set<string>();
    const expressionsSet = new Set<string>();

    if (json.modelRelativePath && !json.motions && !json.FileReferences) {
      const lastSlash = fullPath.lastIndexOf('/');
      const wmdlDir = lastSlash !== -1 ? fullPath.substring(0, lastSlash) : '';
      const resolveWmdlPath = (relPath: string) => {
        return wmdlDir ? `${wmdlDir}/${relPath}`.replace(/\/+/g, '/') : relPath;
      };

      const pathsToLoad: string[] = [resolveWmdlPath(json.modelRelativePath)];
      if (json.subModels && Array.isArray(json.subModels)) {
        for (const sub of json.subModels) {
          if (sub.modelRelativePath) {
            pathsToLoad.push(resolveWmdlPath(sub.modelRelativePath));
          }
        }
      }

      const loadResults = await Promise.all(pathsToLoad.map((p) => this.loadJsonFile(p)));
      for (const subJson of loadResults) {
        if (!subJson) continue;
        const { motions: subMotions, expressions: subExpressions } = extractMotionsAndExpressions(subJson);
        for (const m of subMotions) motionsSet.add(m);
        for (const e of subExpressions) expressionsSet.add(e);
      }
    } else {
      const { motions, expressions } = extractMotionsAndExpressions(json);
      for (const m of motions) motionsSet.add(m);
      for (const e of expressions) expressionsSet.add(e);
    }

    return {
      motions: Array.from(motionsSet),
      expressions: Array.from(expressionsSet)
    };
  }
}

function isAggregateMountStatus(resolution: ResourceResolution | null): boolean {
  return resolution?.status === 'mount-unbound' || resolution?.status === 'mount-root-missing';
}

function extractMotionsAndExpressions(json: any): { motions: string[], expressions: string[] } {
  const { motions, expressions } = extractLive2DModelData(json);
  return { motions, expressions };
}

function appendModelKeyIssue(
  issues: Array<{ severity: 'error' | 'warning'; message: string; actionId?: string; actionType?: string }>,
  statement: Extract<SceneStatement, { type: 'characterPerformance' }>,
  key: 'motion' | 'expression',
  available: readonly string[],
): void {
  const requested = key === 'motion'
    ? motionKeyOf(statement.params.motion)
    : statement.params.expression;
  if (!requested || available.length === 0 || available.includes(requested)) return;

  const caseInsensitiveMatch = available.find((value) => value.toLowerCase() === requested.toLowerCase());
  const label = key === 'motion' ? '动作' : '表情';
  issues.push({
    severity: 'error',
    message: caseInsensitiveMatch
      ? `Live2D 模型中的${label} "${caseInsensitiveMatch}" 存在，但${label}名 "${requested}" 大小写不匹配`
      : `Live2D 模型的可用${label}列表中未找到${label}名 "${requested}"`,
    actionId: statement.id,
    actionType: statement.type,
  });
}

function motionKeyOf(motion: CharacterPerformanceParams['motion']): string | undefined {
  if (!motion || typeof motion !== 'object') return undefined;
  return motion.kind === 'resource' ? motion.key : motion.derivedFrom.key;
}
