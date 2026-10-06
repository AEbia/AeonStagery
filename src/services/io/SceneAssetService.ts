import type { SceneAudio, SceneMeta } from '../../api/types/scene-common';
import type {
  CompiledAction,
  PreparedAssetRef,
  PreparedCompiledScene,
  PreparedRuntimeValue,
  CurrentSceneDocument,
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
  SceneStatement,
} from '../../api/types/semantic-scene';
import type { ResourceImportKind } from '../../api/types/project';
import { DEFAULT_PROJECT_ASSET_ROOTS } from '../../api/types/project';
import type { ProjectRelativeAssetPath } from '../../api/types/collaboration';
import { WmdlConfigRegistry } from '../../engine/WmdlConfigRegistry';
import { ProjectResourceService } from './ProjectResourceService';
import { ProjectPathResolver } from './ProjectPathResolver';
import type { IFileAccess } from './IFileAccess';
import {
  browserCollaborativeAssetHashAdapter,
  collectLive2DAssetBundleClosure,
  hashCollaborativeAssetBundle,
  isLive2DAssetBundleEntrypoint,
} from '../collaboration/assets';
import { sceneStatementDefinitionRegistry } from '../semantic-scene/SceneStatementDefinitionRegistry';

interface AssetRefTarget {
  kind: ResourceImportKind;
  get: () => string | undefined;
  set: (value: string) => void;
}

interface RuntimeModelConfigRef {
  readPath: string;
  registerKeys: readonly string[];
}

interface CollaborativeProjectizationContext {
  references: Map<string, Promise<string>>;
  targetHashes: Map<string, string>;
}

type CollaborativeTargetState = 'missing' | 'matching' | 'conflict';

export interface AssetReferenceTimelineAction {
  readonly _id?: string;
  readonly time?: number;
  readonly action: string;
  readonly params: Record<string, any>;
}

export interface AssetReferenceScene {
  readonly sceneId?: string;
  readonly meta: SceneMeta;
  readonly audio?: SceneAudio;
  readonly timeline: readonly AssetReferenceTimelineAction[];
}

function normalizePortablePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\/+/, '');
}

function joinPortable(baseDir: string, childPath: string): string {
  const child = normalizePortablePath(childPath);
  if (!baseDir) return child;
  if (!child) return normalizePortablePath(baseDir);
  const parts = [...baseDir.split('/'), ...child.split('/')];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
}

function appendHashToFileName(relativePath: string, hashPrefix: string): string {
  const normalized = normalizePortablePath(relativePath);
  const slashIndex = normalized.lastIndexOf('/');
  const directory = slashIndex < 0 ? '' : normalized.slice(0, slashIndex + 1);
  const fileName = normalized.slice(slashIndex + 1);
  const extensionIndex = fileName.lastIndexOf('.');
  const hasExtension = extensionIndex > 0;
  const stem = hasExtension ? fileName.slice(0, extensionIndex) : fileName;
  const extension = hasExtension ? fileName.slice(extensionIndex) : '';
  return `${directory}${stem}__${hashPrefix}${extension}`;
}

function normalizeAbsoluteSourcePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const drivePrefix = normalized.match(/^[A-Za-z]:/)?.[0] ?? '';
  const isRooted = normalized.startsWith('/') || !!drivePrefix;
  const remainder = drivePrefix ? normalized.slice(drivePrefix.length) : normalized;
  const segments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!isRooted) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  const prefix = drivePrefix ? `${drivePrefix}/` : (normalized.startsWith('/') ? '/' : '');
  return `${prefix}${segments.join('/')}`.replace(/\/$/, '') || prefix || '.';
}

function commonSourceDirectory(sourcePaths: string[]): string {
  const parentSegments = sourcePaths.map((sourcePath) => {
    const normalized = normalizeAbsoluteSourcePath(sourcePath);
    return normalized.split('/').slice(0, -1);
  });
  if (parentSegments.length === 0) return '';
  const common: string[] = [];
  for (let index = 0; ; index += 1) {
    const segment = parentSegments[0][index];
    if (segment === undefined || parentSegments.some((segments) =>
      segments[index] === undefined || segments[index].toLowerCase() !== segment.toLowerCase())) break;
    common.push(segment);
  }
  return common.join('/');
}

