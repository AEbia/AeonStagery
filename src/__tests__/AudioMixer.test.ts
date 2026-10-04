import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioMixer } from '../engine/export/AudioMixer';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';

function createMockElectronFs() {
  return {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue({ success: true, data: new ArrayBuffer(8) }),
    writeFile: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMockElectronExport() {
  return {
    convert: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createPreparedScene(actions: PreparedCompiledScene['actions']): PreparedCompiledScene {
  return {
    kind: 'prepared-compiled-scene',
    sourceSchemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'prepared-audio',
    meta: { title: 'Prepared Audio' },
    durationSeconds: 10,
    actions,
  };
}

describe('AudioMixer', () => {
  let mixer: AudioMixer;
  let fs: ReturnType<typeof createMockElectronFs>;
  let exp: ReturnType<typeof createMockElectronExport>;

  beforeEach(() => {
    fs = createMockElectronFs();
    exp = createMockElectronExport();
    mixer = new AudioMixer(fs as any, exp as any);
  });

  it('collectSources returns empty array when sceneData is null', async () => {
    const sources = await mixer.collectSources(null, '', 0);
    expect(sources).toEqual([]);
  });

  it('collectSources finds BGM from scene.audio.bgm.file', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [],
      audio: { bgm: { file: 'bgm.mp3' } },
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);
    expect(sources.length).toBe(1);
    expect(sources[0].delayMs).toBe(0);
  });

  it('keeps the current gain when a legacy scene BGM export starts inside fade-in', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [],
      audio: { bgm: { file: 'bgm.mp3', volume: 0.8, fadeIn: 4 } },
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 2);

    expect(sources).toEqual([{
      path: '/proj/bgm.mp3',
      delayMs: 0,
      startOffset: 2,
      volume: 0.8,
      loop: true,
      fadeIn: 2,
      fadeInStartGain: 0.5,
    }]);
  });

  it('collectSources uses timeline BGM instead of scene fallback when setBGM exists', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'setBGM', time: 2, params: { file: 'timeline-bgm.mp3', volume: 0.4 } },
      ],
      audio: { bgm: { file: 'fallback-bgm.mp3', volume: 0.8 } },
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);

    expect(sources).toEqual([
      {
        path: '/proj/timeline-bgm.mp3',
        delayMs: 2000,
        fadeIn: 2,
        volume: 0.4,
        loop: true,
      },
    ]);
  });

  it('collectSources skips files that do not exist', async () => {
    fs.exists.mockResolvedValue(false);

    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [],
      audio: { bgm: { file: 'missing.mp3' } },
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);
    expect(sources).toEqual([]);
  });

  it('collectSources finds voice files from dialogue actions', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'dialogue', time: 3, params: { voice: 'line1.wav', duration: 2 } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);
    expect(sources.length).toBe(1);
    expect(sources[0].delayMs).toBe(3000); // 3 seconds
    expect(sources[0].duration).toBe(2);
  });

  it('keeps the current gain when a dialogue export starts inside fade-out', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'dialogue', time: 0, params: { voice: 'line.wav', duration: 5, fadeOut: 2 } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 4);

    expect(sources[0]).toEqual({
      path: '/proj/line.wav',
      delayMs: 0,
      startOffset: 4,
      duration: 1,
      fadeOut: 1,
      fadeOutStartGain: 0.5,
    });
  });

  it('collectSources trims dialogue voices that started before exportStart', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'dialogue', time: 1, params: { voice: 'line1.wav', duration: 5 } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 3);

    expect(sources).toEqual([
      {
        path: '/proj/line1.wav',
        delayMs: 0,
        startOffset: 2,
        duration: 3,
      },
    ]);
  });

  it('collectSources adjusts delayMs by exportStart', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'dialogue', time: 5, params: { voice: 'line.wav' } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 2);
    expect(sources[0].delayMs).toBe(3000); // (5 - 2) * 1000
  });

  it('collectSources builds playAudio and stopAudio intervals', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'playAudio', time: 1, params: { id: 'door', file: 'sfx/door.wav', volume: 0.7 } },
        { action: 'stopAudio', time: 3.5, params: { id: 'door' } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);

    expect(sources).toEqual([
      {
        path: '/proj/sfx/door.wav',
        delayMs: 1000,
        duration: 2.5,
        volume: 0.7,
      },
    ]);
  });

  it('collectSources trims playAudio intervals that overlap exportStart', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'playAudio', time: 1, params: { id: 'amb', file: 'sfx/amb.wav', duration: 5 } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 3);

    expect(sources).toEqual([
      {
        path: '/proj/sfx/amb.wav',
        delayMs: 0,
        startOffset: 2,
        duration: 3,
      },
    ]);
  });

  it('shortens a fade-in when export starts inside the active audio interval', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        {
          action: 'playAudio',
          time: 0,
          params: { id: 'amb', file: 'sfx/amb.wav', duration: 5, volume: 0.8, fadeIn: 4 },
        },
        { action: 'stopAudio', time: 5, params: { id: 'amb', fadeOut: 2 } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 2);

    expect(sources).toEqual([
      {
        path: '/proj/sfx/amb.wav',
        delayMs: 0,
        startOffset: 2,
        duration: 3,
        volume: 0.8,
        fadeIn: 2,
        fadeInStartGain: 0.5,
        fadeOut: 2,
      },
    ]);
  });

  it('keeps the current gain when an export starts inside fade-out', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'playAudio', time: 0, params: { id: 'amb', file: 'sfx/amb.wav', duration: 5, fadeOut: 2 } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 4);

    expect(sources).toEqual([{
      path: '/proj/sfx/amb.wav',
      delayMs: 0,
      startOffset: 4,
      duration: 1,
      fadeOut: 1,
      fadeOutStartGain: 0.5,
    }]);
  });

  it('collectSources closes timeline BGM when stopAudio targets bgm', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'setBGM', time: 0, params: { file: 'bgm/theme.mp3', volume: 0.5 } },
        { action: 'stopAudio', time: 4, params: { id: 'bgm' } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);

    expect(sources).toEqual([
      {
        path: '/proj/bgm/theme.mp3',
        delayMs: 0,
        duration: 4,
        fadeIn: 2,
        volume: 0.5,
        loop: true,
      },
    ]);
  });

  it('collectSources keeps absolute audio paths unprefixed by basePath', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'playAudio', time: 0, params: { id: 'external', file: 'D:\\external\\sound.wav' } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);

    expect(fs.exists).toHaveBeenCalledWith('D:/external/sound.wav');
    expect(sources[0].path).toBe('D:/external/sound.wav');
  });

  it('collectSources does not route UNC or protocol audio paths through project resource resolution', async () => {
    const projectResources = {
      getCurrentProject: vi.fn(() => ({ id: 'open-project' })),
      resolveForRead: vi.fn((value: string) => `/project/${value}`),
    };
    mixer = new AudioMixer(fs as any, exp as any, projectResources as any);
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'playAudio', time: 0, params: { id: 'unc', file: '\\\\server\\share\\sound.wav' } },
        { action: 'playAudio', time: 1, params: { id: 'http', file: 'https://cdn.example.com/sound.wav' } },
        { action: 'playAudio', time: 2, params: { id: 'asset', file: 'asset://localhost/D%3A/audio/asset.wav' } },
        { action: 'playAudio', time: 3, params: { id: 'file', file: 'file:///D%3A/audio/file.wav' } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);

    expect(projectResources.resolveForRead).not.toHaveBeenCalled();
    expect(sources.map((source) => source.path)).toEqual([
      '//server/share/sound.wav',
      'https://cdn.example.com/sound.wav',
      'D:/audio/asset.wav',
      'D:/audio/file.wav',
    ]);
  });

  it('surfaces project-resource resolution failures instead of falling back to a guessed audio path', async () => {
    const projectResources = {
      getCurrentProject: vi.fn(() => ({ id: 'open-project' })),
      resolveForRead: vi.fn().mockRejectedValue(new Error('audio resource is unavailable')),
    };
    mixer = new AudioMixer(fs as any, exp as any, projectResources as any);

    await expect(mixer.collectSources({
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [{ action: 'playAudio', time: 0, params: { file: 'sfx/missing.wav' } }],
    } as any, '/fallback', 0)).rejects.toThrow('audio resource is unavailable');
    expect(projectResources.resolveForRead).toHaveBeenCalledWith('sfx/missing.wav');
    expect(fs.exists).not.toHaveBeenCalled();
  });

  it('collectPreparedSources scans prepared actions without re-projecting a SceneScript', async () => {
    const scene = createPreparedScene([
      {
        id: 'bgm',
        time: 0,
        action: 'setBGM',
        source: { statementId: 'bgm-statement', outputKey: 'primary' },
        params: {
          file: { source: 'audio/theme.mp3', runtimeUri: 'asset://localhost/D%3A/project/audio/theme.mp3' },
          volume: 0.4,
          fadeIn: 1,
        },
      },
      {
        id: 'door',
        time: 1,
        action: 'playAudio',
        source: { statementId: 'door-statement', outputKey: 'primary' },
        params: {
          id: 'door',
          file: { source: 'sfx/door.wav', runtimeUri: 'D:/project/sfx/door.wav' },
          fadeIn: 0.25,
        },
      },
      {
        id: 'door-stop',
        time: 3,
        action: 'stopAudio',
        source: { statementId: 'door-statement', outputKey: 'stop' },
        params: { id: 'door', fadeOut: 0.5 },
      },
      {
        id: 'line',
        time: 4,
        action: 'dialogue',
        source: { statementId: 'line-statement', outputKey: 'primary' },
        params: {
          text: 'Hello',
          duration: 2,
          voice: { source: 'voice/line.wav', runtimeUri: 'file:///D%3A/project/voice/line.wav' },
          fadeOut: 0.25,
        },
      },
    ]);

    const sources = await mixer.collectPreparedSources(scene, 2);

    expect(sources).toEqual([
      {
        path: 'D:/project/audio/theme.mp3',
        delayMs: 0,
        startOffset: 2,
        volume: 0.4,
        loop: true,
      },
      {
        path: 'D:/project/sfx/door.wav',
        delayMs: 0,
        startOffset: 1,
        duration: 1,
        fadeOut: 0.5,
      },
      {
        path: 'D:/project/voice/line.wav',
        delayMs: 2000,
        duration: 2,
        fadeOut: 0.25,
      },
    ]);
  });

  it('collectPreparedSources keeps a legacy scene BGM fallback on the interval seam', async () => {
    const scene = {
      ...createPreparedScene([]),
      audio: { bgm: { file: 'legacy-bgm.mp3', volume: 0.8, fadeIn: 2 } },
    } as any;

    await expect(mixer.collectPreparedSources(scene, 1)).resolves.toEqual([{
      path: 'legacy-bgm.mp3',
      delayMs: 0,
      startOffset: 1,
      volume: 0.8,
      fadeIn: 1,
      fadeInStartGain: 0.5,
      loop: true,
    }]);
  });

  it('mix calls convert when sources are provided', async () => {
    const sources = [{ path: '/audio/bgm.mp3', delayMs: 0 }];
    const config = {
      fps: 60, codec: 'libx264', width: 1920,
      height: 1080, totalFrames: 600, bitrateMbps: 12,
    };

    const result = await mixer.mix('/tmp/vid.mp4', '/out/final.mp4', sources, config, false);

    expect(result.success).toBe(true);
    expect(exp.convert).toHaveBeenCalledWith('/tmp/vid.mp4', '/out/final.mp4', expect.objectContaining({
      audioSources: sources,
    }));
  });

  it('mix copies temp video when no sources and no transcode needed', async () => {
    const result = await mixer.mix(
      '/tmp/vid.mp4', '/out/final.mp4', [],
      { fps: 60, codec: 'libx264', width: 1920, height: 1080, totalFrames: 600, bitrateMbps: 12 },
      false,
    );

    expect(result.success).toBe(true);
    expect(fs.readFile).toHaveBeenCalledWith('/tmp/vid.mp4');
    expect(fs.writeFile).toHaveBeenCalledWith('/out/final.mp4', expect.any(ArrayBuffer));
  });

  it('collectSources keeps repeated dialogue voice files as separate timed sources', async () => {
    const sceneData: any = {
      sceneId: 'test',
      meta: { title: 'T' },
      timeline: [
        { action: 'dialogue', time: 1, params: { voice: 'same.wav' } },
        { action: 'dialogue', time: 2, params: { voice: 'same.wav' } },
      ],
    };

    const sources = await mixer.collectSources(sceneData, '/proj', 0);
    expect(sources.length).toBe(2);
    expect(sources.map((source) => source.delayMs)).toEqual([1000, 2000]);
  });
});
