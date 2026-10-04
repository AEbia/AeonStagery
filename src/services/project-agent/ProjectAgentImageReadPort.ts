import type { ExternalLibraryMount, ProjectState } from '../../api/types/project';
import type { AgentImageDetail } from '../../api/types/project-agent';
import { ProjectAgentPortError } from './ProjectAgentProjectReadPorts';
import type { ProjectAgentProjectFs } from './ProjectAgentProjectFs';
import { isCanonicalPathWithinRoot } from './ProjectAgentPathRules';
import { DEFAULT_AI_CONVERSATION_MAX_IMAGE_BYTES } from '../ai-authoring/AiConversationTransport';
import {
  extractGifFirstFrame,
  scaleRgbaNearest,
  encodePngRgba,
} from './ProjectAgentGifFrame';
import {
  resourceMimeType,
  sniffImageDimensions,
  sniffImageFormat,
} from './ProjectAgentResourceMetadata';
import type { ProjectAgentImageReadPort } from './ProjectAgentPorts';

/** Input byte limit for one image (mirrors the transport image budget). */
export const PROJECT_AGENT_MAX_IMAGE_BYTES = DEFAULT_AI_CONVERSATION_MAX_IMAGE_BYTES;
/**
 * Decode-pixel safety cap: raster dimensions beyond this are never processed
 * (fail closed), because oversized payloads could not be decoded safely.
 */
export const PROJECT_AGENT_MAX_IMAGE_DECODE_PIXELS = 4096 * 4096;
/** Output long-edge cap for detail=low deliveries. */
export const PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_LOW = 512;
/** Output long-edge cap for detail=auto/high deliveries. */
export const PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_HIGH = 2048;
/**
 * Delivered pixel budget for extracted GIF frames: the stored (uncompressed)
 * PNG payload must stay within the 8MB image byte budget.
 */
export const PROJECT_AGENT_GIF_FRAME_PIXEL_BUDGET = 2048 * 1024;

export type ProjectAgentImageReadErrorCode =
  | 'image_too_large'
  | 'image_mime_mismatch'
  | 'unsupported_image_format'
  | 'image_decode_limit_exceeded';

/** Structured media failure for the readImage pipeline. */
export class ProjectAgentImageReadError extends Error {
  readonly code: ProjectAgentImageReadErrorCode;

  constructor(code: ProjectAgentImageReadErrorCode, message: string) {
    super(message);
    this.name = 'ProjectAgentImageReadError';
    this.code = code;
  }
}

export interface ProjectAgentImageReadPortOptions {
  readonly fs: ProjectAgentProjectFs;
  readonly getProject: () => Pick<ProjectState, 'rootPath' | 'metadata'> | null;
  readonly getExternalMounts: () => readonly ExternalLibraryMount[];
}

/**
 * Bounded, decoded and safely transformed image reads (ADR0023): root
 * containment with no-follow symlinks, byte/MIME/decode-pixel/output-dimension
 * limits, safe scaling, SVG rejection, deterministic first-frame extraction
 * for animated GIFs. Never touches audio content, video frames, stage capture,
 * seek or shared playback/runtime state.
 */
export function createProjectAgentImageReadPort(
  options: ProjectAgentImageReadPortOptions,
): ProjectAgentImageReadPort {
  const port = new ProjectAgentImageReadPortImpl(options);
  return {
    readImage: (imageOptions) => port.readImage(imageOptions),
    exists: (reference) => port.exists(reference),
  };
}

class ProjectAgentImageReadPortImpl {
  private readonly fs: ProjectAgentProjectFs;
  private readonly getProject: () => Pick<ProjectState, 'rootPath' | 'metadata'> | null;
  private readonly getExternalMounts: () => readonly ExternalLibraryMount[];

  constructor(options: ProjectAgentImageReadPortOptions) {
    this.fs = options.fs;
    this.getProject = options.getProject;
    this.getExternalMounts = options.getExternalMounts;
  }

