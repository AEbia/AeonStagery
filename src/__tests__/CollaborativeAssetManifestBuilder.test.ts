import { describe, expect, it } from 'vitest';
import type { HistoricalSceneDocumentV4 } from '../api/types/semantic-scene';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import {
  CollaborativeAssetManifestBuilder,
  getCollaborativeAssetReferenceKeys,
  getCollaborativeSceneDocumentV4AssetReferenceKeys,
  hasUnchangedCollaborativeAssetReferences,
  hasUnchangedCollaborativeSceneDocumentV4AssetReferences,
} from '../services/collaboration/CollaborativeAssetManifestBuilder';
import type { IFileAccess } from '../services/io/IFileAccess';

class FakeFileAccess implements IFileAccess {
  constructor(private files: Record<string, string>) {}

  async readAsset(relativePath: string): Promise<{ data: string; path: string }> {
    return this.readFile(relativePath);
  }

  async readFile(path: string): Promise<{ data: string; path: string }> {
    const data = this.files[path];
    if (data === undefined) throw new Error(`Missing test file: ${path}`);
    return { data, path };
  }

  async readBinaryFile(path: string): Promise<{ data: ArrayBuffer; path: string }> {
    const { data } = await this.readFile(path);
    const bytes = new TextEncoder().encode(data);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return { data: buffer, path };
  }

  async showOpenDialog(): Promise<{ data: string; path: string } | null> {
    return null;
  }

  async showSaveDialog(): Promise<string | null> {
    return null;
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.files[path] = data;
  }

  async ensureDir(_path: string): Promise<void> {
    return;
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    this.files[destPath] = this.files[sourcePath];
  }

  async readDir(_path: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> {
    return [];
  }

  async exists(path: string): Promise<boolean> {
    return this.files[path] !== undefined;
  }

  async join(...parts: string[]): Promise<string> {
    return parts.join('/').replace(/\/+/g, '/');
  }

  async dirname(path: string): Promise<string> {
    const clean = path.replace(/\\/g, '/');
    const index = clean.lastIndexOf('/');
    return index === -1 ? '' : clean.slice(0, index);
  }

  async basename(path: string): Promise<string> {
    return path.replace(/\\/g, '/').split('/').pop() || path;
  }

  async extname(path: string): Promise<string> {
    const base = await this.basename(path);
    const index = base.lastIndexOf('.');
    return index === -1 ? '' : base.slice(index);
  }
}

const projectResources = {
  resolveForRead: async (projectRelativePath: string) => projectRelativePath,
};

function makeScene(): SceneScript {
  return {
    sceneId: 'scene_1',
    meta: {
      title: 'Asset Scene',
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    timeline: [
      { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'tomori', model: 'figure/tomori/model.json' } },
      { _id: 'a2', action: 'setBackground', time: 0, params: { image: 'background/bg.png' } },
      { _id: 'a3', action: 'playAudio', time: 1, params: { file: 'bgm/song.mp3' } },
    ],
  };
}

function makeSceneDocumentV4(): HistoricalSceneDocumentV4 {
  return {
    schemaVersion: 4,
    sceneId: 'scene_v2',
    meta: {
      title: 'Asset Scene V2',
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
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
        id: 'voice',
        time: 1,
        type: 'dialogue',
        params: { text: 'hi', durationSeconds: 1, voice: 'vocal/line.ogg' },
        companions: [
          {
            id: 'sfx',
            anchor: 'start',
            offset: 0,
            type: 'audio',
            params: {
              role: 'sfx',
              mode: 'play',
              instanceId: 'hit',
              file: 'sfx/hit.wav',
            },
          },
        ],
      },
      {
        id: 'bgm',
        time: 2,
        type: 'audio',
        params: { role: 'bgm', mode: 'play', file: 'bgm/song.mp3' },
      },
      {
        id: 'image',
        time: 3,
        type: 'graphicLayer',
        params: { kind: 'image', mode: 'set', id: 'cut', file: 'images/cut-in.png' },
      },
      {
        id: 'anim',
        time: 4,
        type: 'customAnimation',
        params: { target: 'overlay', file: 'animation/flash.html', durationSeconds: 1 },
      },
    ],
  };
}

