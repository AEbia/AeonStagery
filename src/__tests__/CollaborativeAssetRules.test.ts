import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ContentHash } from '../api/types/collaboration';
import type { HistoricalSceneDocumentV4 } from '../api/types/semantic-scene';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import {
  collectCollaborativeSceneDocumentV4AssetRefs,
  collectCollaborativeSceneAssetRefs,
  fingerprintCollaborativeAssetFile,
  hashCollaborativeAssetBundle,
  type CollaborativeAssetHashAdapter,
} from '../services/collaboration/assets';

const textEncoder = new TextEncoder();

const nodeHashAdapter: CollaborativeAssetHashAdapter = {
  async sha256(bytes: Uint8Array): Promise<ContentHash> {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  },
};

function makeScopeScene(): SceneScript {
  return {
    sceneId: 'scope_scene',
    meta: {
      title: 'Scope Scene',
      characters: [
        {
          id: 'tomori',
          name: 'Tomori',
          model: 'figure/tomori/model.json',
          variants: [{ name: 'stage', model: 'figure/tomori/stage.model.json' }],
        },
      ],
    },
    audio: {
      bgm: { file: 'bgm/opening.mp3' },
    },
    timeline: [
      { _id: 'bg', action: 'setBackground', time: 0, params: { image: 'background/bg.png' } },
      { _id: 'env', action: 'setEnvironmentLayer', time: 0, params: { image: 'background/layer.webp' } },
      { _id: 'voice', action: 'dialogue', time: 1, params: { text: 'hi', voice: 'vocal/line.ogg' } },
      { _id: 'image', action: 'addImage', time: 2, params: { file: 'images/cut.png' } },
      { _id: 'anim', action: 'playCustomAnimation', time: 3, params: { file: 'animation/card.html' } },
      { _id: 'custom', action: 'custom', time: 4, params: { file: 'project/generic.bin' } },
      { _id: 'json', action: 'addCharacter', time: 5, params: { id: 'tomori', model: 'figure/tomori/display.json' } },
    ],
  };
}

function makeScopeDocumentV3(): HistoricalSceneDocumentV4 {
  return {
    schemaVersion: 4,
    sceneId: 'scope_scene_v3',
    meta: {
      title: 'Scope Scene V3',
      characters: [
        {
          id: 'tomori',
          name: 'Tomori',
          model: 'figure/tomori/model.json',
          variants: [{ name: 'stage', model: 'figure/tomori/stage.model.json' }],
        },
      ],
    },
    statements: [
      {
        id: 'bg',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', image: 'background/bg.png' },
      },
      {
        id: 'env',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'mist', file: 'background/layer.webp' },
      },
      {
        id: 'char',
        time: 0.5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'rana', model: 'figure/rana/rana.model.json' },
      },
      {
        id: 'voice',
        time: 1,
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1.5, voice: 'vocal/line.ogg' },
        companions: [
          {
            id: 'sfx',
            anchor: 'start',
            offset: 0.1,
            type: 'audio',
            params: {
              role: 'sfx',
              mode: 'play',
              instanceId: 'hit',
              file: 'sfx/hit.wav',
            },
          },
          {
            id: 'perf',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'talk' } },
          },
        ],
      },
      {
        id: 'bgm',
        time: 2,
        type: 'audio',
        params: { role: 'bgm', mode: 'play', file: 'bgm/opening.mp3' },
      },
      {
        id: 'image',
        time: 3,
        type: 'graphicLayer',
        params: { kind: 'image', mode: 'set', id: 'cut', file: 'images/cut.png' },
      },
      {
        id: 'anim',
        time: 4,
        type: 'customAnimation',
        params: { target: 'overlay', file: 'animation/card.html', durationSeconds: 1 },
      },
      {
        id: 'remote',
        time: 5,
        type: 'audio',
        params: { role: 'sfx', mode: 'play', instanceId: 'remote', file: 'https://cdn.example.com/hit.wav' },
      },
    ],
  };
}

