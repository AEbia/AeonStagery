import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { CollaborationAssetStore } from '../../server/collaboration/assets';
import { CollaborationPersistence } from '../../server/collaboration/persistence';
import { createPresenceRegistryV2 } from '../../server/collaboration/presence';
import { SingleRoomCollaborationRoomV2 } from '../../server/collaboration/room';
import { CollaborationSyncSocketAdapterV2 } from '../../server/collaboration/syncSocketAdapter';
import { createCollaborationLeaseRegistryV2, encodeCollaborationLeaseTargetV2 } from '../../server/collaboration/lease';

type MessageHandler = (data: Buffer, isBinary: boolean) => void;
type CloseHandler = () => void;
type PongHandler = () => void;

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  private messageHandler: MessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  private pongHandler: PongHandler | null = null;

  send = vi.fn((data: unknown) => {
    this.sent.push(data);
  });

  close = vi.fn((_code: number, _reason: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emitClose();
  });

  ping = vi.fn(() => {
    this.pongHandler?.();
  });

  on(event: 'message' | 'close' | 'pong', handler: MessageHandler | CloseHandler | PongHandler): void {
    if (event === 'message') this.messageHandler = handler as MessageHandler;
    if (event === 'close') this.closeHandler = handler as CloseHandler;
    if (event === 'pong') this.pongHandler = handler as PongHandler;
  }

  emitMessage(data: Uint8Array | string, isBinary: boolean): void {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    this.messageHandler?.(payload, isBinary);
  }

  emitClose(): void {
    this.closeHandler?.();
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function makeStateV2(): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: { title: 'Seeded Scene V2', fps: 60 },
    statementsById: {
      perf_1: {
        id: 'perf_1',
        time: 1,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          motion: { kind: 'resource', key: 'wave' },
        },
      },
    },
    statementOrder: ['perf_1'],
  };
}

function connect(adapter: CollaborationSyncSocketAdapterV2, clientId: string): FakeSocket {
  const socket = new FakeSocket();
  adapter.connect(asWebSocket(socket), `/sync?clientId=${clientId}&displayName=${clientId}`, 'localhost');
  return socket;
}