  /** Stat-only existence probe (no image read). */
  async exists(reference: string): Promise<boolean> {
    try {
      const resolved = await this.resolveReference(reference);
      const stat = await this.fs.stat(resolved.absolute);
      return stat !== null && stat.isFile;
    } catch {
      return false;
    }
  }

  async readImage(options: {
    reference: string;
    detail: AgentImageDetail;
  }): Promise<{
    mimeType: string;
    bytes: Uint8Array;
    originalWidth: number;
    originalHeight: number;
    deliveredWidth: number;
    deliveredHeight: number;
    scaled: boolean;
    contentFingerprint: string;
    animated?: boolean;
    frame?: 'first';
  }> {
    const resolved = await this.resolveReference(options.reference);
    const stat = await this.fs.stat(resolved.absolute);
    if (!stat || !stat.isFile) {
      throw new ProjectAgentPortError('not_found', 'Image does not exist inside the registered root');
    }

    // Byte limit: read at most limit+1 bytes so oversized files are detected.
    const head = await this.fs.readHead(resolved.absolute, PROJECT_AGENT_MAX_IMAGE_BYTES + 1);
    if (!head) {
      throw new ProjectAgentPortError('not_found', 'Image could not be read');
    }
    if (head.length > PROJECT_AGENT_MAX_IMAGE_BYTES) {
      throw new ProjectAgentImageReadError(
        'image_too_large',
        `Image exceeds the ${PROJECT_AGENT_MAX_IMAGE_BYTES} byte limit`,
      );
    }

    const declared = resourceMimeType(resolved.relative);
    if (!declared || !declared.startsWith('image/')) {
      throw new ProjectAgentImageReadError(
        'image_mime_mismatch',
        'The referenced resource is not an image',
      );
    }
    const format = sniffImageFormat(head);
    if (!format) {
      if (isAudioOrVideoContent(head)) {
        throw new ProjectAgentImageReadError(
          'image_mime_mismatch',
          'The referenced resource is audio or video content, never image content',
        );
      }
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'The image container could not be identified safely',
      );
    }
    if (!formatMatches(format, declared)) {
      throw new ProjectAgentImageReadError(
        'image_mime_mismatch',
        `Image content (${format}) does not match the declared ${declared} MIME type`,
      );
    }

    const contentFingerprint = fingerprint(head);

