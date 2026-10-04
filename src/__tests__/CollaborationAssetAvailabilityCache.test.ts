import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CollaborativeAssetFileEntry,
  CollaborativeAssetManifestEntry,
  CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import { hashCollaborativeAssetBundle } from '../services/collaboration/assets/CollaborativeAssetManifestRules';
import type { CollaborativeAssetBytes } from '../services/collaboration/assets/CollaborativeAssetManifestRules';
import { validateCollaborativeAssetAvailabilityV3 } from '../../server/collaboration/assetAvailability';
import { CollaborationAssetStore } from '../../server/collaboration/assets';

const assetPath = 'game/figure/mygo/anon/live_01/anon.model3.json';
const content = new Uint8Array([123, 125]);
const contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;

class CountingAssetStore extends CollaborationAssetStore {
  reads = 0;

  constructor(dataDir: string) {
    super(dataDir);
  }

  async readAsset(_path: string): Promise<Buffer> {
    this.reads += 1;
    return Buffer.from(content);
  }
}

function makeState(entry: CollaborativeAssetManifestEntry): CollaborativeSceneStateV3 {
  return {
    schemaVersion: 3,
    sceneSchemaVersion: 5,
    collaborationProjectId: 'asset-cache-test',
    roomId: 'asset-cache-test:main',
    sceneId: 'asset-cache-test-scene',
    meta: {
      title: 'Asset cache test',
      characters: [{ id: 'anon', name: 'Anon', model: assetPath }],
    },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time: 1,
        params: { text: 'Hello', durationSeconds: 1 },
      },
    },
    statementOrder: ['line_1'],
    assets: { [assetPath]: entry },
  };
}

describe('collaborative asset availability cache', () => {
  it('reuses validated bundle fingerprints until one of its files is rewritten', async () => {
    const files: CollaborativeAssetFileEntry[] = [];
    const bytes: CollaborativeAssetBytes[] = [];
    for (let index = 0; index < 7989; index += 1) {
      const relativePath = index === 0
        ? assetPath
        : `game/figure/.mtn_exp/motion-${String(index).padStart(4, '0')}.motion3.json`;
      files.push({ relativePath, contentHash, sizeBytes: content.byteLength });
      bytes.push({ relativePath, bytes: content });
    }

    const bundleHash = await hashCollaborativeAssetBundle(bytes, {
      sha256: async (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`,
    });
    const entry: CollaborativeAssetManifestEntry = {
      assetId: `live2d-bundle:${bundleHash}`,
      kind: 'live2d-bundle',
      importKind: 'figure',
      projectRelativePath: assetPath,
      entrypointPath: assetPath,
      contentHash: bundleHash,
      files,
      createdAt: '2026-09-29T00:00:00.000Z',
    };
    const state = makeState(entry);
    const dataDir = await mkdtemp(path.join(tmpdir(), 'aeon-collab-asset-cache-'));
    const store = new CountingAssetStore(dataDir);
    try {
      await validateCollaborativeAssetAvailabilityV3(state, store);
      expect(store.reads).toBe(7989);

      // A dialogue-only transaction keeps the same large model manifest.
      const dialogueEdit = structuredClone(state) as any;
      dialogueEdit.statementsById.line_1.params.text = 'Hello after edit';
      await validateCollaborativeAssetAvailabilityV3(dialogueEdit, store);
      expect(store.reads).toBe(7989);

      const danglingReferenceState = structuredClone(dialogueEdit);
      danglingReferenceState.meta.characters?.push({
        id: 'missing',
        name: 'Missing',
        model: 'game/figure/missing.model3.json',
      });
      await expect(validateCollaborativeAssetAvailabilityV3(danglingReferenceState, store))
        .rejects.toThrow(/missing manifest entry/);
      expect(store.reads).toBe(7989);

      // Any rewritten bundle file invalidates the cached verification.
      await store.writeAsset(files[0].relativePath, content);
      await validateCollaborativeAssetAvailabilityV3(dialogueEdit, store);
      expect(store.reads).toBe(7989 * 2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
