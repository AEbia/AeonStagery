import { describe, it, expect, beforeEach, vi } from 'vitest';
import gsap from 'gsap';
import {
  AudioCoordinator,
  markAudioElementStop,
} from '../engine/coordinators/AudioCoordinator';
import { schedulePlayAudio, scheduleSetBGM, scheduleStopAudio } from '../engine/actions/audioActions';

function createMockAudioElement() {
  const audio = {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    currentTime: 0,
    duration: 10,
    src: '',
    volume: 1,
    loop: false,
  };
  return audio as any as HTMLAudioElement;
}

describe('AudioCoordinator', () => {
  let coordinator: AudioCoordinator;

  beforeEach(() => {
    coordinator = new AudioCoordinator();
  });

  it('scheduleAudio adds a BGM entry with startTime=0', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('bgm', audio, 0, Infinity);
    coordinator.sync(5.0, true);

    expect(audio.currentTime).toBeCloseTo(5.0, 0);
    expect(audio.play).toHaveBeenCalled();
  });

  it('scheduleAudio adds a voice entry with delay offset', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('voice-char1', audio, 3.0, 5.0);
    coordinator.sync(5.0, true);

    // Voice at time 5.0, started at 3.0 -> offset = 2.0
    expect(audio.currentTime).toBeCloseTo(2.0, 0);
    expect(audio.play).toHaveBeenCalled();
  });

  it('sync pauses audio when playing is false', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('bgm', audio, 0, Infinity);
    coordinator.sync(3.0, false);

    expect(audio.pause).toHaveBeenCalled();
  });

  it('sync plays audio when playing is true', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('bgm', audio, 0, Infinity);
    coordinator.sync(3.0, true);

    expect(audio.play).toHaveBeenCalled();
  });

  it('sync resumes an attached audio graph before playback', () => {
    const resumeAudioGraph = vi.fn();
    coordinator = new AudioCoordinator(resumeAudioGraph);
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('voice-char1', audio, 0, 5);

    coordinator.sync(1.0, true);

    expect(resumeAudioGraph).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalled();
  });

  it('does not repeatedly resume the audio graph during continuous playback', () => {
    const resumeAudioGraph = vi.fn();
    coordinator = new AudioCoordinator(resumeAudioGraph);
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('voice-char1', audio, 0, 5);

    coordinator.sync(1, true);
    coordinator.sync(1.016, true);

    expect(resumeAudioGraph).toHaveBeenCalledTimes(1);
  });

  it('sync removes voice when time is past its duration', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('voice-char1', audio, 3.0, 2.0);
    coordinator.sync(6.0, true);

    expect(audio.pause).toHaveBeenCalled();
    expect(coordinator.getEntries().has('voice-char1')).toBe(false);
  });

  it('clear removes all audio and pauses them', () => {
    const a1 = createMockAudioElement();
    const a2 = createMockAudioElement();
    coordinator.scheduleAudio('bgm', a1, 0, Infinity);
    coordinator.scheduleAudio('voice-char1', a2, 3.0, 2.0);
    coordinator.clear();

    expect(a1.pause).toHaveBeenCalled();
    expect(a1.src).toBe('');
    expect(a2.pause).toHaveBeenCalled();
    expect(a2.src).toBe('');
    expect(coordinator.getEntries().size).toBe(0);
  });

  it('sync handles BGM loop-aware positioning', () => {
    const audio = createMockAudioElement();
    (audio as any).duration = 10;
    coordinator.scheduleAudio('bgm', audio, 0, Infinity);
    coordinator.sync(25.0, true);

    // 25 % 10 = 5
    expect(audio.currentTime).toBeCloseTo(5.0, 0);
  });

  it('preserves the naturally advancing audio clock during continuous playback', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('bgm', audio, 0, Infinity);

    coordinator.sync(2, true);
    audio.currentTime = 2.05;
    coordinator.sync(2.06, true);

    expect(audio.currentTime).toBeCloseTo(2.05);
  });

  it('positions an audio interval at its offset when it first becomes active', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('voice', audio, 2, 5);

    coordinator.sync(2.1, true);

    expect(audio.currentTime).toBeCloseTo(0.1);
  });

  it('repositions audio when the timeline moves backward during playback', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('voice', audio, 0, 10);

    coordinator.sync(5, true);
    coordinator.sync(4.9, true);

    expect(audio.currentTime).toBeCloseTo(4.9);
  });

  it('uses one linear fade envelope for volume and seeking into an active interval', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('sfx', audio, 2, 4, {
      volume: 0.8,
      fadeIn: 1,
      fadeOut: 1,
    });

    coordinator.sync(2.5, true);
    expect(audio.volume).toBeCloseTo(0.4);
    expect(audio.currentTime).toBeCloseTo(0.5);

    coordinator.sync(5.5, true);
    expect(audio.volume).toBeCloseTo(0.4);

    coordinator.sync(6, true);
    expect(audio.pause).toHaveBeenCalled();
    expect(coordinator.getEntries().has('sfx')).toBe(false);

    // A backward seek reconstructs the same interval instead of relying on a
    // one-shot play callback having run while the timeline crossed its start.
    coordinator.sync(3, true);
    expect(audio.volume).toBeCloseTo(0.8);
    expect(audio.currentTime).toBeCloseTo(1);
    expect(audio.play).toHaveBeenCalled();
  });

  it('uses the same fade envelope for a BGM interval', () => {
    const audio = createMockAudioElement();
    audio.volume = 0;
    coordinator.scheduleAudio('bgm', audio, 0, Number.POSITIVE_INFINITY, {
      volume: 0.5,
      fadeIn: 2,
      loop: true,
    });

    coordinator.sync(1, true);
    expect(audio.volume).toBeCloseTo(0.25);
    coordinator.sync(2, true);
    expect(audio.volume).toBeCloseTo(0.5);
  });

  it('applies stop fade metadata at the stop interval and can seek back into it', () => {
    const audio = createMockAudioElement();
    coordinator.scheduleAudio('sfx', audio, 0, Number.POSITIVE_INFINITY, {
      volume: 1,
    });
    markAudioElementStop(audio, 5, 2);

    coordinator.sync(4, true);
    expect(audio.volume).toBeCloseTo(0.5);
    expect(audio.play).toHaveBeenCalled();

    coordinator.sync(5, true);
    expect(audio.pause).toHaveBeenCalled();
    expect(coordinator.getEntries().has('sfx')).toBe(false);

    coordinator.sync(4.5, true);
    expect(audio.volume).toBeCloseTo(0.25);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('pauses the scheduled audio from the stop timeline callback', () => {
    const audio = createMockAudioElement();
    const timeline = gsap.timeline({ paused: true });
    const audioElements = new Map([
      ['door', { audio, startTime: 0, duration: 10 }],
    ]);

    scheduleStopAudio({
      tl: timeline,
      isReconstructing: () => false,
      audioElements,
    } as any, {
      time: 2,
      params: { id: 'door' },
    });

    timeline.seek(2.001, false);

    expect(audio.pause).toHaveBeenCalled();
  });

  it('audio actions register fade intervals before playback so direct seeks are reconstructable', async () => {
    const previousAudio = globalThis.Audio;
    const created: Array<ReturnType<typeof createMockAudioElement>> = [];
    class TestAudio {
      currentTime = 0;
      duration = 20;
      src = '';
      volume = 1;
      loop = false;
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      constructor(source = '') {
        this.src = source;
        created.push(this as any);
      }
    }
    (globalThis as any).Audio = TestAudio;

    const audioElements = {
      set: (key: string, entry: { audio: HTMLAudioElement; startTime: number; duration: number }) =>
        coordinator.scheduleAudio(key, entry.audio, entry.startTime, entry.duration),
      get: (key: string) => {
        const entry = coordinator.getEntries().get(key);
        return entry ? { audio: entry.audio, startTime: entry.startTime, duration: entry.duration } : undefined;
      },
      delete: (key: string) => coordinator.getEntries().delete(key),
      clear: () => coordinator.clear(),
      values: () => Array.from(coordinator.getEntries().values()),
    };
    const ctx = {
      tl: gsap.timeline({ paused: true }),
      resolvePath: (value: string) => value,
      resolvePathAsync: async (value: string) => `resolved:${value}`,
      transformationProxies: new Map(),
      environmentLayerProxies: new Map(),
      backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
      isReconstructing: () => false,
      audioElements,
      takeSnapshot: vi.fn(),
      getCurrentTime: () => 0,
      getCharacterMeta: vi.fn(),
    } as any;

    schedulePlayAudio(ctx, {
      time: 1,
      params: { id: 'door', file: 'door.wav', volume: 0.8, fadeIn: 2, duration: 4 },
    });
    scheduleStopAudio(ctx, {
      time: 5,
      params: { id: 'door', fadeOut: 1 },
    });
    await Promise.resolve();

    expect(created).toHaveLength(1);
    expect((created[0] as any).src).toBe('resolved:door.wav');
    coordinator.sync(2, true);
    expect(created[0].volume).toBeCloseTo(0.4);
    coordinator.sync(4.5, true);
    expect(created[0].volume).toBeCloseTo(0.4);

    // Seeking back from after the stop still finds the original interval.
    coordinator.sync(6, false);
    coordinator.sync(3, true);
    expect(created[0].volume).toBeCloseTo(0.8);
    expect(created[0].play).toHaveBeenCalled();

    if (previousAudio) (globalThis as any).Audio = previousAudio;
    else delete (globalThis as any).Audio;
  });

  it('ignores a whitespace one-shot audio file without resolving an asset', () => {
    const resolvePath = vi.fn(() => {
      throw new Error('empty audio should not resolve a runtime path');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const set = vi.fn();

    try {
      schedulePlayAudio({
        tl: gsap.timeline({ paused: true }),
        resolvePath,
        audioElements: { set },
        isReconstructing: () => false,
      } as any, {
        time: 1,
        params: { id: 'door', file: '   ' },
      });

      expect(resolvePath).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not construct an empty audio source when synchronous project resolution fails', () => {
    const previousAudio = globalThis.Audio;
    const constructorArgs: unknown[][] = [];
    class TestAudio {
      constructor(...args: unknown[]) {
        constructorArgs.push(args);
      }
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as any).Audio = TestAudio;

    try {
      const ctx = {
        tl: gsap.timeline({ paused: true }),
        resolvePath: () => { throw new Error('project resource unavailable'); },
        resolvePathAsync: undefined,
        audioElements: { set: vi.fn() },
        isReconstructing: () => false,
      } as any;

      schedulePlayAudio(ctx, { time: 0, params: { file: 'sfx/missing.wav' } });

      expect(constructorArgs).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resolve audio asset'),
        expect.any(Error),
      );
      expect(ctx.audioElements.set).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (previousAudio) (globalThis as any).Audio = previousAudio;
      else delete (globalThis as any).Audio;
    }
  });

  it('observes asynchronous project-resource resolution failures and disposes the placeholder', async () => {
    const previousAudio = globalThis.Audio;
    const constructorArgs: unknown[][] = [];
    const created: any[] = [];
    class TestAudio {
      src = '';
      volume = 1;
      loop = false;
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      constructor(...args: unknown[]) {
        constructorArgs.push(args);
        created.push(this);
      }
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as any).Audio = TestAudio;

    try {
      const set = vi.fn();
      const ctx = {
        tl: gsap.timeline({ paused: true }),
        resolvePath: (value: string) => value,
        resolvePathAsync: vi.fn().mockRejectedValue(new Error('mounted audio unavailable')),
        audioElements: { set },
        isReconstructing: () => false,
      } as any;

      schedulePlayAudio(ctx, { time: 0, params: { file: '@mount/library/theme.mp3' } });
      await Promise.resolve();
      await Promise.resolve();

      expect(constructorArgs).toEqual([[]]);
      expect(set).toHaveBeenCalledTimes(1);
      expect(created[0]).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resolve audio asset'),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
      if (previousAudio) (globalThis as any).Audio = previousAudio;
      else delete (globalThis as any).Audio;
    }
  });

  it('marks the previous BGM interval to stop when a replacement BGM is scheduled', () => {
    const previousAudioConstructor = globalThis.Audio;
    class TestAudio {
      currentTime = 0;
      duration = 20;
      src = '';
      volume = 1;
      loop = false;
      paused = true;
      play = vi.fn().mockResolvedValue(undefined);
      pause = vi.fn();
      constructor(source = '') {
        this.src = source;
      }
    }
    (globalThis as any).Audio = TestAudio;

    try {
      const previous = createMockAudioElement();
      (previous as any).duration = 20;
      const audioElements = new Map([
        ['bgm', { audio: previous, startTime: 0, duration: Number.POSITIVE_INFINITY }],
      ]);

      scheduleSetBGM({
        tl: gsap.timeline({ paused: true }),
        resolvePath: (value: string) => value,
        audioElements,
        isReconstructing: () => false,
      } as any, {
        time: 4,
        params: { file: 'bgm/replacement.mp3', fadeOut: 1 },
      });

      const observer = new AudioCoordinator();
      observer.scheduleAudio('old-bgm', previous, 0, Number.POSITIVE_INFINITY, { volume: 1 });

      observer.sync(3.5, true);
      expect(previous.volume).toBeCloseTo(0.5);

      observer.sync(4, true);
      expect(previous.pause).toHaveBeenCalled();
    } finally {
      if (previousAudioConstructor) (globalThis as any).Audio = previousAudioConstructor;
      else delete (globalThis as any).Audio;
    }
  });

  it('treats a whitespace BGM file as clearing the current BGM without resolving a new asset', () => {
    const previous = createMockAudioElement();
    (previous as any).duration = 20;
    const audioElements = new Map([
      ['bgm', { audio: previous, startTime: 0, duration: Number.POSITIVE_INFINITY }],
    ]);
    const resolvePath = vi.fn(() => {
      throw new Error('BGM clear should not resolve a replacement asset');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      scheduleSetBGM({
        tl: gsap.timeline({ paused: true }),
        resolvePath,
        audioElements,
        isReconstructing: () => false,
      } as any, {
        time: 4,
        params: { file: '   ', fadeOut: 1 },
      });

      expect(resolvePath).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      const observer = new AudioCoordinator();
      observer.scheduleAudio('old-bgm', previous, 0, Number.POSITIVE_INFINITY, { volume: 1 });
      observer.sync(3.5, true);
      expect(previous.volume).toBeCloseTo(0.5);

      observer.sync(4, true);
      expect(previous.pause).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