function relativeSourcePath(sourceRoot: string, sourcePath: string): string {
  const rootSegments = sourceRoot.split('/').filter(Boolean);
  const sourceSegments = normalizeAbsoluteSourcePath(sourcePath).split('/').filter(Boolean);
  const matchesRoot = rootSegments.every((segment, index) =>
    sourceSegments[index]?.toLowerCase() === segment.toLowerCase());
  if (!matchesRoot || sourceSegments.length <= rootSegments.length) {
    throw new Error(`Live2D bundle source escaped its common root: "${sourcePath}"`);
  }
  return sourceSegments.slice(rootSegments.length).join('/');
}

function bundleDirectoryName(entrypointRelativePath: string, hashPrefix: string): string {
  const fileName = normalizePortablePath(entrypointRelativePath).split('/').pop() ?? 'bundle';
  const dotIndex = fileName.lastIndexOf('.');
  const stem = (dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bundle';
  return `${stem}__${hashPrefix}`;
}

function setNestedRecordValue(
  record: Record<string, unknown>,
  dotPath: string,
  value: string,
): void {
  const parts = dotPath.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Expected semantic asset reference path');
  }
  let target: Record<string, unknown> = record;
  for (const part of parts.slice(0, -1)) {
    const nested = target[part];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new Error(`Cannot set nested semantic asset reference path "${dotPath}"`);
    }
    target = nested as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
}

export interface SceneAssetHooks {
  importAssetPath(sourcePath: string, kind: ResourceImportKind, mode?: 'copy' | 'mount'): Promise<string>;
  importTemplateAssetPath(sourcePath: string, trustedRoot: string, kind: ResourceImportKind): Promise<string>;
  normalizeForLoad<T extends AssetReferenceScene>(scene: T): Promise<T>;
  prepareCollaborativeAssetReferences<T extends AssetReferenceScene>(scene: T): Promise<T>;
  prepareCollaborativeV2SceneDocumentAssetReferences(scene: HistoricalSceneDocumentV4): Promise<HistoricalSceneDocumentV4>;
  prepareCollaborativeV5SceneDocumentAssetReferences(scene: SceneDocumentV5): Promise<SceneDocumentV5>;
  prepareForSave<T extends AssetReferenceScene>(scene: T, savePath?: string): Promise<T>;
  hydrateRuntimeConfigs(scene: AssetReferenceScene): Promise<void>;
  hydratePreparedRuntimeConfigs(scene: PreparedCompiledScene): Promise<void>;
  resolveSemanticRuntimeAsset?(source: string, context: { action: CompiledAction; paramPath: string }): Promise<string>;
  normalizeSemanticSource?(scene: CurrentSceneDocument): Promise<CurrentSceneDocument>;
}

export class SceneAssetService implements SceneAssetHooks {
  private pathResolver: ProjectPathResolver;
  /** Avoid recopying shared motions/textures while importing many variants from one template. */
  private readonly copiedLive2DBundleTargets = new Set<string>();

  constructor(
    private fileAccess: IFileAccess,
    private wmdlConfigRegistry: WmdlConfigRegistry,
    private projectResources: ProjectResourceService,
    private getBasePath: () => string,
    private readonly onResourceChanged: () => void = () => {},
  ) {
    this.pathResolver = new ProjectPathResolver(typeof window !== 'undefined' ? (window as any).aeonStageryAPI : null);
  }

  async importAssetPath(sourcePath: string, kind: ResourceImportKind, mode: 'copy' | 'mount' = 'mount'): Promise<string> {
    const normalized = this.pathResolver.isAbsolutePath(sourcePath) && mode === 'copy'
      ? await this.projectResources.importIntoProject(sourcePath, kind, 'copy')
      : await this.projectResources.normalizeForStorage(sourcePath, kind);
    if (kind === 'figure' && normalized.mode === 'copy' && this.pathResolver.isAbsolutePath(sourcePath)) {
      const sourceIsInsideProject = await this.projectResources.classifySource(sourcePath) === 'insideProject';
      if (!sourceIsInsideProject) {
        await this.copyLive2DBundleDependencies(sourcePath, normalized.relativePath);
      }
    }
    this.onResourceChanged();
    return normalized.relativePath;
  }

