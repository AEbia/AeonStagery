import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeAssetKind,
  type CollaborativeAssetManifest,
  type CollaborativeSceneStateV2,
  type ContentHash,
} from '../api/types/collaboration';
import type { ResourceImportKind } from '../api/types/project';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { CollaborationAssetStore } from '../../server/collaboration/assets';
import {
  validateCollaborativeAssetAvailabilityV2,
} from '../../server/collaboration/assetAvailability';

const textEncoder = new TextEncoder();

function sha256(bytes: Uint8Array): ContentHash {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function makeSingleFileManifest(
  projectRelativePath: string,
  kind: CollaborativeAssetKind,
  importKind: ResourceImportKind,
  bytes: Uint8Array,
  contentHash = sha256(bytes),
): CollaborativeAssetManifest {
  return {
    [projectRelativePath]: {
      assetId: `${kind}:${contentHash}`,
      kind,
      importKind,
      projectRelativePath,
      entrypointPath: projectRelativePath,
      contentHash,
      files: [{
        relativePath: projectRelativePath,
        contentHash,
        sizeBytes: bytes.byteLength,
        mimeType: kind === 'audio-file' ? 'audio/ogg' : 'image/png',
      }],
      createdAt: '2026-06-07T00:00:00.000Z',
    },
  };
}

function mergeManifests(...manifests: CollaborativeAssetManifest[]): CollaborativeAssetManifest {
  return Object.assign({}, ...manifests);
}

function makeStateV2(assets?: CollaborativeAssetManifest): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: { title: 'Asset Gate Scene V2', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello',
          durationSeconds: 2,
        },
      },
      bg: {
        id: 'bg',
        time: 0,
        type: 'environmentLayer',
        params: {
          mode: 'set',
          layerId: 'background',
          image: 'background/bg.png',
        },
      },
    },
    statementOrder: ['bg', 'line_1'],
    companionGroupsByStatementId: {
      line_1: {
        companionsById: {
          chime: {
            id: 'chime',
            anchor: 'start',
            offset: 0,
            type: 'audio',
            params: {
              role: 'sfx',
              mode: 'play',
              instanceId: 'chime',
              file: 'sfx/chime.ogg',
              durationSeconds: 1,
            },
          },
        },
        companionOrder: ['chime'],
      },
    },
    ...(assets ? { assets } : {}),
  };
}

describe('validateCollaborativeAssetAvailabilityV2', () => {
  let tempDir: string;
  let assetStore: CollaborationAssetStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-asset-availability-'));
    assetStore = new CollaborationAssetStore(tempDir);
    await assetStore.ensure();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects v2 source statement references that are not covered by the manifest', async () => {
    await expect(validateCollaborativeAssetAvailabilityV2(makeStateV2(), assetStore))
      .rejects.toThrow('missing manifest entry for referenced asset "background/bg.png"');
  });

  it('accepts v2 source statement and companion assets after manifest files are in the asset store', async () => {
    const backgroundBytes = textEncoder.encode('background-bytes');
    const chimeBytes = textEncoder.encode('chime-bytes');
    await assetStore.writeAsset('background/bg.png', backgroundBytes);
    await assetStore.writeAsset('sfx/chime.ogg', chimeBytes);

    await expect(validateCollaborativeAssetAvailabilityV2(makeStateV2(mergeManifests(
      makeSingleFileManifest('background/bg.png', 'background-image', 'background', backgroundBytes),
      makeSingleFileManifest('sfx/chime.ogg', 'audio-file', 'bgm', chimeBytes),
    )), assetStore)).resolves.toBeUndefined();
  });
});
