import { randomBytes, timingSafeEqual, pbkdf2Sync } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const COLLABORATION_LIMITS = {
  jsonBytes: 16 * 1024 * 1024,
  assetBytes: 128 * 1024 * 1024,
  assetUploadMemoryBytes: 256 * 1024 * 1024,
  websocketBytes: 16 * 1024 * 1024,
  textBytes: 64 * 1024,
  clients: 32,
  httpRequests: 8,
  pendingUpdates: 8,
  pendingUpdatesTotal: 32,
  pendingUpdateBytes: 64 * 1024 * 1024,
  pendingUpdateBytesPerSocket: 32 * 1024 * 1024,
  requestTimeoutMs: 30_000,
} as const;

let reservedAssetUploadMemoryBytes = 0;

export class CollaborationRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createCollaborationAccessToken(configured?: string): string {
  if (configured !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(configured)) {
    throw new Error('Collaboration access token must contain 32–128 URL-safe characters');
  }
  return configured ?? randomBytes(32).toString('base64url');
}

export function createCollaborationPassword(): string {
  // 96 bits of entropy in a compact, URL-safe password for easy sharing.
  return randomBytes(12).toString('base64url');
}

export function createCollaborationPasswordSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Reserve the maximum retained upload bytes, including the temporary copy
 * created by Buffer.concat. The lease must be held until the asset is written.
 */
export function reserveCollaborationAssetUploadMemory(bytes: number): (() => void) | null {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > COLLABORATION_LIMITS.assetUploadMemoryBytes) {
    return null;
  }
  if (reservedAssetUploadMemoryBytes + bytes > COLLABORATION_LIMITS.assetUploadMemoryBytes) {
    return null;
  }

  reservedAssetUploadMemoryBytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedAssetUploadMemoryBytes -= bytes;
  };
}

export function collaborationAssetUploadMemoryReservationBytes(contentLength: string | undefined): number {
  if (contentLength === undefined) return COLLABORATION_LIMITS.assetUploadMemoryBytes;
  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    return COLLABORATION_LIMITS.assetUploadMemoryBytes;
  }
  return Math.min(declaredBytes, COLLABORATION_LIMITS.assetBytes) * 2;
}

export function isCollaborationRequestAuthorized(
  request: IncomingMessage,
  expectedToken: string,
  websocket = false,
): boolean {
  let token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
  if (websocket && !token) {
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
    const credentials = protocols.filter((value) => value.startsWith('aeonstagery-auth.'));
    if (credentials.length === 1 && protocols.includes('aeonstagery-collaboration')) {
      token = credentials[0].slice('aeonstagery-auth.'.length);
    }
  }
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Never use the untrusted Host header as the URL parsing base. */
export function parseCollaborationRequestUrl(requestUrl: string | undefined): URL {
  const target = requestUrl ?? '/';
  if (!target.startsWith('/') || target.startsWith('//')) {
    throw new CollaborationRequestError(400, 'Invalid request URL');
  }
  try {
    return new URL(target, 'http://localhost');
  } catch {
    throw new CollaborationRequestError(400, 'Invalid request URL');
  }
}

export async function readCollaborationBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const length = request.headers['content-length'];
  if (length !== undefined && Number(length) > maxBytes) {
    throw new CollaborationRequestError(413, 'Request body exceeds collaboration limit');
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onError = (error: Error): void => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onAborted = (): void => onError(new CollaborationRequestError(400, 'Request aborted'));
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        onError(new CollaborationRequestError(413, 'Request body exceeds collaboration limit'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const timer = setTimeout(() => onError(new CollaborationRequestError(408, 'Request body timed out')), COLLABORATION_LIMITS.requestTimeoutMs);
    timer.unref();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

export function deriveCollaborationPasswordToken(password: string, salt: string): string {
  if (!password) throw new Error('协作密码不能为空');
  if (!/^[0-9a-f]{32}$/.test(salt)) throw new Error('Invalid collaboration password salt');
  return pbkdf2Sync(password, salt, 210_000, 32, 'sha256').toString('hex');
}