    if (format === 'svg') {
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'SVG must be safely rasterized before delivery and is rejected when rasterization is unavailable',
      );
    }
    if (format === 'avif') {
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'AVIF dimension decoding is not available; the image is rejected',
      );
    }

    const dimensions = sniffImageDimensions(head);
    if (!dimensions) {
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'Image dimensions could not be parsed from the container header',
      );
    }
    const { width: originalWidth, height: originalHeight } = dimensions;
    if (originalWidth <= 0 || originalHeight <= 0) {
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'Image dimensions are not valid',
      );
    }
    if (originalWidth * originalHeight > PROJECT_AGENT_MAX_IMAGE_DECODE_PIXELS) {
      throw new ProjectAgentImageReadError(
        'image_decode_limit_exceeded',
        `Image pixel count exceeds the ${PROJECT_AGENT_MAX_IMAGE_DECODE_PIXELS} decode limit`,
      );
    }

    const maxLongEdge = options.detail === 'low'
      ? PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_LOW
      : PROJECT_AGENT_IMAGE_OUTPUT_LONG_EDGE_HIGH;

    if (format === 'gif') {
      return this.deliverGifFirstFrame(head, contentFingerprint, maxLongEdge);
    }

    // Raster pass-through: the delivery spec is deterministically scaled to
    // the output dimension cap; the (already bounded) bytes pass through
    // unchanged because no safe decoder exists for re-encoding in V1.
    const delivered = fitWithin(originalWidth, originalHeight, maxLongEdge);
    return {
      mimeType: declared,
      bytes: head,
      originalWidth,
      originalHeight,
      deliveredWidth: delivered.width,
      deliveredHeight: delivered.height,
      scaled: delivered.scaled,
      contentFingerprint,
    };
  }

  private deliverGifFirstFrame(
    bytes: Uint8Array,
    contentFingerprint: string,
    maxLongEdge: number,
  ): Promise<{
    mimeType: string;
    bytes: Uint8Array;
    originalWidth: number;
    originalHeight: number;
    deliveredWidth: number;
    deliveredHeight: number;
    scaled: boolean;
    contentFingerprint: string;
    animated: boolean;
    frame: 'first';
  }> {
    // The decode-pixel budget is enforced against the frame HEADER inside
    // extractGifFirstFrame, BEFORE the LZW stream is decoded, so an oversized
    // frame can never allocate unbounded buffers (ADR0023).
    const decoded = extractGifFirstFrame(bytes, PROJECT_AGENT_MAX_IMAGE_DECODE_PIXELS);
    if (!decoded.ok) {
      if (decoded.reason === 'frame_pixel_limit_exceeded') {
        throw new ProjectAgentImageReadError(
          'image_decode_limit_exceeded',
          `GIF frame pixel count exceeds the ${PROJECT_AGENT_MAX_IMAGE_DECODE_PIXELS} decode limit`,
        );
      }
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'GIF content could not be decoded safely; the first frame is unavailable',
      );
    }
    const frame = decoded.frame;
    if (frame.interlaced) {
      throw new ProjectAgentImageReadError(
        'unsupported_image_format',
        'Interlaced GIF first frames are not supported',
      );
    }
    // Fit the delivered frame inside the long-edge cap AND the stored-PNG
    // pixel budget so the payload never exceeds the 8MB byte budget.
    const longEdgeScale = maxLongEdge / Math.max(frame.frameWidth, frame.frameHeight);
    const pixelScale = Math.sqrt(
      PROJECT_AGENT_GIF_FRAME_PIXEL_BUDGET / (frame.frameWidth * frame.frameHeight),
    );
    const scale = Math.min(1, longEdgeScale, pixelScale);
    const deliveredWidth = Math.max(1, Math.floor(frame.frameWidth * scale));
    const deliveredHeight = Math.max(1, Math.floor(frame.frameHeight * scale));
    const pixels = scaleRgbaNearest(
      frame.rgba,
      frame.frameWidth,
      frame.frameHeight,
      deliveredWidth,
      deliveredHeight,
    );
    const deliveredBytes = encodePngRgba(pixels, deliveredWidth, deliveredHeight);
    const originalWidth = frame.screenWidth;
    const originalHeight = frame.screenHeight;
    const scaled = deliveredWidth !== originalWidth || deliveredHeight !== originalHeight;
    return Promise.resolve({
      mimeType: 'image/png',
      bytes: deliveredBytes,
      originalWidth,
      originalHeight,
      deliveredWidth,
      deliveredHeight,
      scaled,
      contentFingerprint,
      animated: frame.animated,
      frame: 'first' as const,
    });
  }

  private async resolveReference(reference: string): Promise<{
    absolute: string;
    relative: string;
    scope: 'project' | 'mount';
  }> {
    const project = this.getProject();
    if (reference.startsWith('@mount/')) {
      const rest = reference.slice('@mount/'.length);
      const slashIndex = rest.indexOf('/');
      if (slashIndex <= 0) throw new ProjectAgentPortError('forbidden_path', 'Invalid mount reference');
      const mountId = rest.slice(0, slashIndex);
      const relative = rest.slice(slashIndex + 1);
      const mount = this.getExternalMounts().find((candidate) => candidate.id === mountId);
      if (!mount?.path) throw new ProjectAgentPortError('not_found', 'Mount is not registered');
      return this.containedResolution(mount.path, assertRelativeShape(relative), 'mount');
    }
    if (!project) throw new ProjectAgentPortError('not_found', 'No active project workspace');
    return this.containedResolution(project.rootPath, assertRelativeShape(reference), 'project');
  }

  private async containedResolution(
    root: string,
    relative: string,
    scope: 'project' | 'mount',
  ): Promise<{ absolute: string; relative: string; scope: 'project' | 'mount' }> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.fs.realpath(root);
    } catch {
      throw new ProjectAgentPortError('not_found', 'Registered root is not readable');
    }
    const absolute = await this.fs.join(root, relative);
    let canonical: string;
    try {
      canonical = await this.fs.realpath(absolute);
    } catch {
      const disposition = await this.detectAncestorEscape(absolute, canonicalRoot);
      if (disposition === 'escape') {
        throw new ProjectAgentPortError('forbidden_path', 'Reference resolves outside the registered root');
      }
      throw new ProjectAgentPortError('not_found', 'Image does not exist inside the registered root');
    }
    if (!isCanonicalPathWithinRoot(canonical, canonicalRoot)) {
      throw new ProjectAgentPortError('forbidden_path', 'Reference resolves outside the registered root');
    }
    return { absolute, relative, scope };
  }

  private async detectAncestorEscape(absPath: string, canonicalRoot: string): Promise<'inside' | 'escape'> {
    let current = absPath;
    for (let depth = 0; depth < 64 && current; depth += 1) {
      try {
        const canonical = await this.fs.realpath(current);
        return isCanonicalPathWithinRoot(canonical, canonicalRoot) ? 'inside' : 'escape';
      } catch {
        const forward = current.lastIndexOf('/');
        const backward = current.lastIndexOf('\\');
        const slash = Math.max(forward, backward);
        if (slash <= 0) return 'escape';
        current = current.slice(0, slash);
      }
    }
    return 'escape';
  }
}

