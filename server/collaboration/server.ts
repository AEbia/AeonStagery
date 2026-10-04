import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import {
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
}

export interface CollaborationServerStatus {
  running: boolean;
  host: string;
  port: number;
  dataDir: string;
  localUrl: string;
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
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  response.end(json);
}

function sendBinary(response: ServerResponse, status: number, body: Uint8Array): void {
  response.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/octet-stream',
    'content-length': body.byteLength,
  });
  response.end(Buffer.from(body));
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function sendCorsPreflight(response: ServerResponse): void {
  response.writeHead(204, corsHeaders());
  response.end();
}

function httpStatusForError(error: unknown): number {
  if (error instanceof CollaborativeAssetAvailabilityError) return 422;
  if (error instanceof CollaborationProjectMismatchError) return 409;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('already has persisted state') ? 409 : 500;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

async function readBinaryBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function getAssetPath(pathname: string): string | null {
  const prefix = '/assets/';
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded) return null;
  return decodeURIComponent(encoded);
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
  if (!Number.isFinite(options.port) || options.port < 0) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (options.expectedProjectId !== undefined && !options.expectedProjectId.trim()) {
    throw new Error('Expected project ID must not be empty');
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

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (request.method === 'OPTIONS') {
        sendCorsPreflight(response);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          hasState: room.hasState(),
          dataDir: options.dataDir,
          assetRoot: assets.rootDir,
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
        await assets.writeAsset(assetPath, await readBinaryBody(request));
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
            throw new Error(`Collaboration room v3 expected schema version ${COLLABORATION_SCHEMA_VERSION_V3}`);
          }
          assertCollaborationProjectId(state.collaborationProjectId, options.expectedProjectId);
          await validateCollaborativeAssetAvailabilityV3(state, assets);
          await room.seed(state);
        } else {
          const state = await readJsonBody<CollaborativeSceneStateV2>(request);
          if (state.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2) {
            throw new Error(`Collaboration room v2 expected schema version ${COLLABORATION_SCHEMA_VERSION_V2}`);
          }
          assertCollaborationProjectId(state.collaborationProjectId, options.expectedProjectId);
          await validateCollaborativeAssetAvailabilityV2(state, assets);
          await room.seed(state);
        }
        sendJson(response, 201, { ok: true });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error: any) {
      const message = error?.message || String(error);
      sendJson(response, httpStatusForError(error), { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
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
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/sync') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
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
      assetRoot: assets.rootDir,
      hasState: room.hasState(),
      schemaVersion,
    }),
    stop: async () => {
      if (!running) return;
      running = false;
      for (const client of clients) {
        client.close();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
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
