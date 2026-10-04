import type { ResourceKind } from '../../api/types/project';
import { extractLive2DModelData } from '../../engine/Live2DModelData';

export interface ResourceImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Raster formats the image read pipeline can process deterministically.
 * SVG must be rasterized or rejected, AVIF has no header dimension parser and
 * BMP has no magic sniff — all surface as unsupported at the read port.
 */
export type SniffedImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'svg';

/**
 * Magic-byte image format detection. Used by the readImage port to verify the
 * declared MIME against actual content and to reject audio/video/SVG payloads
 * that are not safe to deliver.
 */
export function sniffImageFormat(head: Uint8Array): SniffedImageFormat | null {
  if (head.length < 6) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'gif';
  if (head.length >= 12 && ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'webp';
  if (head.length >= 12 && ascii(head, 4, 'ftypavif')) return 'avif';
  if (head.length >= 12 && ascii(head, 4, 'ftypavis')) return 'avif';
  if (head.length >= 16 && ascii(head, 0, '<svg')) return 'svg';
  if (head.length >= 256) {
    const prefix = String.fromCharCode(...head.slice(0, 256)).toLowerCase();
    const trimmed = prefix.replace(/^\s+/, '');
    if (trimmed.startsWith('<?xml') && prefix.includes('<svg')) return 'svg';
  }
  return null;
}

export interface ResourceAudioMetadata {
  readonly format: string;
  /** Only present when the container header yields it without decoding content. */
  readonly durationSeconds?: number;
}

export interface Live2DCapabilities {
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
  readonly runtimeFamily: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.cube': 'application/octet-stream',
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac)$/i;
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const MODEL_ENTRY = /(?:^|\/)(?:model\.json|model\.model3\.json)$/i;
const ANY_MODEL_ENTRY = /(?:^|\/)model(?:\.model3)?\.json$/i;

/** True for a file name that marks a Live2D model bundle entrypoint. */
export function isLive2DModelEntryPath(relative: string): boolean {
  return MODEL_ENTRY.test(relative)
    || ANY_MODEL_ENTRY.test(relative)
    || relative.replace(/\\/g, '/').toLowerCase().endsWith('.wmdl');
}

export function resourceMimeType(path: string): string | undefined {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  for (const ext of Object.keys(MIME_BY_EXT)) {
    if (lower.endsWith(ext)) return MIME_BY_EXT[ext];
  }
  return undefined;
}

/**
 * Deterministic resource-kind classification mirroring the app's own
 * resource-authoring conventions (ProjectResourceIndex). Kinds that are keys
 * declared inside model files (live2dMotion/live2dExpression) are never
 * classified from paths: they surface through inspectResource of a model.
 */
export function classifyResourceKind(relative: string): ResourceKind | null {
  const normalized = relative.replace(/\\/g, '/');
  if (isHiddenResourcePath(normalized)) return null;
  const segments = normalized.split('/').filter(Boolean);
  const base = segments.at(-1) ?? '';
  if (isLive2DModelEntryPath(normalized)) return 'live2dModel';
  if (IMAGE_EXT.test(base)) return isBackgroundPath(normalized) ? 'background' : 'image';
  if (AUDIO_EXT.test(base)) return audioKindByPath(normalized);
  if (FONT_EXT.test(base)) return 'font';
  if (base.toLowerCase().endsWith('.cube')) return 'lut';
  if (VIDEO_EXT.test(base)) return 'animation';
  if (base.toLowerCase().endsWith('.json')) return 'animation';
  return null;
}

/** Dot directories and files are internal assets, not resource candidates. */
export function isHiddenResourcePath(relative: string): boolean {
  return relative.replace(/\\/g, '/').split('/').some((segment) => segment.startsWith('.') && segment !== '.');
}

/**
 * Owner/outfit identity for Live2D model entrypoints, relative to the last
 * `figure` segment in the path (mirrors ProjectResourceIndex.addProjectModels).
 */
export function live2dIdentity(relative: string): { ownerId?: string; outfitId?: string } {
  const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
  const figureIndex = parts.lastIndexOf('figure');
  const rest = figureIndex >= 0 ? parts.slice(figureIndex + 1) : parts;
  const modelsIndex = rest.lastIndexOf('models');
  if (modelsIndex > 0) {
    return { ownerId: rest[modelsIndex - 1], outfitId: rest[modelsIndex + 1] };
  }
  if (rest.length >= 3) {
    return { ownerId: rest[0], outfitId: rest[rest.length - 2] };
  }
  return {};
}

/**
 * Header-only image dimension parsing: never decodes pixel content.
 */
export function sniffImageDimensions(head: Uint8Array): ResourceImageDimensions | null {
  if (head.length < 6) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head.length >= 24) {
    return { width: readUint32BE(head, 16), height: readUint32BE(head, 20) };
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    return sniffJpegDimensions(head);
  }
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
    return { width: readUint16LE(head, 6), height: readUint16LE(head, 8) };
  }
  if (head.length >= 27 && ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) {
    return sniffWebpDimensions(head);
  }
  return null;
}

/**
 * Header-only audio metadata: duration only when the container header
 * describes it (WAV fmt/data chunks). Audio content is never decoded.
 */
