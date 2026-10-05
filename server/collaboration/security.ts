import { createHmac, randomBytes, timingSafeEqual, pbkdf2Sync } from 'node:crypto';
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
  authenticationFailures: 5,
  authenticationFailureWindowMs: 60_000,
  authenticationBlockMs: 60_000,
  authenticationTrackedAddresses: 4_096,
  authenticationChallengeTtlMs: 30_000,
  authenticationPendingChallenges: 4_096,
} as const;

let reservedAssetUploadMemoryBytes = 0;

export class CollaborationRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface PendingAuthenticationChallenge {
  address: string;
  expiresAt: number;
}

/** Issues short-lived, single-use challenges so remote peers never send the bearer secret. */
export class CollaborationAuthChallengeStore {
  private readonly pending = new Map<string, PendingAuthenticationChallenge>();

  issue(address: string, now = Date.now()): string {
    for (const [nonce, challenge] of this.pending) {
      if (challenge.expiresAt > now) break;
      this.pending.delete(nonce);
    }
    if (this.pending.size >= COLLABORATION_LIMITS.authenticationPendingChallenges) {
      throw new CollaborationRequestError(503, 'Collaboration authentication is busy');
    }

    const nonce = randomBytes(32).toString('base64url');
    this.pending.set(nonce, {
      address,
      expiresAt: now + COLLABORATION_LIMITS.authenticationChallengeTtlMs,
    });
    return nonce;
  }

  consume(address: string, nonce: string, now = Date.now()): boolean {
    const challenge = this.pending.get(nonce);
    if (!challenge) return false;
    this.pending.delete(nonce);
    return challenge.address === address && challenge.expiresAt > now;
  }
}

interface AuthenticationFailureWindow {
  startedAt: number;
  failures: number;
  blockedUntil: number;
}

/** Bounds online credential guessing by the source address. */
export class CollaborationAuthRateLimiter {
  private readonly addresses = new Map<string, AuthenticationFailureWindow>();

  isBlocked(address: string, now = Date.now()): boolean {
    const window = this.addresses.get(address);
    if (!window) return false;
    if (window.blockedUntil > now) return true;
    if (now - window.startedAt >= COLLABORATION_LIMITS.authenticationFailureWindowMs) {
      this.addresses.delete(address);
    }
    return false;
  }

  recordFailure(address: string, now = Date.now()): boolean {
    let window = this.addresses.get(address);
    if (!window || now - window.startedAt >= COLLABORATION_LIMITS.authenticationFailureWindowMs) {
      window = { startedAt: now, failures: 0, blockedUntil: 0 };
      this.addresses.delete(address);
    }
    window.failures++;
    if (window.failures >= COLLABORATION_LIMITS.authenticationFailures) {
      window.blockedUntil = now + COLLABORATION_LIMITS.authenticationBlockMs;
    }
    this.addresses.delete(address);
    this.addresses.set(address, window);
    while (this.addresses.size > COLLABORATION_LIMITS.authenticationTrackedAddresses) {
      const oldestAddress = this.addresses.keys().next().value;
      if (oldestAddress === undefined) break;
      this.addresses.delete(oldestAddress);
    }
    return window.blockedUntil > now;
  }

  recordSuccess(address: string): void {
    this.addresses.delete(address);
  }
}

export function createCollaborationAuthProof(
  secret: string,
  nonce: string,
  method: string,
  requestTarget: string,
): string {
  return createHmac('sha256', secret)
    .update(`${nonce}\n${method.toUpperCase()}\n${requestTarget}`)
    .digest('hex');
}

export function hasCollaborationAuthenticationAttempt(request: IncomingMessage, websocket = false): boolean {
  if (
    request.headers.authorization !== undefined
    || request.headers['x-collaboration-nonce'] !== undefined
    || request.headers['x-collaboration-proof'] !== undefined
  ) return true;
  if (!websocket) return false;

  const protocols = request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
  if (protocols.some((value) => value.startsWith('aeonstagery-auth.'))) return true;
  try {
    const url = parseCollaborationRequestUrl(request.url);
    return url.searchParams.has('authNonce') || url.searchParams.has('authProof');
  } catch {
    return false;
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
  challenges: CollaborationAuthChallengeStore,
  websocket = false,
): boolean {
  const remoteAddress = request.socket.remoteAddress ?? '';
  const isLoopback = remoteAddress === '::1'
    || remoteAddress.startsWith('127.')
    || remoteAddress.startsWith('::ffff:127.');

  // Keep the old local IPC path working. Remote connections must use a one-time proof.
  let token = isLoopback
    ? request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]
    : undefined;
  if (websocket && !token) {
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
    const credentials = protocols.filter((value) => value.startsWith('aeonstagery-auth.'));
    if (isLoopback && credentials.length === 1 && protocols.includes('aeonstagery-collaboration')) {
      token = credentials[0].slice('aeonstagery-auth.'.length);
    }
  }
  if (token) {
    const actual = Buffer.from(token);
    const expected = Buffer.from(expectedToken);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }

  let nonce: string | undefined;
  let proof: string | undefined;
  let requestTarget: string;
  if (websocket) {
    try {
      const url = parseCollaborationRequestUrl(request.url);
      const nonces = url.searchParams.getAll('authNonce');
      const proofs = url.searchParams.getAll('authProof');
      if (nonces.length !== 1 || proofs.length !== 1) return false;
      [nonce] = nonces;
      [proof] = proofs;
      url.searchParams.delete('authNonce');
      url.searchParams.delete('authProof');
      requestTarget = `${url.pathname}${url.search}`;
    } catch {
      return false;
    }
  } else {
    const nonceHeader = request.headers['x-collaboration-nonce'];
    const proofHeader = request.headers['x-collaboration-proof'];
    if (Array.isArray(nonceHeader) || Array.isArray(proofHeader)) return false;
    nonce = nonceHeader;
    proof = proofHeader;
    requestTarget = request.url ?? '/';
  }
  if (
    typeof nonce !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(nonce)
    || typeof proof !== 'string'
    || !/^[0-9a-f]{64}$/.test(proof)
    || !challenges.consume(remoteAddress, nonce)
  ) return false;

  const expectedProof = Buffer.from(createCollaborationAuthProof(
    expectedToken,
    nonce,
    request.method ?? 'GET',
    requestTarget,
  ));
  const actualProof = Buffer.from(proof);
  return actualProof.length === expectedProof.length && timingSafeEqual(actualProof, expectedProof);
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