function assertRelativeShape(relative: string): string {
  const normalized = relative.replace(/\\/g, '/').trim();
  if (
    normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.startsWith('\\\\')
    || normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new ProjectAgentPortError('forbidden_path', 'Reference must stay inside the registered root');
  }
  return normalized;
}

/** Audio/video container magics: such resources are NEVER image content. */
function isAudioOrVideoContent(head: Uint8Array): boolean {
  const sample = String.fromCharCode(
    head[0] ?? 0,
    head[1] ?? 0,
    head[2] ?? 0,
    head[3] ?? 0,
  );
  return sample === 'RIFF' || sample === 'OggS' || sample === 'fLaC'
    || sample === 'ID3\u0000' || sample === 'MThd';
}

function formatMatches(format: string, declaredMime: string): boolean {  switch (format) {
    case 'png':
      return declaredMime === 'image/png';
    case 'jpeg':
      return declaredMime === 'image/jpeg';
    case 'gif':
      return declaredMime === 'image/gif';
    case 'webp':
      return declaredMime === 'image/webp';
    case 'svg':
      return declaredMime === 'image/svg+xml';
    case 'avif':
      return declaredMime === 'image/avif';
    default:
      return false;
  }
}

/** Deterministic aspect-preserving clamp to the output long-edge cap. */
function fitWithin(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number; scaled: boolean } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height, scaled: false };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scaled: true,
  };
}

/** Deterministic content fingerprint (FNV-1a 64-bit); not cryptographic. */
function fingerprint(bytes: Uint8Array): string {
  let hashLow = 0x84222325;
  let hashHigh = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i += 1) {
    hashLow ^= bytes[i];
    const lo = hashLow >>> 0;
    const hi = hashHigh >>> 0;
    const loProduct = Math.imul(lo, 0x1b3) >>> 0;
    hashLow = loProduct;
    hashHigh = (
      Math.imul(hi, 0x1b3)
      + Math.imul(lo, 0x100)
      + Math.floor((lo * 0x1b3) / 0x100000000)
    ) >>> 0;
  }
  return `fnv1a64:${hashHigh.toString(16).padStart(8, '0')}${hashLow.toString(16).padStart(8, '0')}`;
}