describe('Collaborative asset pure rules', () => {
  it('collects only the accepted collaborative asset scope', () => {
    const refs = collectCollaborativeSceneAssetRefs(makeScopeScene());

    expect(refs.map((ref) => [ref.kind, ref.importKind, ref.projectRelativePath]).sort()).toEqual([
      ['animation-file', 'animation', 'animation/card.html'],
      ['audio-file', 'bgm', 'bgm/opening.mp3'],
      ['audio-file', 'vocal', 'vocal/line.ogg'],
      ['background-image', 'background', 'background/bg.png'],
      ['background-image', 'background', 'background/layer.webp'],
      ['image-file', 'images', 'images/cut.png'],
      ['live2d-bundle', 'figure', 'figure/tomori/model.json'],
      ['live2d-bundle', 'figure', 'figure/tomori/stage.model.json'],
    ]);
    expect(refs.some((ref) => ref.kind === 'generic-file')).toBe(false);
    expect(refs.some((ref) => ref.projectRelativePath === 'project/generic.bin')).toBe(false);
    expect(refs.some((ref) => ref.projectRelativePath === 'figure/tomori/display.json')).toBe(false);
  });

  it('normalizes and deduplicates collaborative asset references across scene fields', () => {
    const scene: SceneScript = {
      sceneId: 'scope_dedupe_scene',
      meta: {
        title: 'Scope Dedupe Scene',
        characters: [
          { id: 'tomori', name: 'Tomori', model: 'figure\\tomori\\model.json' },
        ],
      },
      audio: {
        bgm: { file: 'audio\\theme.mp3' },
      },
      timeline: [
        { _id: 'bg1', action: 'setBackground', time: 0, params: { image: 'background\\bg.png' } },
        { _id: 'bg2', action: 'setEnvironmentLayer', time: 1, params: { image: 'background/bg.png' } },
        { _id: 'char', action: 'addCharacter', time: 2, params: { model: 'figure/tomori/model.json' } },
        { _id: 'voice1', action: 'dialogue', time: 3, params: { text: 'hi', voice: 'vocal\\line.wav' } },
        { _id: 'voice2', action: 'dialogue', time: 4, params: { text: 'again', voice: 'vocal/line.wav' } },
      ],
    };

    expect(collectCollaborativeSceneAssetRefs(scene).map((ref) => [
      ref.kind,
      ref.importKind,
      ref.projectRelativePath,
    ])).toEqual([
      ['audio-file', 'bgm', 'audio/theme.mp3'],
      ['live2d-bundle', 'figure', 'figure/tomori/model.json'],
      ['background-image', 'background', 'background/bg.png'],
      ['audio-file', 'vocal', 'vocal/line.wav'],
    ]);
  });

  it('keeps remote URLs and template/export artifacts outside collaborative asset scope', () => {
    const scene: SceneScript = {
      sceneId: 'scope_rejected_scene',
      meta: { title: 'Scope Rejected Scene' },
      audio: {
        bgm: { file: 'https://cdn.example.com/theme.mp3' },
      },
      timeline: [
        { _id: 'bgm-url', action: 'setBGM', time: 0, params: { url: 'https://cdn.example.com/remote.mp3' } },
        { _id: 'template', action: 'custom', time: 1, params: { file: 'templates/shot.json' } },
        { _id: 'export', action: 'custom', time: 2, params: { file: 'exports/final.mp4' } },
        { _id: 'generic', action: 'custom', time: 3, params: { file: 'files/blob.bin' } },
      ],
    };

    expect(collectCollaborativeSceneAssetRefs(scene)).toEqual([]);
  });

  it('collects collaborative asset references from HistoricalSceneDocumentV4 source statements and companions', () => {
    const refs = collectCollaborativeSceneDocumentV4AssetRefs(makeScopeDocumentV3());

    expect(refs.map((ref) => [ref.kind, ref.importKind, ref.projectRelativePath]).sort()).toEqual([
      ['animation-file', 'animation', 'animation/card.html'],
      ['audio-file', 'bgm', 'bgm/opening.mp3'],
      ['audio-file', 'generic', 'sfx/hit.wav'],
      ['audio-file', 'vocal', 'vocal/line.ogg'],
      ['background-image', 'background', 'background/bg.png'],
      ['background-image', 'background', 'background/layer.webp'],
      ['image-file', 'images', 'images/cut.png'],
      ['live2d-bundle', 'figure', 'figure/rana/rana.model.json'],
      ['live2d-bundle', 'figure', 'figure/tomori/model.json'],
      ['live2d-bundle', 'figure', 'figure/tomori/stage.model.json'],
    ]);
    expect(refs.some((ref) => ref.projectRelativePath === 'https://cdn.example.com/hit.wav')).toBe(false);
  });

  it('fingerprints individual manifest files with size, hash, and mime type', async () => {
    const bytes = textEncoder.encode('image-bytes');

    await expect(fingerprintCollaborativeAssetFile({
      relativePath: 'images/cut.png',
      bytes,
    }, nodeHashAdapter)).resolves.toEqual({
      relativePath: 'images/cut.png',
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      sizeBytes: bytes.byteLength,
      mimeType: 'image/png',
    });
  });

  it('hashes Live2D bundle files with stable manifest ordering', async () => {
    const files = [
      { relativePath: 'figure/model/texture.png', bytes: textEncoder.encode('texture') },
      { relativePath: 'figure/model/model.json', bytes: textEncoder.encode('model') },
    ];
    const expectedFeed = Buffer.concat([
      Buffer.from('figure/model/model.json\n'),
      Buffer.from('model'),
      Buffer.from('\n'),
      Buffer.from('figure/model/texture.png\n'),
      Buffer.from('texture'),
      Buffer.from('\n'),
    ]);
    const expected = `sha256:${createHash('sha256').update(expectedFeed).digest('hex')}`;

    await expect(hashCollaborativeAssetBundle(files, nodeHashAdapter)).resolves.toBe(expected);
    await expect(hashCollaborativeAssetBundle([...files].reverse(), nodeHashAdapter)).resolves.toBe(expected);
  });
});
