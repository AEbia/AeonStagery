import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import {
  CollaborationAuthChallengeStore,
  CollaborationAuthRateLimiter,
  COLLABORATION_LIMITS,
  CollaborationRequestError,
  createCollaborationAccessToken,
  createCollaborationPassword,
  createCollaborationPasswordSalt,
  deriveCollaborationPasswordToken,
  collaborationAssetUploadMemoryReservationBytes,
  hasCollaborationAuthenticationAttempt,
  isCollaborationRequestAuthorized,
  parseCollaborationRequestUrl,
  readCollaborationBody,
  reserveCollaborationAssetUploadMemory,
} from './security';
import { withCollaborationAccessToken } from '../../src/services/collaboration/CollaborationTransport';
import { WebSocket, WebSocketServer } from 'ws';
import {
  assertCollaborativeSceneStateV2,
  assertCollaborativeSceneStateV3,
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV2,
  type CollaborativeSceneStateV3,
} from '../../src/api/types/collaboration';
import {
  CollaborativeAssetAvailabilityError,
  validateCollaborativeAssetAvailabilityV2,
  validateCollaborativeAssetAvailabilityV3,
} from './assetAvailability';
import { CollaborationAssetStore } from './assets';
import { CollaborationPersistence } from './persistence';
import {
  createPresenceRegistryV2,
} from './presence';
import {
  createCollaborationLeaseRegistryV2,
} from './lease';
import {
  assertCollaborationProjectId,
  CollaborationProjectMismatchError,
  SingleRoomCollaborationRoomV2,
  SingleRoomCollaborationRoomV3,
} from './room';
import {
  CollaborationSyncSocketAdapterV2,
} from './syncSocketAdapter';

export interface CollaborationServerOptions {
  host: string;
  port: number;
  dataDir: string;
  schemaVersion?: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3;
  expectedProjectId?: string;
  accessToken?: string;
  password?: string;
  allowedOrigins?: string[];
}

export interface CollaborationServerStatus {
  running: boolean;
  host: string;
  port: number;
  dataDir: string;
  localUrl: string;
  accessToken: string;
  connectionPassword?: string;
  inviteUrls: string[];
  lanUrls: string[];
  assetRoot: string;
  hasState: boolean;
  schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3;
}

export interface RunningCollaborationServer {
  getStatus(): CollaborationServerStatus;
  stop(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  response.end(json);
}

function sendBinary(response: ServerResponse, status: number, body: Uint8Array): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'application/octet-stream',
    'content-length': body.byteLength,
  });
  response.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
}

function httpStatusForError(error: unknown): number {
  if (error instanceof CollaborationRequestError) return error.status;
  if (error instanceof CollaborativeAssetAvailabilityError) return 422;
  if (error instanceof CollaborationProjectMismatchError) return 409;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('already has persisted state') ? 409 : 500;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const body = await readCollaborationBody(request, COLLABORATION_LIMITS.jsonBytes);
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected an object');
    }
    return parsed as T;
  } catch {
    throw new CollaborationRequestError(400, 'Invalid JSON request body');
  }
}

function getAssetPath(pathname: string): string | null {
  const prefix = '/assets/';
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new CollaborationRequestError(400, 'Invalid asset URL encoding');
  }
}

