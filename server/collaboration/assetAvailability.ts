import { createHash } from 'node:crypto';
import type {
  CollaborativeAssetFileEntry,
  CollaborativeAssetManifestEntry,
  CollaborativeSceneStateV2,
  CollaborativeSceneStateV3,
  ContentHash,
  ProjectRelativeAssetPath,
} from '../../src/api/types/collaboration';
import type {
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
  SceneStatement,
} from '../../src/api/types/semantic-scene';
import { materializeCollaborativeSceneDocumentV4 } from '../../src/services/collaboration/CollaborativeSceneStateV2';
import { materializeCollaborativeSceneDocumentV5 } from '../../src/services/collaboration/CollaborativeSceneStateV3';
import {
  hashCollaborativeAssetBundle,
  isLive2DModelEntryPath,
  normalizeProjectRelativeAssetPath,
  type CollaborativeAssetHashAdapter,
} from '../../src/services/collaboration/assets';
import { sceneStatementDefinitionRegistry } from '../../src/services/semantic-scene';
import type { CollaborationAssetStore } from './assets';

export class CollaborativeAssetAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborativeAssetAvailabilityError';
  }
}

const nodeCollaborativeAssetHashAdapter: CollaborativeAssetHashAdapter = {
  async sha256(bytes: Uint8Array): Promise<ContentHash> {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  },
};

function fail(message: string): never {
  throw new CollaborativeAssetAvailabilityError(`Collaborative asset availability check failed: ${message}`);
}

interface VerifiedManifestEntry {
  signature: string;
  fileRevisions: number[];
}

type AssetStoreWithRevisions = CollaborationAssetStore & {
  getAssetRevision?: (projectRelativePath: string) => number;
};

const verifiedManifestEntries = new WeakMap<object, Map<string, VerifiedManifestEntry>>();

function getAssetRevisionReader(
  assetStore: CollaborationAssetStore,
): ((projectRelativePath: string) => number) | null {
  const revisionStore = assetStore as AssetStoreWithRevisions;
  return typeof revisionStore.getAssetRevision === 'function'
    ? (projectRelativePath) => revisionStore.getAssetRevision!(projectRelativePath)
    : null;
}

function canReuseManifestEntryVerification(
  assetStore: CollaborationAssetStore,
  entryKey: string,
  entry: CollaborativeAssetManifestEntry,
  signature: string,
  getAssetRevision: ((projectRelativePath: string) => number) | null,
): boolean {
  if (!getAssetRevision) return false;
  const cached = verifiedManifestEntries.get(assetStore)?.get(entryKey);
  if (!cached || cached.signature !== signature || cached.fileRevisions.length !== entry.files.length) {
    return false;
  }

  return entry.files.every((file, index) => (
    getAssetRevision(file.relativePath) === cached.fileRevisions[index]
  ));
}

function rememberManifestEntryVerification(
  assetStore: CollaborationAssetStore,
  entryKey: string,
  signature: string,
  fileRevisions: number[],
): void {
  let entries = verifiedManifestEntries.get(assetStore);
  if (!entries) {
    entries = new Map();
    verifiedManifestEntries.set(assetStore, entries);
  }
  entries.set(entryKey, { signature, fileRevisions });
}

async function readAndVerifyFile(
  assetStore: CollaborationAssetStore,
  file: CollaborativeAssetFileEntry,
  entry: CollaborativeAssetManifestEntry,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await assetStore.readAsset(file.relativePath);
  } catch {
    fail(`missing asset file "${file.relativePath}" for "${entry.projectRelativePath}"`);
  }

  if (bytes.byteLength !== file.sizeBytes) {
    fail(`asset file "${file.relativePath}" has size ${bytes.byteLength}, expected ${file.sizeBytes}`);
  }

  const fileHash = await nodeCollaborativeAssetHashAdapter.sha256(bytes);
  if (fileHash !== file.contentHash) {
    fail(`asset file "${file.relativePath}" has hash ${fileHash}, expected ${file.contentHash}`);
  }

  return bytes;
}