  async importTemplateAssetPath(
    sourcePath: string,
    trustedRoot: string,
    kind: ResourceImportKind,
  ): Promise<string> {
    const relative = await this.pathResolver.relativeFromProject(trustedRoot, sourcePath);
    if (!relative) {
      throw new Error(`Trusted resource source escapes its declared root: "${sourcePath}"`);
    }
    const packageName = (await this.fileAccess.basename(trustedRoot))
      .replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'template';
    const project = this.projectResources.getCurrentProject();
    if (!project) throw new Error('No active project');
    const assetRoot = (project.metadata.assetRoots as unknown as Record<string, string>)[kind] ?? kind;
    const imported = await this.projectResources.materializeFromTrustedRoot(
      trustedRoot,
      sourcePath,
      kind,
      `${assetRoot}/templates/${packageName}/${relative}`,
    );
    if (kind === 'figure') {
      await this.copyLive2DBundleDependencies(sourcePath, imported.relativePath);
    }
    this.onResourceChanged();
    return imported.relativePath;
  }

  async normalizeSemanticSource(scene: CurrentSceneDocument): Promise<CurrentSceneDocument> {
    if (!this.projectResources.getCurrentProject()) return scene;
    const cloned = JSON.parse(JSON.stringify(scene)) as CurrentSceneDocument;
    for (const character of cloned.meta.characters ?? []) {
      if (character.model) {
        character.model = await this.normalizeSemanticAssetReferenceOrKeep(character.model, 'figure');
      }
      for (const variant of character.variants ?? []) {
        variant.model = await this.normalizeSemanticAssetReferenceOrKeep(variant.model, 'figure');
      }
    }
    return cloned;
  }

  async normalizeForLoad<T extends AssetReferenceScene>(scene: T): Promise<T> {
    const project = this.projectResources.getCurrentProject();
    if (!project) return scene;

    const cloned = JSON.parse(JSON.stringify(scene)) as T;
    const refs = this.collectAssetRefs(cloned);

    for (const ref of refs) {
      const currentValue = ref.get();
      if (!currentValue) continue;

      if (this.pathResolver.isUrlLike(currentValue)) {
        throw new Error(`URL-style asset references are not portable: "${currentValue}"`);
      }
      ref.set((await this.projectResources.normalizeForStorage(currentValue, ref.kind)).relativePath);
    }

    return cloned;
  }

  async prepareCollaborativeAssetReferences<T extends AssetReferenceScene>(scene: T): Promise<T> {
    const project = this.projectResources.getCurrentProject();
    if (!project) return scene;

    const cloned = JSON.parse(JSON.stringify(scene)) as T;
    const projectized: CollaborativeProjectizationContext = {
      references: new Map<string, Promise<string>>(),
      targetHashes: new Map<string, string>(),
    };
    for (const ref of this.collectAssetRefs(cloned)) {
      const currentValue = ref.get();
      if (!currentValue) continue;
      if (this.pathResolver.isUrlLike(currentValue)) {
        throw new Error(`URL-style collaborative asset references are not portable: "${currentValue}"`);
      }
      ref.set(await this.projectizeCollaborativeReference(currentValue, ref.kind, projectized));
    }

    return cloned;
  }

  async prepareCollaborativeV2SceneDocumentAssetReferences(scene: HistoricalSceneDocumentV4): Promise<HistoricalSceneDocumentV4> {
    if (!this.projectResources.getCurrentProject()) return scene;
    const cloned = JSON.parse(JSON.stringify(scene)) as HistoricalSceneDocumentV4;
    await this.projectizeSemanticDocumentAssetReferences(cloned);
    return cloned;
  }

  /**
   * Projectizes `@mount/<id>/...` references in the current V5 semantic
   * document before collaboration manifest building (ADR-0021). Without this
   * step, mounted references flow into the asset manifest and the readiness
   * gate fails on `resolveForProjectWrite`, which rejects mount paths.
   */
  async prepareCollaborativeV5SceneDocumentAssetReferences(scene: SceneDocumentV5): Promise<SceneDocumentV5> {
    if (!this.projectResources.getCurrentProject()) return scene;
    const cloned = JSON.parse(JSON.stringify(scene)) as SceneDocumentV5;
    await this.projectizeSemanticDocumentAssetReferences(cloned);
    return cloned;
  }

