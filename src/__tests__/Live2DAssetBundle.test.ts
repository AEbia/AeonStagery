import { describe, expect, it } from 'vitest';
import {
  collectLive2DAssetBundleClosure,
  collectLive2DAssetBundleDependencyPaths,
  collectLive2DAssetBundleRawReferences,
  describeLive2DModelEntrypoint,
  dirnameProjectRelativePath,
  isLive2DAssetBundleEntrypoint,
  joinProjectRelativePath,
} from '../services/collaboration/assets';

describe('Live2DAssetBundle', () => {
  it('recognizes Live2D JSON and WMDL entrypoints', () => {
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/model.json')).toBe(true);
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/tomori.model.json')).toBe(true);
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/tomori.model3.json')).toBe(true);
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/tomori.wmdl')).toBe(true);
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/display.json')).toBe(false);
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/data.json')).toBe(false);
    expect(isLive2DAssetBundleEntrypoint('figure/tomori/texture.png')).toBe(false);
  });

  it('describes Cubism runtime family from entrypoint path and content', () => {
    expect(describeLive2DModelEntrypoint('figure/tomori/model.json', {
      model: 'tomori.moc',
    })).toEqual(expect.objectContaining({
      format: 'cubism2-json',
      runtimeFamily: 'cubism2',
      isBundleEntrypoint: true,
    }));

    expect(describeLive2DModelEntrypoint('figure/tomori/tomori.model3.json', {
      FileReferences: { Moc: 'tomori.moc3' },
    })).toEqual(expect.objectContaining({
      format: 'cubism3-plus-json',
      runtimeFamily: 'cubism3-plus',
      isBundleEntrypoint: true,
    }));
  });

  it('collects Cubism 2 raw dependencies including motion sounds', () => {
    expect(collectLive2DAssetBundleRawReferences({
      model: 'tomori.moc',
      textures: ['tex_00.png'],
      expressions: [{ file: 'smile.exp.json' }],
      motions: {
        idle: [
          { file: 'idle.mtn', sound: 'idle.wav' },
          { file: 'idle_alt.mtn' },
        ],
      },
      physics: 'physics.json',
      pose: 'pose.json',
    }, 'figure/tomori/model.json').sort()).toEqual([
      'idle.mtn',
      'idle.wav',
      'idle_alt.mtn',
      'physics.json',
      'pose.json',
      'smile.exp.json',
      'tex_00.png',
      'tomori.moc',
    ]);
  });

  it('collects Cubism 3 FileReferences including DisplayInfo', () => {
    expect(collectLive2DAssetBundleRawReferences({
      FileReferences: {
        Moc: 'tomori.moc3',
        Textures: ['textures/tomori.00.png'],
        Physics: 'physics.json',
        Pose: 'pose.json',
        UserData: 'userdata3.json',
        DisplayInfo: 'display.json',
        Expressions: [{ File: 'expressions/smile.exp3.json' }],
        Motions: {
          Idle: [{ File: 'motions/idle.motion3.json', Sound: 'sounds/idle.wav' }],
        },
      },
    }, 'figure/tomori/tomori.model.json').sort()).toEqual([
      'display.json',
      'expressions/smile.exp3.json',
      'motions/idle.motion3.json',
      'physics.json',
      'pose.json',
      'sounds/idle.wav',
      'textures/tomori.00.png',
      'tomori.moc3',
      'userdata3.json',
    ]);
  });

  it('collects WMDL model and submodel dependencies as project-relative paths', () => {
    expect(collectLive2DAssetBundleDependencyPaths({
      modelRelativePath: 'main/tomori.model.json',
      subModels: [
        { modelRelativePath: 'sub/eyes.model.json' },
        { modelRelativePath: 'sub/hair.model.json' },
      ],
    }, 'figure/tomori/tomori.wmdl').sort()).toEqual([
      'figure/tomori/main/tomori.model.json',
      'figure/tomori/sub/eyes.model.json',
      'figure/tomori/sub/hair.model.json',
    ]);
  });

  it('walks the recursive Live2D bundle closure through WMDL and model JSON files', async () => {
    const files = new Map<string, string>([
      ['figure/tomori/tomori.wmdl', JSON.stringify({
        modelRelativePath: 'main/tomori.model.json',
        subModels: [{ modelRelativePath: 'sub/eyes.model.json' }],
      })],
      ['figure/tomori/main/tomori.model.json', JSON.stringify({
        FileReferences: {
          Moc: 'tomori.moc3',
          Textures: ['textures/tomori.00.png'],
          Motions: { Idle: [{ File: 'motions/idle.motion3.json', Sound: 'sounds/idle.wav' }] },
        },
      })],
      ['figure/tomori/main/motions/idle.motion3.json', '{'],
      ['figure/tomori/sub/eyes.model.json', JSON.stringify({
        textures: ['../shared/eyes.png'],
        motions: { idle: [{ file: '../main/motions/idle.motion3.json' }] },
      })],
    ]);

    const entries = await collectLive2DAssetBundleClosure({
      sourcePath: 'figure/tomori/tomori.wmdl',
      projectRelativePath: 'figure/tomori/tomori.wmdl',
    }, {
      readText: async (sourcePath) => files.get(sourcePath) ?? '{}',
      dirname: (sourcePath) => dirnameProjectRelativePath(sourcePath),
      joinSource: (baseDir, childPath) => joinProjectRelativePath(baseDir, childPath),
      joinProjectRelative: (baseDir, childPath) => joinProjectRelativePath(baseDir, childPath),
    });

    expect(entries.map((entry) => entry.projectRelativePath).sort()).toEqual([
      'figure/tomori/main/motions/idle.motion3.json',
      'figure/tomori/main/sounds/idle.wav',
      'figure/tomori/main/textures/tomori.00.png',
      'figure/tomori/main/tomori.moc3',
      'figure/tomori/main/tomori.model.json',
      'figure/tomori/shared/eyes.png',
      'figure/tomori/sub/eyes.model.json',
      'figure/tomori/tomori.wmdl',
    ]);
  });

  it('deduplicates recursive closure entries and stops cyclic model references', async () => {
    const files = new Map<string, string>([
      ['figure/tomori/model.json', JSON.stringify({
        FileReferences: {
          Moc: 'tomori.moc3',
          Textures: ['textures/body.png', 'textures/body.png'],
          Motions: { Idle: [{ File: 'model.json' }] },
        },
      })],
    ]);
    const readTextCalls: string[] = [];

    const entries = await collectLive2DAssetBundleClosure({
      sourcePath: 'figure\\tomori\\model.json',
      projectRelativePath: 'figure/tomori/model.json',
    }, {
      readText: async (sourcePath) => {
        readTextCalls.push(sourcePath);
        return files.get(sourcePath) ?? '{}';
      },
      dirname: (sourcePath) => dirnameProjectRelativePath(sourcePath),
      joinSource: (baseDir, childPath) => joinProjectRelativePath(baseDir, childPath),
      joinProjectRelative: (baseDir, childPath) => joinProjectRelativePath(baseDir, childPath),
    });

    expect(readTextCalls).toEqual(['figure/tomori/model.json']);
    expect(entries.map((entry) => entry.projectRelativePath)).toEqual([
      'figure/tomori/model.json',
      'figure/tomori/tomori.moc3',
      'figure/tomori/textures/body.png',
    ]);
  });

  it('keeps closure ordering stable for repeated dependency discovery', async () => {
    const files = new Map<string, string>([
      ['figure/tomori/tomori.model.json', JSON.stringify({
        FileReferences: {
          Moc: 'tomori.moc3',
          Textures: ['textures/02.png', 'textures/01.png'],
          Expressions: [{ File: 'expressions/smile.exp3.json' }],
        },
      })],
    ]);
    const adapter = {
      readText: async (sourcePath: string) => files.get(sourcePath) ?? '{}',
      dirname: (sourcePath: string) => dirnameProjectRelativePath(sourcePath),
      joinSource: (baseDir: string, childPath: string) => joinProjectRelativePath(baseDir, childPath),
      joinProjectRelative: (baseDir: string, childPath: string) => joinProjectRelativePath(baseDir, childPath),
    };

    const first = await collectLive2DAssetBundleClosure({
      sourcePath: 'figure/tomori/tomori.model.json',
      projectRelativePath: 'figure/tomori/tomori.model.json',
    }, adapter);
    const second = await collectLive2DAssetBundleClosure({
      sourcePath: 'figure/tomori/tomori.model.json',
      projectRelativePath: 'figure/tomori/tomori.model.json',
    }, adapter);

    expect(second.map((entry) => entry.projectRelativePath)).toEqual(first.map((entry) => entry.projectRelativePath));
    expect(first.map((entry) => entry.projectRelativePath)).toEqual([
      'figure/tomori/tomori.model.json',
      'figure/tomori/tomori.moc3',
      'figure/tomori/textures/02.png',
      'figure/tomori/textures/01.png',
      'figure/tomori/expressions/smile.exp3.json',
    ]);
  });
});