export function sniffAudioMetadata(head: Uint8Array, mimeType?: string): ResourceAudioMetadata | null {
  const lower = (mimeType ?? '').toLowerCase();
  if (lower.includes('wav') && head.length >= 44 && ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) {
    const duration = parseWavDuration(head);
    return { format: 'wav', ...(duration !== undefined ? { durationSeconds: duration } : {}) };
  }
  if (lower.includes('mpeg') || lower.includes('mp3')) return { format: 'mp3' };
  if (lower.includes('ogg')) return { format: 'ogg' };
  if (lower.includes('m4a') || lower.includes('mp4')) return { format: 'm4a' };
  if (lower.includes('flac')) return { format: 'flac' };
  return null;
}

/**
 * Reuses the engine's Live2D model-data parser: motions/expressions are read
 * from the model document only, never from stage or runtime state.
 */
export function parseLive2DCapabilities(
  jsonText: string,
  entrypointPath: string,
): Live2DCapabilities {
  try {
    const json = JSON.parse(jsonText) as unknown;
    if (!json || typeof json !== 'object') return { motions: [], expressions: [], runtimeFamily: 'unknown' };
    const data = extractLive2DModelData(json, entrypointPath);
    return {
      motions: [...data.motions],
      expressions: [...data.expressions],
      runtimeFamily: data.runtimeFamily,
    };
  } catch {
    return { motions: [], expressions: [], runtimeFamily: 'unknown' };
  }
}

function isBackgroundPath(relative: string): boolean {
  const segments = relative.split('/').filter(Boolean);
  return segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === 'background' || normalized === 'backgrounds';
  });
}

function audioKindByPath(relative: string): ResourceKind {
  const lower = relative.toLowerCase();
  if (/(^|\/)(vocal|voice|voices)(\/|$)/.test(lower)) return 'voice';
  if (/(^|\/)sfx(\/|$)/.test(lower)) return 'sfx';
  return 'bgm';
}

function sniffJpegDimensions(head: Uint8Array): ResourceImageDimensions | null {
  let cursor = 2;
  while (cursor + 9 < head.length) {
    if (head[cursor] !== 0xff) {
      cursor += 1;
      continue;
    }
    const marker = head[cursor + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      cursor += 2;
      continue;
    }
    const length = readUint16BE(head, cursor + 2);
    if (length < 2 || cursor + 2 + length > head.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = readUint16BE(head, cursor + 5);
      const width = readUint16BE(head, cursor + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    cursor += 2 + length;
  }
  return null;
}

function sniffWebpDimensions(head: Uint8Array): ResourceImageDimensions | null {
  if (ascii(head, 12, 'VP8 ') && head.length >= 27) {
    // Lossy frame tag 0x9d 0x01 0x2a, then 14-bit LE dimensions.
    if (head[20] === 0x9d && head[21] === 0x01 && head[22] === 0x2a) {
      const width = readUint16LE(head, 23) & 0x3fff;
      const height = readUint16LE(head, 25) & 0x3fff;
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
  }
  if (ascii(head, 12, 'VP8L') && head.length >= 25) {
    const signature = head[20];
    if ((signature & 0x0f) === 0x0f) {
      const bits = readUint32LE(head, 21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }
  if (ascii(head, 12, 'VP8X') && head.length >= 30) {
    const width = 1 + readUint24LE(head, 24);
    const height = 1 + readUint24LE(head, 27);
    return { width, height };
  }
  return null;
}

function parseWavDuration(head: Uint8Array): number | undefined {
  let cursor = 12;
  let byteRate: number | undefined;
  let dataBytes = 0;
  while (cursor + 8 <= head.length) {
    const id = String.fromCharCode(head[cursor], head[cursor + 1], head[cursor + 2], head[cursor + 3]);
    const size = readUint32LE(head, cursor + 4);
    if (id === 'fmt ') {
      if (size < 12 || cursor + 8 + size > head.length) break;
      byteRate = readUint32LE(head, cursor + 16);
      cursor += 8 + size + (size % 2);
      continue;
    }
    if (id === 'data') {
      dataBytes = size;
      break;
    }
    cursor += 8 + size + (size % 2);
  }
  if (byteRate === undefined || byteRate <= 0 || dataBytes <= 0) return undefined;
  return Math.round((dataBytes / byteRate) * 1000) / 1000;
}

const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

function ascii(head: Uint8Array, offset: number, expected: string): boolean {
  if (offset + expected.length > head.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (head[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

function readUint16BE(head: Uint8Array, offset: number): number {
  return (head[offset] << 8) | head[offset + 1];
}

function readUint16LE(head: Uint8Array, offset: number): number {
  return head[offset] | (head[offset + 1] << 8);
}

function readUint32BE(head: Uint8Array, offset: number): number {
  return ((head[offset] << 24) | (head[offset + 1] << 16) | (head[offset + 2] << 8) | head[offset + 3]) >>> 0;
}

function readUint32LE(head: Uint8Array, offset: number): number {
  return (head[offset] | (head[offset + 1] << 8) | (head[offset + 2] << 16) | (head[offset + 3] << 24)) >>> 0;
}

function readUint24LE(head: Uint8Array, offset: number): number {
  return head[offset] | (head[offset + 1] << 8) | (head[offset + 2] << 16);
}