  private async projectizeSemanticDocumentAssetReferences(
    cloned: { meta: SceneMeta; statements: SceneStatement[] },
  ): Promise<void> {
    const projectized: CollaborativeProjectizationContext = {
      references: new Map<string, Promise<string>>(),
      targetHashes: new Map<string, string>(),
    };
    for (const character of cloned.meta.characters ?? []) {
      if (character.model) {
        character.model = await this.projectizeCollaborativeReference(character.model, 'figure', projectized);
      }
      for (const variant of character.variants ?? []) {
        variant.model = await this.projectizeCollaborativeReference(variant.model, 'figure', projectized);
      }
    }

    for (const statement of cloned.statements) {
      await this.projectizeSemanticStatementAssetReferences(statement, projectized);
      for (const companion of statement.companions ?? []) {
        await this.projectizeSemanticStatementAssetReferences(companion, projectized);
      }
    }
  }

  async prepareForSave<T extends AssetReferenceScene>(scene: T, savePath?: string): Promise<T> {
    const project = this.projectResources.getCurrentProject();
    if (project && savePath) {
      const relative = await this.pathResolver.relativeFromProject(project.rootPath, savePath);
      if (!relative) {
        throw new Error('Scene files must be saved inside the active project folder');
      }
    }

    for (const ref of this.collectAssetRefs(scene)) {
      const value = ref.get();
      if (!value) continue;
      if (this.pathResolver.isUrlLike(value)) {
        throw new Error(`Scene contains a non-portable asset path: "${value}"`);
      }
      if (project) {
        ref.set((await this.projectResources.normalizeForStorage(value, ref.kind)).relativePath);
      } else {
        if (this.pathResolver.isAbsolutePath(value)) {
          throw new Error(`Scene contains an absolute asset path without an active project: "${value}"`);
        }
        ref.set(this.pathResolver.normalizeRelativePath(value));
      }
    }

    return scene;
  }

  async hydrateRuntimeConfigs(scene: AssetReferenceScene): Promise<void> {
    await this.hydrateRuntimeModelConfigs(this.collectTimelineWmdlModelRefs(scene));
  }

  async hydratePreparedRuntimeConfigs(scene: PreparedCompiledScene): Promise<void> {
    await this.hydrateRuntimeModelConfigs(this.collectPreparedWmdlModelRefs(scene));
  }

  private async hydrateRuntimeModelConfigs(modelRefs: readonly RuntimeModelConfigRef[]): Promise<void> {
    this.wmdlConfigRegistry.clear();

    const refsByReadPath = new Map<string, Set<string>>();
    for (const ref of modelRefs) {
      if (!isWmdlPath(ref.readPath) && !ref.registerKeys.some(isWmdlPath)) continue;
      const keys = refsByReadPath.get(ref.readPath) ?? new Set<string>();
      keys.add(ref.readPath);
      for (const key of ref.registerKeys) {
        if (key) keys.add(key);
      }
      refsByReadPath.set(ref.readPath, keys);
    }

    if (refsByReadPath.size === 0) return;

    const promises = Array.from(refsByReadPath.entries()).map(async ([modelPath, registerKeys]) => {
      try {
        const absolutePath = await this.resolveScenePathForRead(modelPath);
        const { data } = await this.fileAccess.readFile(absolutePath);
        const wmdlData = JSON.parse(data);

        const wmdlDir = await this.fileAccess.dirname(absolutePath);
        const resolveWmdlLocalPath = async (relativePath: string) => {
          if (!relativePath) return relativePath;
          const joined = await this.fileAccess.join(wmdlDir, relativePath);
          return joined.replace(/\\/g, '/');
        };

        const resolvedConfig = {
          ...wmdlData,
          modelRelativePath: await resolveWmdlLocalPath(wmdlData.modelRelativePath),
          subModels: await Promise.all((wmdlData.subModels || []).map(async (sub: any) => ({
            ...sub,
            modelRelativePath: await resolveWmdlLocalPath(sub.modelRelativePath),
          }))),
        };

        for (const key of registerKeys) {
          this.wmdlConfigRegistry.register(key, resolvedConfig);
        }
      } catch (err) {
        console.error(`[SceneAssetService] Failed to load .wmdl config at ${modelPath}:`, err);
      }
    });

    await Promise.all(promises);
  }

  private collectTimelineWmdlModelRefs(scene: AssetReferenceScene): RuntimeModelConfigRef[] {
    const refs: RuntimeModelConfigRef[] = [];
    for (const action of scene.timeline) {
      if (action.action === 'addCharacter') {
        pushRuntimeModelConfigRef(refs, action.params?.model);
      }
    }

    for (const char of scene.meta?.characters || []) {
      pushRuntimeModelConfigRef(refs, char.model);
      for (const variant of char.variants || []) {
        pushRuntimeModelConfigRef(refs, variant.model);
      }
    }
    return refs;
  }