function getLanUrls(port: number, host: string): string[] {
  if (host !== '0.0.0.0' && host !== '::') {
    return [`http://${host}:${port}`];
  }

  const urls: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

export async function startCollaborationServer(options: CollaborationServerOptions): Promise<RunningCollaborationServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (options.expectedProjectId !== undefined && !options.expectedProjectId.trim()) {
    throw new Error('Expected project ID must not be empty');
  }

  if (options.password !== undefined && options.accessToken !== undefined) {
    throw new Error('Configure either a collaboration password or an access token');
  }
  const connectionPassword = options.accessToken !== undefined ? undefined
    : options.password || createCollaborationPassword();
  const passwordSalt = createCollaborationPasswordSalt();
  const accessToken = connectionPassword !== undefined
    ? deriveCollaborationPasswordToken(connectionPassword, passwordSalt)
    : createCollaborationAccessToken(options.accessToken);
  const allowedOrigins = new Set(options.allowedOrigins ?? ['null', 'http://localhost:5173', 'http://127.0.0.1:5173']);
  if (options.schemaVersion !== undefined && options.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2
    && options.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3) {
    throw new Error('Unsupported collaboration schema version');
  }
  const persistence = new CollaborationPersistence(options.dataDir);
  const assets = new CollaborationAssetStore(options.dataDir);
  const schemaVersion = options.schemaVersion ?? COLLABORATION_SCHEMA_VERSION_V3;
  const room: SingleRoomCollaborationRoomV2 | SingleRoomCollaborationRoomV3 =
    schemaVersion === COLLABORATION_SCHEMA_VERSION_V3
      ? new SingleRoomCollaborationRoomV3(persistence)
      : new SingleRoomCollaborationRoomV2(persistence);

  await assets.ensure();
  await room.load();
  if (options.expectedProjectId !== undefined) {
    const savedState = room.getState();
    if (savedState) {
      assertCollaborationProjectId(savedState.collaborationProjectId, options.expectedProjectId);
    } else if (await persistence.hasPersistedState()) {
      throw new Error('Persisted collaboration room state could not be read');
    }
  }

  let activeRequests = 0;
  const authChallenges = new CollaborationAuthChallengeStore();
  const authRateLimiter = new CollaborationAuthRateLimiter();
  const server = http.createServer(async (request, response) => {
    const remoteAddress = request.socket.remoteAddress ?? '';
    response.setHeader('cache-control', 'no-store');
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
      response.setHeader('access-control-allow-headers', 'content-type, authorization, x-collaboration-nonce, x-collaboration-proof');
    }
    if (activeRequests >= COLLABORATION_LIMITS.httpRequests) {
      response.setHeader('connection', 'close');
      sendJson(response, 503, { error: 'Collaboration server is busy' });
      return;
    }
    activeRequests++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activeRequests--;
    };
    response.once('finish', release);
    response.once('close', release);
    try {
      const url = parseCollaborationRequestUrl(request.url);
      if (origin && !allowedOrigins.has(origin)) {
        throw new CollaborationRequestError(403, 'Collaboration origin is not allowed');
      }

      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (authRateLimiter.isBlocked(remoteAddress)) {
        response.setHeader('retry-after', String(Math.ceil(COLLABORATION_LIMITS.authenticationBlockMs / 1000)));
        throw new CollaborationRequestError(429, 'Too many failed collaboration authentication attempts');
      }

      if (request.method === 'GET' && url.pathname === '/auth/salt') {
        sendJson(response, 200, { salt: passwordSalt });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/auth/challenge') {
        sendJson(response, 200, { nonce: authChallenges.issue(remoteAddress) });
        return;
      }

      if (!isCollaborationRequestAuthorized(request, accessToken, authChallenges)) {
        response.setHeader('www-authenticate', 'Bearer');
        if (
          hasCollaborationAuthenticationAttempt(request)
          && authRateLimiter.recordFailure(remoteAddress)
        ) {
          response.setHeader('retry-after', String(Math.ceil(COLLABORATION_LIMITS.authenticationBlockMs / 1000)));
          throw new CollaborationRequestError(429, 'Too many failed collaboration authentication attempts');
        }
        throw new CollaborationRequestError(401, 'Collaboration access token is required');
      }
      authRateLimiter.recordSuccess(remoteAddress);

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          hasState: room.hasState(),
          schemaVersion,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/state') {
        const state = room.getState();
        if (!state) {
          sendJson(response, 404, { error: 'Room has not been seeded' });
          return;
        }
        sendJson(response, 200, state);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/snapshot') {
        const snapshot = room.getMaterializedSceneDocument();
        if (!snapshot) {
          sendJson(response, 404, { error: 'Room has not been seeded' });
          return;
        }
        sendJson(response, 200, snapshot);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/yjs-state') {
        sendBinary(response, 200, room.encodeStateAsUpdate());
        return;
      }

      const assetPath = getAssetPath(url.pathname);
      if (assetPath && request.method === 'PUT') {
        const contentLength = request.headers['content-length'];
        if (contentLength !== undefined && Number(contentLength) > COLLABORATION_LIMITS.assetBytes) {
          throw new CollaborationRequestError(413, 'Request body exceeds collaboration limit');
        }
        const releaseUploadMemory = reserveCollaborationAssetUploadMemory(
          collaborationAssetUploadMemoryReservationBytes(contentLength),
        );
        if (!releaseUploadMemory) {
          throw new CollaborationRequestError(503, 'Collaboration upload memory budget is full');
        }
        try {
          const body = await readCollaborationBody(request, COLLABORATION_LIMITS.assetBytes);
          await assets.writeAsset(assetPath, body);
        } finally {
          releaseUploadMemory();
        }
        sendJson(response, 201, { ok: true, path: assetPath });
        return;
      }

      if (assetPath && request.method === 'GET') {
        try {
          sendBinary(response, 200, await assets.readAsset(assetPath));
        } catch {
          sendJson(response, 404, { error: 'Asset not found' });
        }
        return;
      }

      if (request.method === 'POST' && url.pathname === '/seed') {
        if (room instanceof SingleRoomCollaborationRoomV3) {
          const state = await readJsonBody<CollaborativeSceneStateV3>(request);
          if (state.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3) {
            throw new CollaborationRequestError(400, `Collaboration room v3 expected schema version ${COLLABORATION_SCHEMA_VERSION_V3}`);
          }
          try { assertCollaborativeSceneStateV3(state); }
          catch { throw new CollaborationRequestError(400, 'Invalid collaboration state'); }
          assertCollaborationProjectId(state.collaborationProjectId, options.expectedProjectId);
          await validateCollaborativeAssetAvailabilityV3(state, assets);
          await room.seed(state);
        } else {
          const state = await readJsonBody<CollaborativeSceneStateV2>(request);
          if (state.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2) {
            throw new CollaborationRequestError(400, `Collaboration room v2 expected schema version ${COLLABORATION_SCHEMA_VERSION_V2}`);
          }
          try { assertCollaborativeSceneStateV2(state); }
          catch { throw new CollaborationRequestError(400, 'Invalid collaboration state'); }
          assertCollaborationProjectId(state.collaborationProjectId, options.expectedProjectId);
          await validateCollaborativeAssetAvailabilityV2(state, assets);
          await room.seed(state);
        }
        sendJson(response, 201, { ok: true });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const status = httpStatusForError(error);
      const message = status === 500 ? 'Internal collaboration server error'
        : error instanceof Error ? error.message : 'Invalid collaboration request';
      response.setHeader('connection', 'close');
      sendJson(response, status, { error: message });
    }
  });

  server.requestTimeout = COLLABORATION_LIMITS.requestTimeoutMs;
  server.headersTimeout = 10_000;
  server.maxConnections = 128;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: COLLABORATION_LIMITS.websocketBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has('aeonstagery-collaboration') ? 'aeonstagery-collaboration' : false,
  });
  const clients = new Set<WebSocket>();
  const syncSocketAdapter = new CollaborationSyncSocketAdapterV2({
    clients,
    room,
    assets,
    presence: createPresenceRegistryV2<WebSocket>(),
    leases: createCollaborationLeaseRegistryV2<WebSocket>(),
    schemaVersion,
    expectedProjectId: options.expectedProjectId,
  });

  wss.on('connection', (socket, request) => {
    syncSocketAdapter.connect(socket, request.url, request.headers.host);
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      const remoteAddress = request.socket.remoteAddress ?? '';
      const url = parseCollaborationRequestUrl(request.url);
      if (url.pathname !== '/sync') throw new CollaborationRequestError(404, 'Not found');
      if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
        throw new CollaborationRequestError(403, 'Origin not allowed');
      }
      if (authRateLimiter.isBlocked(remoteAddress)) {
        throw new CollaborationRequestError(429, 'Too many failed collaboration authentication attempts');
      }
      if (!isCollaborationRequestAuthorized(request, accessToken, authChallenges, true)) {
        if (
          hasCollaborationAuthenticationAttempt(request, true)
          && authRateLimiter.recordFailure(remoteAddress)
        ) {
          throw new CollaborationRequestError(429, 'Too many failed collaboration authentication attempts');
        }
        throw new CollaborationRequestError(401, 'Unauthorized');
      }
      authRateLimiter.recordSuccess(remoteAddress);
      url.searchParams.delete('authNonce');
      url.searchParams.delete('authProof');
      request.url = `${url.pathname}${url.search}`;
      if (wss.clients.size >= COLLABORATION_LIMITS.clients) {
        throw new CollaborationRequestError(503, 'Too many clients');
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (error) {
      const code = error instanceof CollaborationRequestError ? error.status : 400;
      socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  let running = true;

  const handle: RunningCollaborationServer = {
    getStatus: () => ({
      running,
      host: options.host,
      port: actualPort,
      dataDir: options.dataDir,
      localUrl: `http://127.0.0.1:${actualPort}`,
      lanUrls: getLanUrls(actualPort, options.host),
      accessToken,
      connectionPassword,
      inviteUrls: (getLanUrls(actualPort, options.host).length > 0
        ? getLanUrls(actualPort, options.host)
        : [`http://127.0.0.1:${actualPort}`]).map((url) => withCollaborationAccessToken(url, accessToken)),
      assetRoot: assets.rootDir,
      hasState: room.hasState(),
      schemaVersion,
    }),
    stop: async () => {
      if (!running) return;
      running = false;
      for (const client of wss.clients) {
        client.terminate();
      }
      syncSocketAdapter.dispose();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };

  return handle;
}
