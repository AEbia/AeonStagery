import type {
  CollaborativeAssetFileEntry,
  CollaborativeAssetManifestEntry,
  ContentHash,
  ProjectRelativeAssetPath,
} from '../../../api/types/collaboration';
import type { CollaborativeAssetRef } from './CollaborativeAssetScopePolicy';

export interface CollaborativeAssetBytes {
  relativePath: ProjectRelativeAssetPath;
  bytes: Uint8Array;
}

export interface CollaborativeAssetHashAdapter {
  sha256(bytes: Uint8Array): Promise<ContentHash>;
}

const textEncoder = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function extensionOf(pathValue: string): string {
  const clean = pathValue.replace(/\\/g, '/').replace(/^\/+/, '');
  const index = clean.lastIndexOf('.');
  return index === -1 ? '' : clean.slice(index).toLowerCase();
}

export const browserCollaborativeAssetHashAdapter: CollaborativeAssetHashAdapter = {
  async sha256(bytes: Uint8Array): Promise<ContentHash> {
    if (!globalThis.crypto?.subtle) {
      throw new Error('crypto.subtle is required to build collaborative asset hashes');
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  },
};

export function guessCollaborativeAssetMimeType(pathValue: string): string | undefined {
  switch (extensionOf(pathValue)) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
      return 'text/javascript';
    case '.json':
    case '.wmdl':
      return 'application/json';
    default:
      return undefined;
  }
}

export function orderCollaborativeManifestFiles<T extends { relativePath: ProjectRelativeAssetPath }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function fingerprintCollaborativeAssetFile(
  file: CollaborativeAssetBytes,
  hashAdapter: CollaborativeAssetHashAdapter,
): Promise<CollaborativeAssetFileEntry> {
  const contentHash = await hashAdapter.sha256(file.bytes);
  const mimeType = guessCollaborativeAssetMimeType(file.relativePath);
  return {
    relativePath: file.relativePath,
    contentHash,
    sizeBytes: file.bytes.byteLength,
    ...(mimeType ? { mimeType } : {}),
  };
}

export async function hashCollaborativeAssetBundle(
  files: CollaborativeAssetBytes[],
  hashAdapter: CollaborativeAssetHashAdapter,
): Promise<ContentHash> {
  const chunks: Uint8Array[] = [];
  for (const file of orderCollaborativeManifestFiles(files)) {
    chunks.push(textEncoder.encode(`${file.relativePath}\n`));
    chunks.push(file.bytes);
    chunks.push(textEncoder.encode('\n'));
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return hashAdapter.sha256(combined);
}

export function buildSingleFileManifestEntry(
  ref: CollaborativeAssetRef,
  file: CollaborativeAssetFileEntry,
  createdAt: string,
): CollaborativeAssetManifestEntry {
  return {
    assetId: `${ref.kind}:${file.contentHash}`,
    kind: ref.kind,
    importKind: ref.importKind,
    projectRelativePath: ref.projectRelativePath,
    entrypointPath: ref.projectRelativePath,
    contentHash: file.contentHash,
    files: [file],
    createdAt,
  };
}

export function buildBundleManifestEntry(
  ref: CollaborativeAssetRef,
  files: CollaborativeAssetFileEntry[],
  bundleHash: ContentHash,
  createdAt: string,
): CollaborativeAssetManifestEntry {
  return {
    assetId: `${ref.kind}:${bundleHash}`,
    kind: ref.kind,
    importKind: ref.importKind,
    projectRelativePath: ref.projectRelativePath,
    entrypointPath: ref.projectRelativePath,
    contentHash: bundleHash,
    files: orderCollaborativeManifestFiles(files),
    createdAt,
  };
}