  private collectPreparedWmdlModelRefs(scene: PreparedCompiledScene): RuntimeModelConfigRef[] {
    const refs: RuntimeModelConfigRef[] = [];
    for (const action of scene.actions) {
      if (action.action === 'addCharacter') {
        pushRuntimeModelConfigRef(refs, action.params.model);
      }
    }

    for (const char of scene.meta?.characters || []) {
      pushRuntimeModelConfigRef(refs, char.model);
      for (const variant of char.variants || []) {
        pushRuntimeModelConfigRef(refs, variant.model);
      }
    }
    return refs;
  }

  async resolveSemanticRuntimeAsset(
    source: string,
    _context: { action: CompiledAction; paramPath: string },
  ): Promise<string> {
    const candidate = source.trim();
    if (!candidate) return source;
    // Failures propagate on purpose: RuntimeAssetPreparer turns them into an
    // explicit unavailable value, while returning the raw @mount reference
    // here would leak it into synchronous runtime path resolution.
    if (
      this.projectResources.getCurrentProject()
      && !this.pathResolver.isAbsolutePath(candidate)
      && !this.pathResolver.isUrlLike(candidate)
    ) {
      return this.projectResources.resolveForRuntime(candidate);
    }
    return this.resolveScenePathForRead(candidate);
  }

  private async normalizeSemanticAssetReferenceOrKeep(
    value: string,
    kind: ResourceImportKind,
  ): Promise<string> {
    try {
      return (await this.projectResources.normalizeForStorage(value, kind)).relativePath;
    } catch {
      return value;
    }
  }

  private collectAssetRefs(scene: AssetReferenceScene): AssetRefTarget[] {
    const refs: AssetRefTarget[] = [];

    if (scene.audio?.bgm?.file) {
      refs.push({
        kind: 'bgm',
        get: () => scene.audio?.bgm?.file,
        set: (value) => { if (scene.audio?.bgm) scene.audio.bgm.file = value; },
      });
    }

    for (const char of scene.meta?.characters || []) {
      refs.push({
        kind: 'figure',
        get: () => char.model,
        set: (value) => { char.model = value; },
      });
      for (const variant of char.variants || []) {
        refs.push({
          kind: 'figure',
          get: () => variant.model,
          set: (value) => { variant.model = value; },
        });
      }
    }

    for (const action of scene.timeline) {
      if (action.action === 'addCharacter') {
        refs.push({
          kind: 'figure',
          get: () => action.params?.model,
          set: (value) => { action.params.model = value; },
        });
      }
      if (action.action === 'setBackground' || action.action === 'setEnvironmentLayer') {
        refs.push({
          kind: 'background',
          get: () => action.params?.image,
          set: (value) => { action.params.image = value; },
        });
      }
      if (action.action === 'playAudio' || action.action === 'setBGM') {
        refs.push({
          kind: 'bgm',
          get: () => action.params?.file ?? action.params?.url,
          set: (value) => {
            if (action.params.file !== undefined) action.params.file = value;
            else action.params.url = value;
          },
        });
      }
      if (action.action === 'dialogue') {
        refs.push({
          kind: 'vocal',
          get: () => action.params?.voice,
          set: (value) => { action.params.voice = value; },
        });
      }
      if (action.action === 'addImage') {
        refs.push({
          kind: 'images',
          get: () => action.params?.file,
          set: (value) => { action.params.file = value; },
        });
      }
      if (action.action === 'playCustomAnimation') {
        refs.push({
          kind: 'animation',
          get: () => action.params?.file,
          set: (value) => { action.params.file = value; },
        });
      }
    }

    return refs.filter((ref) => !!ref.get());
  }

  private async projectizeSemanticStatementAssetReferences(
    statement: Pick<SceneStatement, 'type' | 'params'>,
    projectized: CollaborativeProjectizationContext,
  ): Promise<void> {
    for (const field of sceneStatementDefinitionRegistry.collectAssetReferences(statement as unknown as SceneStatement)) {
      const key = field.path.replace(/^params\./, '');
      const nextValue = await this.projectizeCollaborativeReference(
        field.value,
        field.kind,
        projectized,
      );
      setNestedRecordValue(statement.params as unknown as Record<string, unknown>, key, nextValue);
    }
  }

