import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import {
  startCollaborationServer,
  type RunningCollaborationServer,
} from '../../server/collaboration/server';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import {
  materializeCollaborativeSceneDocumentV5,
  createCollaborativeSceneStateV3FromDocument,
} from '../services/collaboration/CollaborativeSceneStateV3';

function makeCanonicalV5Document(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_convergence_v5',
    meta: {
      title: 'Convergence Scene V5',
      fps: 60,
      markers: [
        {
          markerId: 'm1',
          time: 0,
          label: 'Start',
          role: 'note',
        },
      ],
    },
    visual: {
      visualTargets: {
        bg1: { targetType: 'background' },
      },
    },
    statements: [
      {
        id: 'line_1',
        time: 0,
        type: 'dialogue',
        params: {
          text: 'Opening statement',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'c1',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
            },
          },
        ],
      },
      {
        id: 'line_2',
        time: 2,
        type: 'dialogue',
        params: {
          text: 'Second statement',
          durationSeconds: 3,
        },
      },
    ],
  };
}

describe('Collaboration Convergence V3', () => {
  let tempDir: string;
  let server: RunningCollaborationServer | null = null;
  let clientA: CollaborationClientV3 | null = null;
  let clientB: CollaborationClientV3 | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-conv-v3-'));
    server = await startCollaborationServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: tempDir,
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    });
  });

  afterEach(async () => {
    clientA?.dispose();
    clientB?.dispose();
    clientA = null;
    clientB = null;
    await server?.stop();
    server = null;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('two v3 clients converge on canonical v5 statements, order, companions, tombstones, and collaborative assets', async () => {
    const status = server!.getStatus();
    const endpoint = `${status.localUrl}#token=${status.accessToken}`;
    const webSocketFactory = (url: string, protocols?: string[]) => new WebSocket(url, protocols) as any;

    clientA = new CollaborationClientV3({
      endpoint,
      webSocketFactory,
      identity: { clientId: 'client-A', displayName: 'Alice' },
    });
    clientB = new CollaborationClientV3({
      endpoint,
      webSocketFactory,
      identity: { clientId: 'client-B', displayName: 'Bob' },
    });

    // Upload an asset file via client A before seeding
    const assetBytes = new TextEncoder().encode('hello asset');
    const assetHash = `sha256:${createHash('sha256').update(assetBytes).digest('hex')}`;
    await clientA.uploadAssetFile('background/bg.png', assetBytes);

    // 1. Client A seeds the canonical v5 scene
    const initialDoc = makeCanonicalV5Document();
    const initialAssetManifest = {
      'background/bg.png': {
        assetId: 'asset-bg1',
        kind: 'background-image' as const,
        importKind: 'background' as const,
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: assetHash,
        files: [{
          relativePath: 'background/bg.png',
          contentHash: assetHash,
          sizeBytes: assetBytes.byteLength,
        }],
        createdAt: new Date().toISOString(),
      },
    };
    const seedState = createCollaborativeSceneStateV3FromDocument(initialDoc, {
      collaborationProjectId: 'project_convergence',
      roomId: 'project_convergence:main',
      assets: initialAssetManifest,
    });

    await clientA.seed(seedState);
    clientA.connectRealtime();
    await vi.waitFor(() => expect(clientA!.isRealtimeConnected()).toBe(true));

    // 2. Client B joins and connects realtime
    await clientB.join();
    clientB.connectRealtime();
    await vi.waitFor(() => expect(clientB!.isRealtimeConnected()).toBe(true));

    // Client B materializes initial state and verifies exact match with Client A
    const docB1 = materializeCollaborativeSceneDocumentV5(clientB.getState()!);
    expect(docB1.schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(docB1.statements.map((s) => s.id)).toEqual(['line_1', 'line_2']);
    expect(docB1.statements[0].companions?.map((c) => c.id)).toEqual(['c1']);
    expect(clientB.getState()?.assets?.['background/bg.png']).toBeDefined();

    // Client B downloads the asset uploaded by Client A
    const downloadedBytes = await clientB.downloadAssetFile('background/bg.png');
    expect(new TextDecoder().decode(downloadedBytes)).toBe('hello asset');

    // 3. Client A updates statement text and adds a new statement
    await clientA.publishStatementChanges({
      upsertStatements: {
        line_1: {
          id: 'line_1',
          time: 0,
          type: 'dialogue',
          params: {
            text: 'Updated line 1 by Alice',
            durationSeconds: 2.5,
          },
        },
        line_3: {
          id: 'line_3',
          time: 5,
          type: 'dialogue',
          params: {
            text: 'Third line added by Alice',
            durationSeconds: 1,
          },
        },
      },
      statementOrder: ['line_1', 'line_3', 'line_2'],
    });

    // Client B receives the update in realtime
    await vi.waitFor(() => {
      const stateB = clientB!.getState();
      expect(stateB?.statementsById.line_3).toBeDefined();
      expect((stateB?.statementsById.line_1.params as any).text).toBe('Updated line 1 by Alice');
      expect(stateB?.statementOrder).toEqual(['line_1', 'line_3', 'line_2']);
    });

    // 4. Client B deletes line_2 (with tombstone) and updates companions on line_1
    await clientB.publishStatementChanges({
      deleteStatementIds: ['line_2'],
      statementOrder: ['line_1', 'line_3'],
      deletedAt: new Date().toISOString(),
      deletedBy: 'client-B',
    });

    await clientB.publishCompanionChanges({
      statementId: 'line_1',
      upsertCompanions: {
        c2: {
          id: 'c2',
          anchor: 'end',
          offset: -0.5,
          type: 'camera',
          params: {
            mode: 'focus',
            target: '$speaker',
          },
        },
      },
      companionOrder: ['c1', 'c2'],
    });

    // Client A converges to Client B's changes
    await vi.waitFor(() => {
      const stateA = clientA!.getState();
      expect(stateA?.statementsById.line_2).toBeUndefined();
      expect(stateA?.tombstones?.statements?.line_2).toBeDefined();
      expect(stateA?.companionGroupsByStatementId?.line_1.companionOrder).toEqual(['c1', 'c2']);
    });

    // Both clients materialize identical canonical SceneDocumentV5
    const finalDocA = materializeCollaborativeSceneDocumentV5(clientA.getState()!);
    const finalDocB = materializeCollaborativeSceneDocumentV5(clientB.getState()!);
    expect(finalDocA).toEqual(finalDocB);
    expect(finalDocA.statements.map((s) => s.id)).toEqual(['line_1', 'line_3']);
    expect(finalDocA.statements[0].companions?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('rejects a v2 client attempting to connect to or seed a v3 server', async () => {
    const status = server!.getStatus();
    const endpoint = `${status.localUrl}#token=${status.accessToken}`;
    const v2Client = new CollaborationClientV2({
      endpoint,
      fetchImpl: fetch,
      webSocketFactory: (url, protocols) => new WebSocket(url, protocols) as any,
    });

    // Attempting to seed v2 state to v3 server fails
    await expect(v2Client.seed({
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
      collaborationProjectId: 'p2',
      roomId: 'p2:main',
      sceneId: 's2',
      meta: { title: 'v2', fps: 60 },
      statementsById: {},
      statementOrder: [],
    })).rejects.toThrow(/schema version 3/i);

    v2Client.dispose();
  });
});
