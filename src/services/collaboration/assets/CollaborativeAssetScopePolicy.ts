import type {
  CollaborativeAssetKind,
  ProjectRelativeAssetPath,
} from '../../../api/types/collaboration';
import type { ResourceImportKind } from '../../../api/types/project';
import type {
  DialogueCompanion,
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
  SceneStatement,
} from '../../../api/types/semantic-scene';
import type { SceneAudio, SceneMeta } from '../../../api/types/scene-common';
import { sceneStatementDefinitionRegistry } from '../../semantic-scene';
import { isLive2DModelEntryPath } from './Live2DModelEntry';

export interface LegacyCollaborativeSceneTimelineAction {
  readonly _id?: string;
  readonly action: string;
  readonly time?: number;
  readonly params?: Record<string, any>;
}

export interface LegacyCollaborativeScene {
  readonly sceneId?: string;
  readonly meta: SceneMeta;
  readonly audio?: SceneAudio;
  readonly timeline: readonly LegacyCollaborativeSceneTimelineAction[];
}

export interface CollaborativeAssetRef {
  kind: CollaborativeAssetKind;
  importKind: ResourceImportKind;
  projectRelativePath: ProjectRelativeAssetPath;
}

export function normalizeProjectRelativeAssetPath(pathValue: string): ProjectRelativeAssetPath {
  return pathValue.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isProjectRelativeAssetPath(pathValue: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(pathValue)
    && !/^[a-z]:\//i.test(pathValue)
    && !pathValue.startsWith('//')
    && !pathValue.startsWith('data:');
}

function addProjectRelativeRef(
  refs: Map<string, CollaborativeAssetRef>,
  ref: CollaborativeAssetRef,
): void {
  const normalized = normalizeProjectRelativeAssetPath(ref.projectRelativePath);
  if (!normalized || !isProjectRelativeAssetPath(normalized)) return;
  refs.set(normalized, { ...ref, projectRelativePath: normalized });
}

function collectSceneMetaAssetRefs(
  refs: Map<string, CollaborativeAssetRef>,
  scene: { readonly meta: SceneMeta },
): void {
  for (const character of scene.meta.characters || []) {
    if (isLive2DModelEntryPath(character.model)) {
      addProjectRelativeRef(refs, { kind: 'live2d-bundle', importKind: 'figure', projectRelativePath: character.model });
    }
    for (const variant of character.variants || []) {
      if (isLive2DModelEntryPath(variant.model)) {
        addProjectRelativeRef(refs, { kind: 'live2d-bundle', importKind: 'figure', projectRelativePath: variant.model });
      }
    }
  }
}

export function dirnameProjectRelativePath(pathValue: string): ProjectRelativeAssetPath {
  const normalized = normalizeProjectRelativeAssetPath(pathValue);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function joinProjectRelativePath(baseDir: string, childPath: string): ProjectRelativeAssetPath {
  const child = normalizeProjectRelativeAssetPath(childPath);
  if (!baseDir) return child;
  if (!child) return normalizeProjectRelativeAssetPath(baseDir);
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

export function collectCollaborativeSceneAssetRefs(scene: LegacyCollaborativeScene): CollaborativeAssetRef[] {
  const refs = new Map<string, CollaborativeAssetRef>();

  const addRef = (ref: CollaborativeAssetRef): void => {
    addProjectRelativeRef(refs, ref);
  };

  if (scene.audio?.bgm?.file) {
    addRef({ kind: 'audio-file', importKind: 'bgm', projectRelativePath: scene.audio.bgm.file });
  }

  collectSceneMetaAssetRefs(refs, scene);

  for (const action of scene.timeline) {
    if (action.action === 'addCharacter' && isLive2DModelEntryPath(action.params?.model)) {
      addRef({ kind: 'live2d-bundle', importKind: 'figure', projectRelativePath: action.params.model });
    }

    if ((action.action === 'setBackground' || action.action === 'setEnvironmentLayer') && action.params?.image) {
      addRef({ kind: 'background-image', importKind: 'background', projectRelativePath: action.params.image });
    }

    if (action.action === 'playAudio' || action.action === 'setBGM') {
      const audioPath = action.params?.file ?? action.params?.url;
      if (audioPath) {
        addRef({ kind: 'audio-file', importKind: 'bgm', projectRelativePath: audioPath });
      }
    }

    if (action.action === 'dialogue' && action.params?.voice) {
      addRef({ kind: 'audio-file', importKind: 'vocal', projectRelativePath: action.params.voice });
    }

    if (action.action === 'addImage' && action.params?.file) {
      addRef({ kind: 'image-file', importKind: 'images', projectRelativePath: action.params.file });
    }

    if (action.action === 'playCustomAnimation' && action.params?.file) {
      addRef({ kind: 'animation-file', importKind: 'animation', projectRelativePath: action.params.file });
    }
  }

  return Array.from(refs.values());
}

export function getCollaborativeAssetReferenceKeys(scene: LegacyCollaborativeScene): ProjectRelativeAssetPath[] {
  return collectCollaborativeSceneAssetRefs(scene)
    .map((ref) => ref.projectRelativePath)
    .sort();
}

type SceneStatementAssetSource = Pick<SceneStatement, 'type' | 'params'> | Pick<DialogueCompanion, 'type' | 'params'>;

function classifySceneDocumentV4AssetRef(
  statement: SceneStatementAssetSource,
  path: string,
  value: string,
): CollaborativeAssetRef | null {
  switch (statement.type) {
    case 'dialogue':
      return path === 'params.voice'
        ? { kind: 'audio-file', importKind: 'vocal', projectRelativePath: value }
        : null;
    case 'characterPresence':
      return path === 'params.model' && isLive2DModelEntryPath(value)
        ? { kind: 'live2d-bundle', importKind: 'figure', projectRelativePath: value }
        : null;
    case 'environmentLayer':
      return path === 'params.file' || path === 'params.image'
        ? { kind: 'background-image', importKind: 'background', projectRelativePath: value }
        : null;
    case 'audio':
      return path === 'params.file'
        ? {
            kind: 'audio-file',
            importKind: (statement.params as { role?: string }).role === 'bgm' ? 'bgm' : 'generic',
            projectRelativePath: value,
          }
        : null;
    case 'graphicLayer':
      return path === 'params.file'
        ? { kind: 'image-file', importKind: 'images', projectRelativePath: value }
        : null;
    case 'customAnimation':
      return path === 'params.file' || path === 'params.animation'
        ? { kind: 'animation-file', importKind: 'animation', projectRelativePath: value }
        : null;
    default:
      return null;
  }
}

function collectStatementAssetRefs(
  refs: Map<string, CollaborativeAssetRef>,
  statement: SceneStatementAssetSource,
): void {
  for (const field of sceneStatementDefinitionRegistry.collectAssetReferences(statement as SceneStatement)) {
    const ref = classifySceneDocumentV4AssetRef(statement, field.path, field.value);
    if (ref) addProjectRelativeRef(refs, ref);
  }
}

export function collectCollaborativeSceneDocumentV4AssetRefs(document: HistoricalSceneDocumentV4): CollaborativeAssetRef[] {
  const refs = new Map<string, CollaborativeAssetRef>();

  collectSceneMetaAssetRefs(refs, document);

  for (const statement of document.statements) {
    collectStatementAssetRefs(refs, statement);
    for (const companion of statement.companions || []) {
      collectStatementAssetRefs(refs, companion);
    }
  }

  return Array.from(refs.values());
}

export function getCollaborativeSceneDocumentV4AssetReferenceKeys(document: HistoricalSceneDocumentV4): ProjectRelativeAssetPath[] {
  return collectCollaborativeSceneDocumentV4AssetRefs(document)
    .map((ref) => ref.projectRelativePath)
    .sort();
}

export function collectCollaborativeSceneDocumentV5AssetRefs(document: SceneDocumentV5): CollaborativeAssetRef[] {
  const refs = new Map<string, CollaborativeAssetRef>();

  collectSceneMetaAssetRefs(refs, document);

  for (const statement of document.statements) {
    collectStatementAssetRefs(refs, statement);
    for (const companion of statement.companions || []) {
      collectStatementAssetRefs(refs, companion);
    }
  }

  return Array.from(refs.values());
}

export function getCollaborativeSceneDocumentV5AssetReferenceKeys(document: SceneDocumentV5): ProjectRelativeAssetPath[] {
  return collectCollaborativeSceneDocumentV5AssetRefs(document)
    .map((ref) => ref.projectRelativePath)
    .sort();
}