  private projectizeCollaborativeReference(
    value: string,
    kind: ResourceImportKind,
    projectized: CollaborativeProjectizationContext,
  ): Promise<string> {
    const cacheKey = `${kind}:${value.replace(/\\/g, '/')}`;
    const existing = projectized.references.get(cacheKey);
    if (existing) return existing;

    const result = (async () => {
      const normalized = await this.projectResources.normalizeForStorage(value, kind);
      const collaborativeReference = this.projectResources.toCollaborationReference(normalized.relativePath, kind);
      const readPath = await this.projectResources.resolveForRead(normalized.relativePath);
      if (await this.projectResources.classifySource(readPath) === 'insideProject') {
        return collaborativeReference;
      }

      if (kind === 'figure' && this.pathResolver.isAbsolutePath(readPath)
        && isLive2DAssetBundleEntrypoint(readPath)) {
        return this.projectizeCollaborativeLive2DBundle(
          readPath,
          collaborativeReference,
          kind,
          projectized.targetHashes,
        );
      }

      const sourceBytes = await this.readAssetBytes(readPath);
      const sourceHash = await browserCollaborativeAssetHashAdapter.sha256(sourceBytes);
      return this.projectizeCollaborativeSingleFile(
        readPath,
        collaborativeReference,
        sourceHash,
        projectized.targetHashes,
      );
    })();
    projectized.references.set(cacheKey, result);
    return result;
  }

  private async projectizeCollaborativeSingleFile(
    sourcePath: string,
    preferredRelativePath: string,
    sourceHash: string,
    stagedHashes: Map<string, string>,
  ): Promise<string> {
    const hashHex = sourceHash.slice('sha256:'.length);
    for (const hashLength of [0, 12, 20, 32, 64]) {
      const targetRelativePath = hashLength === 0
        ? preferredRelativePath
        : appendHashToFileName(preferredRelativePath, hashHex.slice(0, hashLength));
      const state = await this.collaborativeTargetState(targetRelativePath, sourceHash, stagedHashes);
      if (state === 'conflict') continue;
      if (state === 'missing') await this.copyCollaborativeFile(sourcePath, targetRelativePath);
      stagedHashes.set(this.collaborativeTargetKey(targetRelativePath), sourceHash);
      return targetRelativePath;
    }
    throw new Error(`Could not choose a unique project path for collaborative asset "${preferredRelativePath}"`);
  }

  private async projectizeCollaborativeLive2DBundle(
    sourceEntrypointPath: string,
    preferredEntrypointPath: string,
    kind: ResourceImportKind,
    stagedHashes: Map<string, string>,
  ): Promise<string> {
    const entries = await this.collectLive2DBundleEntries(sourceEntrypointPath, preferredEntrypointPath);
    const sourceFiles = await Promise.all(entries.map(async (entry) => ({
      entry,
      bytes: await this.readAssetBytes(entry.sourcePath),
    })));
    const bundleHash = await hashCollaborativeAssetBundle(sourceFiles.map(({ entry, bytes }) => ({
      relativePath: entry.projectRelativePath,
      bytes,
    })), browserCollaborativeAssetHashAdapter);
    const fileHashes = await Promise.all(sourceFiles.map(({ bytes }) =>
      browserCollaborativeAssetHashAdapter.sha256(bytes)));
    const directFiles = entries.map((entry, index) => ({
      sourcePath: entry.sourcePath,
      relativePath: entry.projectRelativePath,
      contentHash: fileHashes[index],
    }));

    if (await this.tryMaterializeCollaborativeFiles(directFiles, stagedHashes)) {
      return directFiles[0].relativePath;
    }

    const sourceRoot = commonSourceDirectory(entries.map((entry) => entry.sourcePath));
    const assetRoot = this.collaborativeAssetRoot(kind);
    const sourceRelativePaths = entries.map((entry) => relativeSourcePath(sourceRoot, entry.sourcePath));
    for (const hashLength of [12, 20, 32, 64]) {
      const directory = `${assetRoot}/${bundleDirectoryName(preferredEntrypointPath, bundleHash.slice('sha256:'.length, 'sha256:'.length + hashLength))}`;
      const relocatedFiles = entries.map((entry, index) => ({
        sourcePath: entry.sourcePath,
        relativePath: `${directory}/${sourceRelativePaths[index]}`,
        contentHash: fileHashes[index],
      }));
      if (await this.tryMaterializeCollaborativeFiles(relocatedFiles, stagedHashes)) {
        return relocatedFiles[0].relativePath;
      }
    }
    throw new Error(`Could not choose a unique project directory for Live2D bundle "${preferredEntrypointPath}"`);
  }