async function verifyManifestEntry(
  assetStore: CollaborationAssetStore,
  entryKey: string,
  entry: CollaborativeAssetManifestEntry,
): Promise<void> {
  if (entry.projectRelativePath !== entryKey) {
    fail(`manifest key "${entryKey}" does not match entry path "${entry.projectRelativePath}"`);
  }
  if (entry.files.length === 0) {
    fail(`manifest entry "${entry.projectRelativePath}" has no files`);
  }

  if (
    (entry.kind === 'background-image' ||
      entry.kind === 'audio-file' ||
      entry.kind === 'image-file' ||
      entry.kind === 'animation-file') &&
    entry.files.length !== 1
  ) {
    fail(`${entry.kind} manifest entry "${entry.projectRelativePath}" must contain exactly one file`);
  }

  const signature = JSON.stringify(entry);
  const getAssetRevision = getAssetRevisionReader(assetStore);
  if (canReuseManifestEntryVerification(assetStore, entryKey, entry, signature, getAssetRevision)) {
    return;
  }

  const fileRevisions = getAssetRevision
    ? entry.files.map((file) => getAssetRevision(file.relativePath))
    : [];

  const files: Array<{ relativePath: string; bytes: Uint8Array }> = [];
  for (let index = 0; index < entry.files.length; index += 1) {
    const file = entry.files[index];
    files.push({
      relativePath: file.relativePath,
      bytes: await readAndVerifyFile(assetStore, file, entry),
    });

    if (
      getAssetRevision &&
      getAssetRevision(file.relativePath) !== fileRevisions[index]
    ) {
      fail(`asset file "${file.relativePath}" changed while its manifest was being verified`);
    }
  }

  const entryHash = entry.kind === 'live2d-bundle'
    ? await hashCollaborativeAssetBundle(files, nodeCollaborativeAssetHashAdapter)
    : await nodeCollaborativeAssetHashAdapter.sha256(files[0].bytes);
  if (entryHash !== entry.contentHash) {
    fail(`manifest entry "${entry.projectRelativePath}" has hash ${entryHash}, expected ${entry.contentHash}`);
  }

  if (getAssetRevision) {
    const revisionsAfterVerification = entry.files.map((file) => getAssetRevision(file.relativePath));
    if (revisionsAfterVerification.some((revision, index) => revision !== fileRevisions[index])) {
      fail(`asset manifest entry "${entry.projectRelativePath}" changed while it was being verified`);
    }
    rememberManifestEntryVerification(assetStore, entryKey, signature, fileRevisions);
  }
}

function addSourceAssetRef(refs: Set<ProjectRelativeAssetPath>, value: string | undefined): void {
  if (!value) return;
  const normalized = normalizeProjectRelativeAssetPath(value);
  if (!normalized) return;
  refs.add(normalized);
}

function collectSceneDocumentAssetReferenceKeys(
  document: HistoricalSceneDocumentV4 | SceneDocumentV5,
): ProjectRelativeAssetPath[] {
  const refs = new Set<ProjectRelativeAssetPath>();

  for (const character of document.meta.characters || []) {
    if (isLive2DModelEntryPath(character.model)) {
      addSourceAssetRef(refs, character.model);
    }
    for (const variant of character.variants || []) {
      if (isLive2DModelEntryPath(variant.model)) {
        addSourceAssetRef(refs, variant.model);
      }
    }
  }

  for (const statement of document.statements) {
    for (const ref of sceneStatementDefinitionRegistry.collectAssetReferences(statement)) {
      addSourceAssetRef(refs, ref.value);
    }

    for (const companion of statement.companions ?? []) {
      const companionStatement = {
        id: companion.id,
        time: statement.time,
        type: companion.type,
        params: companion.params,
      } as SceneStatement;
      for (const ref of sceneStatementDefinitionRegistry.collectAssetReferences(companionStatement)) {
        addSourceAssetRef(refs, ref.value);
      }
    }
  }

  return Array.from(refs).sort();
}

function collectSceneDocumentV4AssetReferenceKeys(document: HistoricalSceneDocumentV4): ProjectRelativeAssetPath[] {
  return collectSceneDocumentAssetReferenceKeys(document);
}

export async function validateCollaborativeAssetAvailabilityV2(
  state: CollaborativeSceneStateV2,
  assetStore: CollaborationAssetStore,
): Promise<void> {
  const document = materializeCollaborativeSceneDocumentV4(state);
  const requiredAssetRefs = collectSceneDocumentV4AssetReferenceKeys(document);
  const manifest = state.assets ?? {};

  for (const projectRelativePath of requiredAssetRefs) {
    const entry = manifest[projectRelativePath];
    if (!entry) {
      fail(`missing manifest entry for referenced asset "${projectRelativePath}"`);
    }
  }

  for (const [entryKey, entry] of Object.entries(manifest)) {
    await verifyManifestEntry(assetStore, entryKey, entry);
  }
}

export async function validateCollaborativeAssetAvailabilityV3(
  state: CollaborativeSceneStateV3,
  assetStore: CollaborationAssetStore,
): Promise<void> {
  const document = materializeCollaborativeSceneDocumentV5(state);
  const requiredAssetRefs = collectSceneDocumentAssetReferenceKeys(document);
  const manifest = state.assets ?? {};

  for (const projectRelativePath of requiredAssetRefs) {
    const entry = manifest[projectRelativePath];
    if (!entry) {
      fail(`missing manifest entry for referenced asset "${projectRelativePath}"`);
    }
  }

  for (const [entryKey, entry] of Object.entries(manifest)) {
    await verifyManifestEntry(assetStore, entryKey, entry);
  }
}
