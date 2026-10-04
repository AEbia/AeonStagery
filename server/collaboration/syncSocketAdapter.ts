import { WebSocket, type RawData } from 'ws';
import type {
  CollaborationLeaseClientMessageV2,
  CollaborationLeaseClientMessageV3,
  CollaborationLeaseServerMessageV2,
  CollaborationLeaseServerMessageV3,
  CollaborationPresenceClientMessageV2,
  CollaborationPresenceClientMessageV3,
} from '../../src/api/types/collaboration';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../src/api/types/collaboration';
import {
  applyPresencePingV2,
  connectPresenceSocketV2,
  createPresenceIdentity,
  disconnectPresenceSocketV2,
  handlePresenceSocketMessageV2,
  type PresenceRegistryV2,
} from './presence';
import type { CollaborationAssetStore } from './assets';
import {
  validateCollaborativeAssetAvailabilityV2,
  validateCollaborativeAssetAvailabilityV3,
} from './assetAvailability';
import {
  assertCollaborationProjectId,
  SingleRoomCollaborationRoomV2,
  SingleRoomCollaborationRoomV3,
  validateCollaborativeSceneCodecV2,
  validateCollaborativeSceneCodecV3,
} from './room';
import {
  acquireCollaborationLeaseV2,
  createCollaborationLeaseRegistryV2,
  expireCollaborationLeasesV2,
  releaseAllCollaborationLeasesV2,
  releaseCollaborationLeaseV2,
  renewCollaborationLeaseV2,
  type CollaborationLeaseRegistryV2,
} from './lease';
import { isCollaborationLeaseClientMessage } from '../../src/services/collaboration/CollaborationLeaseProtocol';

function createLeaseRegistry(): CollaborationLeaseRegistryV2<WebSocket> {
  return createCollaborationLeaseRegistryV2<WebSocket>();
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  throw new Error('Unsupported WebSocket payload');
}

function rawDataToUtf8(data: RawData): string {
  return Buffer.from(rawDataToUint8Array(data)).toString('utf8');
}

export interface CollaborationSyncSocketAdapterV2Options {
  clients: Set<WebSocket>;
  room: SingleRoomCollaborationRoomV2 | SingleRoomCollaborationRoomV3;
  assets: CollaborationAssetStore;
  presence: PresenceRegistryV2<WebSocket>;
  leases?: CollaborationLeaseRegistryV2<WebSocket>;
  schemaVersion?: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3;
  expectedProjectId?: string;
}