  private async tryMaterializeCollaborativeFiles(
    files: Array<{ sourcePath: string; relativePath: string; contentHash: string }>,
    stagedHashes: Map<string, string>,
  ): Promise<boolean> {
    const states = await Promise.all(files.map((file) =>
      this.collaborativeTargetState(file.relativePath, file.contentHash, stagedHashes)));
    if (states.some((state) => state === 'conflict')) return false;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (states[index] === 'missing') {
        await this.copyCollaborativeFile(file.sourcePath, file.relativePath);
      }
      stagedHashes.set(this.collaborativeTargetKey(file.relativePath), file.contentHash);
    }
    return true;
  }

  private async collaborativeTargetState(
    relativePath: string,
    sourceHash: string,
    stagedHashes: Map<string, string>,
  ): Promise<CollaborativeTargetState> {
    const key = this.collaborativeTargetKey(relativePath);
    const stagedHash = stagedHashes.get(key);
    if (stagedHash) return stagedHash === sourceHash ? 'matching' : 'conflict';

    const targetPath = await this.projectResources.resolveForProjectWrite(relativePath);
    if (this.fileAccess.stat) {
      const stat = await this.fileAccess.stat(targetPath);
      if (!stat) return 'missing';
      if (!stat.isFile || stat.isSymbolicLink) return 'conflict';
    } else if (!(await this.fileAccess.exists(targetPath))) {
      return 'missing';
    }

    const existingBytes = await this.readAssetBytes(targetPath, true);
    if (!existingBytes) return 'conflict';
    const existingHash = await browserCollaborativeAssetHashAdapter.sha256(existingBytes);
    if (existingHash !== sourceHash) return 'conflict';
    this.projectResources.invalidateReadResolution(relativePath);
    return 'matching';
  }

  private async readAssetBytes(path: string): Promise<Uint8Array>;
  private async readAssetBytes(path: string, allowUnreadable: true): Promise<Uint8Array | null>;
  private async readAssetBytes(path: string, allowUnreadable = false): Promise<Uint8Array | null> {
    if (this.fileAccess.readBinaryFile) {
      try {
        const result = await this.fileAccess.readBinaryFile(path);
        if (result?.data !== undefined) return new Uint8Array(result.data);
      } catch {
        // Fall through to the text reader, which also supports simple test and
        // browser adapters that expose binary reads as an optional port.
      }
    }
    try {
      const result = await this.fileAccess.readFile(path);
      if (typeof result?.data === 'string') return new TextEncoder().encode(result.data);
    } catch {
      if (!allowUnreadable) throw new Error(`Could not read collaborative asset bytes from "${path}"`);
    }
    if (allowUnreadable) return null;
    throw new Error(`Could not read collaborative asset bytes from "${path}"`);
  }

  private async copyCollaborativeFile(sourcePath: string, targetRelativePath: string): Promise<void> {
    const targetPath = await this.projectResources.resolveForProjectWrite(targetRelativePath);
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetPath));
    await this.fileAccess.copyFile(sourcePath, targetPath);
    this.projectResources.invalidateReadResolution(targetRelativePath);
  }

  private collaborativeTargetKey(relativePath: string): string {
    return normalizePortablePath(relativePath).toLowerCase();
  }

  private collaborativeAssetRoot(kind: ResourceImportKind): string {
    const project = this.projectResources.getCurrentProject();
    const configuredRoots = (project?.metadata.assetRoots ?? {}) as Record<string, string>;
    const defaultRoots = DEFAULT_PROJECT_ASSET_ROOTS as unknown as Record<string, string>;
    return normalizePortablePath(configuredRoots[kind] ?? defaultRoots[kind] ?? kind);
  }

  private async collectLive2DBundleEntries(
    sourceEntrypointPath: string,
    projectEntrypointRelativePath: string,
  ): Promise<Array<{ sourcePath: string; projectRelativePath: ProjectRelativeAssetPath }>> {
    return collectLive2DAssetBundleClosure({
      sourcePath: sourceEntrypointPath.replace(/\\/g, '/'),
      projectRelativePath: normalizePortablePath(projectEntrypointRelativePath) as ProjectRelativeAssetPath,
    }, {
      readText: async (sourcePath) => {
        const { data } = await this.fileAccess.readFile(sourcePath);
        return data;
      },
      dirname: (sourcePath) => this.fileAccess.dirname(sourcePath),
      joinSource: async (baseDir, childPath) => (await this.fileAccess.join(baseDir, childPath)).replace(/\\/g, '/'),
      joinProjectRelative: (baseDir, childPath) => joinPortable(baseDir, childPath) as ProjectRelativeAssetPath,
      normalizeSourcePath: (sourcePath) => sourcePath.replace(/\\/g, '/').toLowerCase(),
      validateReference: (ref) => {
        if (this.pathResolver.isUrlLike(ref) || this.pathResolver.isAbsolutePath(ref)) {
          throw new Error(`Live2D bundle references must be relative for project import: "${ref}"`);
        }
      },
    });
  }

  private async copyLive2DBundleDependencies(
    sourceEntrypointPath: string,
    projectEntrypointRelativePath: string,
  ): Promise<void> {
    if (!isLive2DAssetBundleEntrypoint(sourceEntrypointPath)) return;

    const entries = await collectLive2DAssetBundleClosure({
      sourcePath: sourceEntrypointPath.replace(/\\/g, '/'),
      projectRelativePath: normalizePortablePath(projectEntrypointRelativePath) as ProjectRelativeAssetPath,
    }, {
      readText: async (sourcePath) => {
        const { data } = await this.fileAccess.readFile(sourcePath);
        return data;
      },
      dirname: (sourcePath) => this.fileAccess.dirname(sourcePath),
      joinSource: async (baseDir, childPath) => (await this.fileAccess.join(baseDir, childPath)).replace(/\\/g, '/'),
      joinProjectRelative: (baseDir, childPath) => joinPortable(baseDir, childPath) as ProjectRelativeAssetPath,
      normalizeSourcePath: (sourcePath) => sourcePath.replace(/\\/g, '/').toLowerCase(),
      validateReference: (ref) => {
        if (this.pathResolver.isUrlLike(ref) || this.pathResolver.isAbsolutePath(ref)) {
          throw new Error(`Live2D bundle references must be relative for project import: "${ref}"`);
        }
      },
    });

    for (const entry of entries.slice(1)) {
      const targetChildPath = await this.projectResources.resolveForProjectWrite(entry.projectRelativePath);
      const targetKey = targetChildPath.replace(/\\/g, '/').toLowerCase();
      if (this.copiedLive2DBundleTargets.has(targetKey)) continue;
      await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetChildPath));
      await this.fileAccess.copyFile(entry.sourcePath, targetChildPath);
      this.copiedLive2DBundleTargets.add(targetKey);
    }
  }

  private async resolveScenePathForRead(assetPath: string): Promise<string> {
    if (!assetPath) return assetPath;
    if (!this.pathResolver.isAbsolutePath(assetPath) && !this.pathResolver.isUrlLike(assetPath)) {
      const project = this.projectResources.getCurrentProject();
      if (project) {
        return this.projectResources.resolveForRead(assetPath);
      }
      const basePath = this.getBasePath();
      return basePath ? this.fileAccess.join(basePath, assetPath) : assetPath;
    }
    if (assetPath.startsWith('file:///')) {
      return assetPath.slice(8);
    }
    if (assetPath.startsWith('asset://localhost/')) {
      return decodeURIComponent(assetPath.slice(18));
    }
    return assetPath;
  }
}

function pushRuntimeModelConfigRef(refs: RuntimeModelConfigRef[], value: PreparedRuntimeValue | string | undefined): void {
  const ref = toRuntimeModelConfigRef(value);
  if (ref) refs.push(ref);
}

function toRuntimeModelConfigRef(value: PreparedRuntimeValue | string | undefined): RuntimeModelConfigRef | null {
  if (typeof value === 'string') {
    return {
      readPath: value,
      registerKeys: [value],
    };
  }
  if (isPreparedAssetRefValue(value)) {
    if (value.unavailable) return null;
    return {
      readPath: value.source || value.runtimeUri,
      registerKeys: [value.source, value.runtimeUri].filter(Boolean),
    };
  }
  return null;
}

function isPreparedAssetRefValue(value: unknown): value is PreparedAssetRef {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as PreparedAssetRef).source === 'string'
    && typeof (value as PreparedAssetRef).runtimeUri === 'string';
}

function isWmdlPath(pathValue: string): boolean {
  return pathValue.toLowerCase().endsWith('.wmdl');
}