describe('collaboration scoped edit lease (ADR-0028)', () => {
  let tempDir: string;
  let room: SingleRoomCollaborationRoomV2;
  let assets: CollaborationAssetStore;
  let adapter: CollaborationSyncSocketAdapterV2;
  let clients: Set<WebSocket>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-lease-'));
    const persistence = new CollaborationPersistence(tempDir);
    room = new SingleRoomCollaborationRoomV2(persistence);
    assets = new CollaborationAssetStore(tempDir);
    await assets.ensure();
    await room.seed(makeStateV2());
    clients = new Set<WebSocket>();
    adapter = new CollaborationSyncSocketAdapterV2({
      clients,
      room,
      assets,
      presence: createPresenceRegistryV2<WebSocket>(),
      leases: createCollaborationLeaseRegistryV2<WebSocket>(),
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function acquire(socket: FakeSocket, requestId: string, target: unknown): void {
    socket.emitMessage(JSON.stringify({
      type: 'lease:acquire',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      requestId,
      target,
    }), false);
  }

  function renew(socket: FakeSocket, requestId: string, target: unknown): void {
    socket.emitMessage(JSON.stringify({
      type: 'lease:renew',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      requestId,
      target,
    }), false);
  }

  function release(socket: FakeSocket, requestId: string, target: unknown): void {
    socket.emitMessage(JSON.stringify({
      type: 'lease:release',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      requestId,
      target,
    }), false);
  }

  function jsonMessages(socket: FakeSocket): unknown[] {
    return socket.sent
      .map((entry) => {
        const text = typeof entry === 'string' ? entry : Buffer.isBuffer(entry) ? entry.toString('utf8') : null;
        if (text === null) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
  }

  function findMessage(socket: FakeSocket, type: string): Record<string, unknown> | undefined {
    return jsonMessages(socket).find(
      (message) => (message as Record<string, unknown>).type === type,
    ) as Record<string, unknown> | undefined;
  }

  it('adjudicates a single holder per characterPerformance entity', () => {
    const alice = connect(adapter, 'alice');
    const bob = connect(adapter, 'bob');
    const target = { kind: 'statement', statementId: 'perf_1' };

    acquire(alice, 'req-alice', target);
    const acquired = findMessage(alice, 'lease:acquired');
    expect(acquired?.target).toEqual(target);

    acquire(bob, 'req-bob', target);
    const denied = findMessage(bob, 'lease:denied');
    expect(denied?.heldByClientId).toBe('alice');
  });

  it('allows the same client to renew its lease', () => {
    const alice = connect(adapter, 'alice');
    const target = { kind: 'statement', statementId: 'perf_1' };

    acquire(alice, 'req-alice', target);
    expect(findMessage(alice, 'lease:acquired')).toBeTruthy();

    renew(alice, 'req-alice', target);
    const renewed = jsonMessages(alice).filter((m) => (m as Record<string, unknown>).type === 'lease:acquired');
    expect(renewed.length).toBeGreaterThanOrEqual(2);
  });

  it('releases the lease on explicit release and frees the entity', () => {
    const alice = connect(adapter, 'alice');
    const bob = connect(adapter, 'bob');
    const target = { kind: 'statement', statementId: 'perf_1' };

    acquire(alice, 'req-alice', target);
    release(alice, 'req-alice', target);

    acquire(bob, 'req-bob', target);
    expect(findMessage(bob, 'lease:acquired')).toBeTruthy();
  });

  it.each([COLLABORATION_SCHEMA_VERSION_V2, COLLABORATION_SCHEMA_VERSION_V3] as const)(
    'keeps new ownership when late cancellation releases the previous request in protocol V%s',
    (schemaVersion) => {
      const leases = createCollaborationLeaseRegistryV2<WebSocket>();
      const correlatedAdapter = new CollaborationSyncSocketAdapterV2({
        clients: new Set<WebSocket>(), room, assets, schemaVersion,
        presence: createPresenceRegistryV2<WebSocket>(), leases,
      });
      const alice = connect(correlatedAdapter, 'alice');
      const bob = connect(correlatedAdapter, 'bob');
      const target = { kind: 'statement' as const, statementId: 'perf_1' };
      const send = (socket: FakeSocket, type: string, requestId: string) => socket.emitMessage(
        JSON.stringify({ type, schemaVersion, requestId, target }), false,
      );

      send(alice, 'lease:acquire', 'request-A');
      expect(findMessage(alice, 'lease:acquired')?.requestId).toBe('request-A');
      send(alice, 'lease:release', 'request-A');
      send(alice, 'lease:acquire', 'request-B');
      // The client receives A's grant late and sends another cleanup release for A.
      send(alice, 'lease:release', 'request-A');
      const record = leases.leasesByTarget.get(encodeCollaborationLeaseTargetV2(target));
      expect(record?.requestId).toBe('request-B');
      const renewedAt = record?.lastRenewedAt;
      alice.sent = [];
      send(alice, 'lease:renew', 'request-A');
      expect(findMessage(alice, 'lease:acquired')).toBeUndefined();
      expect(record?.lastRenewedAt).toBe(renewedAt);
      send(bob, 'lease:acquire', 'request-C');
      expect(findMessage(bob, 'lease:denied')).toMatchObject({ requestId: 'request-C', heldByClientId: 'alice' });
      send(alice, 'lease:renew', 'request-B');
      expect(findMessage(alice, 'lease:acquired')?.requestId).toBe('request-B');
      send(alice, 'lease:release', 'request-B');
      send(bob, 'lease:acquire', 'request-D');
      expect(findMessage(bob, 'lease:acquired')?.requestId).toBe('request-D');
      alice.emitClose();
      bob.emitClose();
    },
  );

  it.each([COLLABORATION_SCHEMA_VERSION_V2, COLLABORATION_SCHEMA_VERSION_V3] as const)(
    'preserves a reconnected client lease after late messages from its closed socket in protocol V%s',
    (schemaVersion) => {
      const leases = createCollaborationLeaseRegistryV2<WebSocket>();
      const correlatedAdapter = new CollaborationSyncSocketAdapterV2({
        clients: new Set<WebSocket>(), room, assets, schemaVersion,
        presence: createPresenceRegistryV2<WebSocket>(), leases,
      });
      const oldSocket = connect(correlatedAdapter, 'alice');
      const bob = connect(correlatedAdapter, 'bob');
      const target = { kind: 'statement' as const, statementId: 'perf_1' };
      const send = (socket: FakeSocket, type: string, requestId: string) => socket.emitMessage(
        JSON.stringify({ type, schemaVersion, requestId, target }), false,
      );
      send(oldSocket, 'lease:acquire', 'request-A');
      oldSocket.emitClose();
      bob.sent = [];
      const newSocket = connect(correlatedAdapter, 'alice');
      send(newSocket, 'lease:acquire', 'request-B');
      oldSocket.sent = [];
      send(oldSocket, 'lease:renew', 'request-B');
      expect(findMessage(oldSocket, 'lease:acquired')).toBeUndefined();
      send(oldSocket, 'lease:release', 'request-B');
      oldSocket.emitClose();
      expect(findMessage(newSocket, 'lease:released')).toBeUndefined();
      expect(findMessage(bob, 'lease:released')).toBeUndefined();
      expect(leases.leasesByTarget.get(encodeCollaborationLeaseTargetV2(target))?.requestId).toBe('request-B');
      send(bob, 'lease:acquire', 'request-C');
      expect(findMessage(bob, 'lease:denied')).toMatchObject({ heldByClientId: 'alice' });
      send(newSocket, 'lease:renew', 'request-B');
      expect(jsonMessages(newSocket).filter((message) => (message as Record<string, unknown>).type === 'lease:acquired'))
        .toHaveLength(2);
      newSocket.emitClose();
      expect(findMessage(bob, 'lease:released')).toBeTruthy();
      send(bob, 'lease:acquire', 'request-D');
      expect(findMessage(bob, 'lease:acquired')?.requestId).toBe('request-D');
      bob.emitClose();
    },
  );

  it.each([COLLABORATION_SCHEMA_VERSION_V2, COLLABORATION_SCHEMA_VERSION_V3] as const)(
    'rejects duplicate client connections without releasing the active lease in protocol V%s',
    (schemaVersion) => {
      const leases = createCollaborationLeaseRegistryV2<WebSocket>();
      const correlatedAdapter = new CollaborationSyncSocketAdapterV2({
        clients: new Set<WebSocket>(), room, assets, schemaVersion,
        presence: createPresenceRegistryV2<WebSocket>(), leases,
      });
      const alice = connect(correlatedAdapter, 'alice');
      const target = { kind: 'statement' as const, statementId: 'perf_1' };
      alice.emitMessage(JSON.stringify({ type: 'lease:acquire', schemaVersion, requestId: 'request-A', target }), false);

      const duplicate = connect(correlatedAdapter, 'alice');
      expect(duplicate.close).toHaveBeenCalledWith(1008, 'Collaboration client identity is already connected');
      expect(leases.leasesByTarget.get(encodeCollaborationLeaseTargetV2(target))?.requestId).toBe('request-A');
      const bob = connect(correlatedAdapter, 'bob');
      bob.emitMessage(JSON.stringify({ type: 'lease:acquire', schemaVersion, requestId: 'request-B', target }), false);
      expect(findMessage(bob, 'lease:denied')).toMatchObject({ heldByClientId: 'alice' });
      alice.emitClose();
      bob.emitClose();
      correlatedAdapter.dispose();
    },
  );

  it('releases all leases when a client disconnects', () => {
    const alice = connect(adapter, 'alice');
    const bob = connect(adapter, 'bob');
    const target = { kind: 'companion', statementId: 'line_1', companionId: 'cmp_motion' };

    acquire(alice, 'req-alice', target);
    expect(findMessage(alice, 'lease:acquired')).toBeTruthy();

    alice.emitClose();
    // The close path broadcasts lease:released to remaining clients.
    expect(findMessage(bob, 'lease:released')).toBeTruthy();

    acquire(bob, 'req-bob', target);
    expect(findMessage(bob, 'lease:acquired')).toBeTruthy();
  });

  it('supports companion-scoped leases with combined identity', () => {
    const alice = connect(adapter, 'alice');
    const target = { kind: 'companion', statementId: 'line_1', companionId: 'cmp_motion' };

    acquire(alice, 'req-alice', target);
    const acquired = findMessage(alice, 'lease:acquired');
    expect(acquired?.target).toEqual(target);
  });

  it('ignores binary updates through the lease path', () => {
    const alice = connect(adapter, 'alice');
    alice.emitMessage(new Uint8Array([1, 2, 3]), true);
    // No JSON lease responses for binary data.
    expect(jsonMessages(alice).every((message) => (message as Record<string, unknown>).type !== 'lease:acquired')).toBe(true);
  });
});