export class CollaborationSyncSocketAdapterV2 {
  private static readonly PING_INTERVAL_MS = 3000;
  private static readonly PING_TIMEOUT_MS = 9000;
  private readonly clients: Set<WebSocket>;
  private readonly room: SingleRoomCollaborationRoomV2 | SingleRoomCollaborationRoomV3;
  private readonly assets: CollaborationAssetStore;
  private readonly presence: PresenceRegistryV2<WebSocket>;
  private readonly leases: CollaborationLeaseRegistryV2<WebSocket>;
  private readonly schemaVersion: typeof COLLABORATION_SCHEMA_VERSION_V2 | typeof COLLABORATION_SCHEMA_VERSION_V3;
  private readonly expectedProjectId?: string;
  private readonly pingTimers = new Map<WebSocket, ReturnType<typeof setInterval>>();
  private readonly pingStartedAt = new Map<WebSocket, number>();
  private readonly leaseExpiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CollaborationSyncSocketAdapterV2Options) {
    this.clients = options.clients;
    this.room = options.room;
    this.assets = options.assets;
    this.presence = options.presence;
    this.schemaVersion = options.schemaVersion ?? (
      options.room instanceof SingleRoomCollaborationRoomV3
        ? COLLABORATION_SCHEMA_VERSION_V3
        : COLLABORATION_SCHEMA_VERSION_V2
    );
    this.expectedProjectId = options.expectedProjectId;
    this.leases = options.leases ?? createLeaseRegistry();
    this.leaseExpiryTimer = setInterval(() => {
      const expired = expireCollaborationLeasesV2(this.leases);
      for (const record of expired) {
        this.broadcastJson({ type: 'lease:released', schemaVersion: this.schemaVersion, target: record.target });
      }
    }, 5000);
    this.leaseExpiryTimer.unref?.();
  }

  connect(socket: WebSocket, requestUrl: string | undefined, host: string | undefined): void {
    this.clients.add(socket);
    socket.send(Buffer.from(this.room.encodeStateAsUpdate()));

    const url = new URL(requestUrl ?? '/', `http://${host ?? 'localhost'}`);
    const connection = connectPresenceSocketV2(this.presence, socket, createPresenceIdentity(url), this.schemaVersion);
    for (const message of connection.socketMessages) {
      socket.send(JSON.stringify(message));
    }
    for (const message of connection.broadcastMessages) {
      this.broadcastJson(message);
    }

    this.startPingMonitoring(socket);

    socket.on('message', (data, isBinary) => {
      this.handleMessage(socket, data, isBinary);
    });

    socket.on('close', () => {
      this.stopPingMonitoring(socket);
      this.clients.delete(socket);
      const disconnection = disconnectPresenceSocketV2(this.presence, socket, this.schemaVersion);
      for (const message of disconnection.broadcastMessages) {
        this.broadcastJson(message);
      }
      const released = releaseAllCollaborationLeasesV2(this.leases, socket);
      for (const record of released) {
        this.broadcastJson({ type: 'lease:released', schemaVersion: this.schemaVersion, target: record.target });
      }
    });
  }

  private startPingMonitoring(socket: WebSocket): void {
    if (typeof socket.ping !== 'function') return;
    const measure = (): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const pendingSince = this.pingStartedAt.get(socket);
      if (pendingSince !== undefined) {
        if (Date.now() - pendingSince >= CollaborationSyncSocketAdapterV2.PING_TIMEOUT_MS) {
          this.stopPingMonitoring(socket);
          socket.terminate();
        }
        return;
      }
      this.pingStartedAt.set(socket, Date.now());
      try {
        socket.ping();
      } catch {
        this.pingStartedAt.delete(socket);
      }
    };

    socket.on('pong', () => {
      const startedAt = this.pingStartedAt.get(socket);
      if (startedAt === undefined) return;
      this.pingStartedAt.delete(socket);
      const update = applyPresencePingV2(this.presence, socket, Date.now() - startedAt, this.schemaVersion);
      if (update) this.broadcastJson(update);
    });
    measure();
    const timer = setInterval(measure, CollaborationSyncSocketAdapterV2.PING_INTERVAL_MS);
    timer.unref?.();
    this.pingTimers.set(socket, timer);
  }

  private stopPingMonitoring(socket: WebSocket): void {
    const timer = this.pingTimers.get(socket);
    if (timer) clearInterval(timer);
    this.pingTimers.delete(socket);
    this.pingStartedAt.delete(socket);
  }

  private handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    let message: CollaborationPresenceClientMessageV2 | CollaborationPresenceClientMessageV3 | undefined;
    if (!isBinary) {
      try {
        message = JSON.parse(rawDataToUtf8(data));
      } catch {
        return;
      }
    }

    const presenceResult = handlePresenceSocketMessageV2(
      this.presence,
      socket,
      isBinary,
      message,
      this.schemaVersion,
    );
    for (const socketMessage of presenceResult.socketMessages) {
      socket.send(JSON.stringify(socketMessage));
    }
    for (const broadcastMessage of presenceResult.broadcastMessages) {
      this.broadcastJson(broadcastMessage);
    }
    if (presenceResult.handled) return;

    if (!isBinary) {
      let leaseMessage: unknown;
      try {
        leaseMessage = JSON.parse(rawDataToUtf8(data));
      } catch {
        return;
      }
      if (isCollaborationLeaseClientMessage(leaseMessage)) {
        const responses = this.handleLeaseMessage(socket, leaseMessage);
        for (const response of responses) {
          socket.send(JSON.stringify(response));
        }
        return;
      }
    }

    const update = rawDataToUint8Array(data);
    const applyPromise = this.room instanceof SingleRoomCollaborationRoomV3
      ? this.room.applyUpdate(
          update,
          async (state) => {
            assertCollaborationProjectId(state.collaborationProjectId, this.expectedProjectId);
            validateCollaborativeSceneCodecV3(state);
            await validateCollaborativeAssetAvailabilityV3(state, this.assets);
          },
        )
      : this.room.applyUpdate(
          update,
          async (state) => {
            assertCollaborationProjectId(state.collaborationProjectId, this.expectedProjectId);
            validateCollaborativeSceneCodecV2(state);
            await validateCollaborativeAssetAvailabilityV2(state, this.assets);
          },
        );

    void applyPromise.then(() => {
      this.broadcastBinary(update, socket);
    }).catch((error: any) => {
      const message = error?.message || String(error);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'collaboration:error', message }));
      }
    });
  }

  private handleLeaseMessage(
    socket: WebSocket,
    leaseMessage: CollaborationLeaseClientMessageV2 | CollaborationLeaseClientMessageV3,
  ): Array<CollaborationLeaseServerMessageV2 | CollaborationLeaseServerMessageV3> {
    const peer = this.presence.peersBySocket.get(socket);
    if (!peer) return [];
    if (leaseMessage.schemaVersion !== this.schemaVersion) return [];
    const clientId = peer.clientId;
    const { requestId, target } = leaseMessage;
    const schemaVersion = this.schemaVersion;

    switch (leaseMessage.type) {
      case 'lease:acquire': {
        const result = acquireCollaborationLeaseV2(this.leases, socket, clientId, requestId, target);
        if (result.granted) {
          return [{ type: 'lease:acquired', schemaVersion, requestId, target } as any];
        }
        return [{ type: 'lease:denied', schemaVersion, requestId, target, heldByClientId: result.heldByClientId } as any];
      }
      case 'lease:renew': {
        const renewed = renewCollaborationLeaseV2(this.leases, socket, clientId, requestId, target);
        return renewed
          ? [{ type: 'lease:acquired', schemaVersion, requestId, target } as any]
          : [];
      }
      case 'lease:release': {
        releaseCollaborationLeaseV2(this.leases, socket, clientId, target);
        return [];
      }
    }
  }

  private broadcastJson(message: unknown): void {
    const json = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  private broadcastBinary(update: Uint8Array, sender: WebSocket): void {
    for (const client of this.clients) {
      if (client !== sender && client.readyState === WebSocket.OPEN) {
        client.send(Buffer.from(update));
      }
    }
  }
}