describe('CollaborativeAssetManifestBuilder', () => {
  it('extracts collaborative project asset reference keys', () => {
    const scene = makeScene();
    scene.timeline.push({ _id: 'voice', action: 'dialogue', time: 2, params: { text: 'hi', voice: 'vocal/line.wav' } });

    expect(getCollaborativeAssetReferenceKeys(scene)).toEqual([
      'background/bg.png',
      'bgm/song.mp3',
      'figure/tomori/model.json',
      'vocal/line.wav',
    ]);
  });

  it('extracts collaborative asset reference keys from HistoricalSceneDocumentV4 source', () => {
    expect(getCollaborativeSceneDocumentV4AssetReferenceKeys(makeSceneDocumentV4())).toEqual([
      'animation/flash.html',
      'background/bg.png',
      'bgm/song.mp3',
      'figure/tomori/model.json',
      'images/cut-in.png',
      'sfx/hit.wav',
      'vocal/line.ogg',
    ]);
  });

  it('detects whether the previous manifest still covers the scene asset references', () => {
    expect(hasUnchangedCollaborativeAssetReferences(makeScene(), {
      'background/bg.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/bg.png',
        entrypointPath: 'background/bg.png',
        contentHash: 'sha256:bg',
        files: [],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
      'bgm/song.mp3': {
        assetId: 'asset_bgm',
        kind: 'audio-file',
        importKind: 'bgm',
        projectRelativePath: 'bgm/song.mp3',
        entrypointPath: 'bgm/song.mp3',
        contentHash: 'sha256:bgm',
        files: [],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
      'figure/tomori/model.json': {
        assetId: 'asset_live2d',
        kind: 'live2d-bundle',
        importKind: 'figure',
        projectRelativePath: 'figure/tomori/model.json',
        entrypointPath: 'figure/tomori/model.json',
        contentHash: 'sha256:live2d',
        files: [],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    })).toBe(true);

    expect(hasUnchangedCollaborativeAssetReferences(makeScene(), {
      'background/other.png': {
        assetId: 'asset_bg',
        kind: 'background-image',
        importKind: 'background',
        projectRelativePath: 'background/other.png',
        entrypointPath: 'background/other.png',
        contentHash: 'sha256:bg',
        files: [],
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    })).toBe(false);
  });

  it('detects same-path file replacement by checking manifest fingerprints on disk', async () => {
    const fileAccess = new FakeFileAccess({
      'figure/tomori/model.json': JSON.stringify({ model: 'tomori.moc' }),
      'figure/tomori/tomori.moc': 'moc-bytes',
      'background/bg.png': 'background-bytes',
      'bgm/song.mp3': 'bgm-bytes',
    });
    const builder = new CollaborativeAssetManifestBuilder({
      fileAccess,
      projectResources,
      now: () => '2026-06-06T00:00:00.000Z',
    });
    const manifest = await builder.buildForScene(makeScene());

    await expect(hasUnchangedCollaborativeAssetReferences(makeScene(), manifest, {
      fileAccess,
      projectResources,
    })).resolves.toBe(true);

    await fileAccess.writeFile('background/bg.png', 'changed-background-bytes');

    await expect(hasUnchangedCollaborativeAssetReferences(makeScene(), manifest, {
      fileAccess,
      projectResources,
    })).resolves.toBe(false);
  });

  it('builds manifest entries for collaborative project asset scope', async () => {
    const fileAccess = new FakeFileAccess({
      'figure/tomori/model.json': JSON.stringify({
        model: 'tomori.moc',
        textures: ['tex.png'],
        motions: { idle: [{ file: 'idle.mtn' }] },
        expressions: [{ file: 'smile.exp.json' }],
        physics: 'physics.json',
      }),
      'figure/tomori/tomori.moc': 'moc-bytes',
      'figure/tomori/tex.png': 'texture-bytes',
      'figure/tomori/idle.mtn': 'motion-bytes',
      'figure/tomori/smile.exp.json': '{}',
      'figure/tomori/physics.json': '{}',
      'background/bg.png': 'background-bytes',
      'bgm/song.mp3': 'audio-bytes',
    });

    const builder = new CollaborativeAssetManifestBuilder({
      fileAccess,
      projectResources,
      now: () => '2026-06-06T00:00:00.000Z',
    });

    const manifest = await builder.buildForScene(makeScene());

    expect(Object.keys(manifest).sort()).toEqual([
      'background/bg.png',
      'bgm/song.mp3',
      'figure/tomori/model.json',
    ]);
    expect(manifest['background/bg.png']).toEqual(expect.objectContaining({
      kind: 'background-image',
      importKind: 'background',
      entrypointPath: 'background/bg.png',
      createdAt: '2026-06-06T00:00:00.000Z',
    }));
    expect(manifest['background/bg.png'].contentHash).toMatch(/^sha256:/);
    expect(manifest['bgm/song.mp3']).toEqual(expect.objectContaining({
      kind: 'audio-file',
      importKind: 'bgm',
      entrypointPath: 'bgm/song.mp3',
      createdAt: '2026-06-06T00:00:00.000Z',
    }));
    expect(manifest['bgm/song.mp3'].contentHash).toMatch(/^sha256:/);

    const live2d = manifest['figure/tomori/model.json'];
    expect(live2d.kind).toBe('live2d-bundle');
    expect(live2d.importKind).toBe('figure');
    expect(live2d.files.map((file) => file.relativePath).sort()).toEqual([
      'figure/tomori/idle.mtn',
      'figure/tomori/model.json',
      'figure/tomori/physics.json',
      'figure/tomori/smile.exp.json',
      'figure/tomori/tex.png',
      'figure/tomori/tomori.moc',
    ]);
    expect(live2d.contentHash).toMatch(/^sha256:/);
    expect(live2d.files.every((file) => file.contentHash.startsWith('sha256:'))).toBe(true);
  });

  it('builds manifest entries from HistoricalSceneDocumentV4 source statements', async () => {
    const fileAccess = new FakeFileAccess({
      'figure/tomori/model.json': JSON.stringify({ model: 'tomori.moc' }),
      'figure/tomori/tomori.moc': 'moc-bytes',
      'background/bg.png': 'background-bytes',
      'vocal/line.ogg': 'voice-bytes',
      'sfx/hit.wav': 'sfx-bytes',
      'bgm/song.mp3': 'bgm-bytes',
      'images/cut-in.png': 'image-bytes',
      'animation/flash.html': '<html></html>',
    });
    const builder = new CollaborativeAssetManifestBuilder({
      fileAccess,
      projectResources,
      now: () => '2026-06-06T00:00:00.000Z',
    });

    const document = makeSceneDocumentV4();
    const manifest = await builder.buildForSceneDocumentV4(document);

    expect(Object.keys(manifest).sort()).toEqual([
      'animation/flash.html',
      'background/bg.png',
      'bgm/song.mp3',
      'figure/tomori/model.json',
      'images/cut-in.png',
      'sfx/hit.wav',
      'vocal/line.ogg',
    ]);
    expect(manifest['figure/tomori/model.json'].kind).toBe('live2d-bundle');
    expect(manifest['figure/tomori/model.json'].files.map((file) => file.relativePath).sort()).toEqual([
      'figure/tomori/model.json',
      'figure/tomori/tomori.moc',
    ]);
    expect(manifest['vocal/line.ogg'].importKind).toBe('vocal');
    expect(manifest['sfx/hit.wav'].importKind).toBe('generic');
    expect(manifest['images/cut-in.png'].kind).toBe('image-file');
    expect(manifest['animation/flash.html'].kind).toBe('animation-file');

    await expect(hasUnchangedCollaborativeSceneDocumentV4AssetReferences(document, manifest, {
      fileAccess,
      projectResources,
    })).resolves.toBe(true);

    await fileAccess.writeFile('vocal/line.ogg', 'changed-voice-bytes');

    await expect(hasUnchangedCollaborativeSceneDocumentV4AssetReferences(document, manifest, {
      fileAccess,
      projectResources,
    })).resolves.toBe(false);
  });

  it('includes image, vocal, and animation action resources', async () => {
    const fileAccess = new FakeFileAccess({
      'images/cut-in.png': 'image-bytes',
      'vocal/line.ogg': 'voice-bytes',
      'animation/flash.html': '<html></html>',
    });
    const builder = new CollaborativeAssetManifestBuilder({
      fileAccess,
      projectResources,
      now: () => '2026-06-06T00:00:00.000Z',
    });

    const manifest = await builder.buildForScene({
      sceneId: 'media_scene',
      meta: { title: 'Media Scene' },
      timeline: [
        { _id: 'image', action: 'addImage', time: 0, params: { id: 'cut', file: 'images/cut-in.png' } },
        { _id: 'voice', action: 'dialogue', time: 1, params: { text: 'hi', voice: 'vocal/line.ogg' } },
        { _id: 'anim', action: 'playCustomAnimation', time: 2, params: { file: 'animation/flash.html' } },
      ],
    });

    expect(Object.keys(manifest).sort()).toEqual([
      'animation/flash.html',
      'images/cut-in.png',
      'vocal/line.ogg',
    ]);
    expect(manifest['images/cut-in.png'].kind).toBe('image-file');
    expect(manifest['images/cut-in.png'].importKind).toBe('images');
    expect(manifest['vocal/line.ogg'].kind).toBe('audio-file');
    expect(manifest['vocal/line.ogg'].importKind).toBe('vocal');
    expect(manifest['animation/flash.html'].kind).toBe('animation-file');
    expect(manifest['animation/flash.html'].importKind).toBe('animation');
  });

  it('builds composed .wmdl manifest entries as Live2D bundles', async () => {
    const fileAccess = new FakeFileAccess({
      'figure/tomori/tomori.wmdl': JSON.stringify({
        modelRelativePath: 'model/tomori.model.json',
        subModels: [{ modelRelativePath: 'sub/alt.model.json' }],
      }),
      'figure/tomori/model/tomori.model.json': JSON.stringify({
        model: 'tomori.moc',
        textures: ['tex.png'],
        motions: { idle: [{ file: 'idle.mtn' }] },
        expressions: [{ file: 'smile.exp.json' }],
        physics: 'physics.json',
      }),
      'figure/tomori/model/tomori.moc': 'moc-bytes',
      'figure/tomori/model/tex.png': 'texture-bytes',
      'figure/tomori/model/idle.mtn': 'motion-bytes',
      'figure/tomori/model/smile.exp.json': '{}',
      'figure/tomori/model/physics.json': '{}',
      'figure/tomori/sub/alt.model.json': JSON.stringify({
        model: 'alt.moc',
      }),
      'figure/tomori/sub/alt.moc': 'alt-moc-bytes',
      'background/bg.png': 'background-bytes',
      'bgm/song.mp3': 'audio-ignored',
    });

    const builder = new CollaborativeAssetManifestBuilder({
      fileAccess,
      projectResources,
      now: () => '2026-06-06T00:00:00.000Z',
    });

    const wmdlManifest = await builder.buildForScene({
      ...makeScene(),
      meta: {
        ...makeScene().meta,
        characters: [{ id: 'tomori', name: 'Tomori', model: 'figure/tomori/tomori.wmdl' }],
      },
      timeline: [
        { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'tomori', model: 'figure/tomori/tomori.wmdl' } },
        { _id: 'a2', action: 'setBackground', time: 0, params: { image: 'background/bg.png' } },
      ],
    });

    expect(Object.keys(wmdlManifest).sort()).toEqual([
      'background/bg.png',
      'figure/tomori/tomori.wmdl',
    ]);
    const live2d = wmdlManifest['figure/tomori/tomori.wmdl'];
    expect(live2d.kind).toBe('live2d-bundle');
    expect(live2d.importKind).toBe('figure');
    expect(live2d.files.map((file) => file.relativePath).sort()).toEqual([
      'figure/tomori/model/idle.mtn',
      'figure/tomori/model/physics.json',
      'figure/tomori/model/smile.exp.json',
      'figure/tomori/model/tex.png',
      'figure/tomori/model/tomori.moc',
      'figure/tomori/model/tomori.model.json',
      'figure/tomori/sub/alt.moc',
      'figure/tomori/sub/alt.model.json',
      'figure/tomori/tomori.wmdl',
    ]);
    expect(live2d.contentHash).toMatch(/^sha256:/);
    expect(live2d.files.every((file) => file.contentHash.startsWith('sha256:'))).toBe(true);
  });

  it('treats direct .model.json references as Live2D bundle entries', async () => {
    const fileAccess = new FakeFileAccess({
      'figure/rana/rana.model.json': JSON.stringify({
        model: 'rana.moc',
        textures: ['rana.png'],
      }),
      'figure/rana/rana.moc': 'moc-bytes',
      'figure/rana/rana.png': 'texture-bytes',
    });
    const builder = new CollaborativeAssetManifestBuilder({
      fileAccess,
      projectResources,
      now: () => '2026-06-06T00:00:00.000Z',
    });

    const manifest = await builder.buildForScene({
      sceneId: 'scene_model_json',
      meta: {
        title: 'Model Json Scene',
        characters: [{ id: 'rana', name: 'Rana', model: 'figure/rana/rana.model.json' }],
      },
      timeline: [],
    });

    expect(Object.keys(manifest)).toEqual(['figure/rana/rana.model.json']);
    expect(manifest['figure/rana/rana.model.json'].kind).toBe('live2d-bundle');
    expect(manifest['figure/rana/rana.model.json'].files.map((file) => file.relativePath).sort()).toEqual([
      'figure/rana/rana.moc',
      'figure/rana/rana.model.json',
      'figure/rana/rana.png',
    ]);
  });
});
