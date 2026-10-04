import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const live2DMocks = vi.hoisted(() => ({
  setLipSyncParameter: vi.fn(),
  clearLipSyncParameters: vi.fn(),
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: live2DMocks,
}));

import LipSyncEngine from '../engine/LipSyncEngine';

describe('LipSyncEngine public behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    gsap.globalTimeline.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives the lip-sync channel for text speech and closes + releases the channel when stopped', () => {
    const engine = new LipSyncEngine();
    const timeline = engine.startTextDrivenLipSync('tomori', 'abc', 1.5);

    expect(engine.getTimeline('tomori')).toBe(timeline);

    timeline.pause(0);
    timeline.seek(0.1, false);

    // Mouth values must flow through the dedicated effect-channel API so a
    // concurrent custom motion cannot overwrite them per frame (ADR-0029).
    const mouthCalls = live2DMocks.setLipSyncParameter.mock.calls
      .filter(([characterId]) => characterId === 'tomori');
    expect(mouthCalls.some(([, parameterId, value]) =>
      parameterId === 'PARAM_MOUTH_OPEN_Y' && value > 0
    )).toBe(true);
    expect(mouthCalls.some(([, parameterId, value]) =>
      parameterId === 'ParamMouthOpenY' && value > 0
    )).toBe(true);

    engine.stop('tomori');

    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'PARAM_MOUTH_OPEN_Y', 0);
    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'ParamMouthOpenY', 0);
    // Ownership release lets later custom-motion curves drive the mouth again.
    expect(live2DMocks.clearLipSyncParameters).toHaveBeenCalledWith('tomori');
    expect(engine.getTimeline('tomori')).toBeUndefined();
  });

  it('releases the channel when the text timeline completes naturally', () => {
    const engine = new LipSyncEngine();
    const timeline = engine.startTextDrivenLipSync('tomori', 'ab', 1);

    timeline.seek(timeline.duration() + 0.01, false);

    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'PARAM_MOUTH_OPEN_Y', 0);
    expect(live2DMocks.clearLipSyncParameters).toHaveBeenCalledWith('tomori');
    expect(engine.getTimeline('tomori')).toBeUndefined();
  });

  it('does not animate mouths for parenthetical stage directions', () => {
    const engine = new LipSyncEngine();
    const timeline = engine.startTextDrivenLipSync('tomori', '（quiet breath）', 1);

    expect(timeline.duration()).toBe(0);
    timeline.seek(1, false);

    expect(live2DMocks.setLipSyncParameter.mock.calls.some(([, , value]) => value > 0)).toBe(false);

    engine.stop('tomori');
    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'PARAM_MOUTH_OPEN_Y', 0);
  });

  it('drives both mouth parameter aliases from audio volume frames', async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 4,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteFrequencyData: vi.fn((data: Uint8Array) => {
        data[0] = 255;
        data[1] = 255;
        data[2] = 255;
      }),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const audioContext = {
      state: 'running',
      destination: {},
      createMediaElementSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('AudioContext', vi.fn(function AudioContext() {
      return audioContext;
    }));

    const engine = new LipSyncEngine();
    const audio = {} as HTMLAudioElement;
    await engine.startAudioDrivenLipSync('tomori', audio);

    frameCallbacks[0](0);

    const mouthCalls = live2DMocks.setLipSyncParameter.mock.calls
      .filter(([characterId]) => characterId === 'tomori');
    expect(mouthCalls).toContainEqual(['tomori', 'PARAM_MOUTH_OPEN_Y', expect.any(Number)]);
    expect(mouthCalls).toContainEqual(['tomori', 'ParamMouthOpenY', expect.any(Number)]);
  });

  it('computes deterministic text mouth openness that is stable across calls', () => {
    const engine = new LipSyncEngine();
    const text = '你好，世界。这是一段测试台词！';
    const duration = 2.4;
    for (const offset of [0.05, 0.3, 0.7, 1.2, 1.8, 2.2]) {
      // 同一 (text, duration, offset) 反复求值必须一致（播放 tick 与 scrub 共用同一求值器）
      expect(engine.computeTextMouthOpenness(text, duration, offset))
        .toBe(engine.computeTextMouthOpenness(text, duration, offset));
    }
    // 边界：起始/结束闭合，说话窗口内开口
    expect(engine.computeTextMouthOpenness(text, duration, 0)).toBe(0);
    expect(engine.computeTextMouthOpenness(text, duration, duration)).toBe(0);
    expect(engine.computeTextMouthOpenness(text, duration, 1.2)).toBeGreaterThan(0);
  });

  it('never opens the mouth for parenthetical stage directions or invalid inputs', () => {
    const engine = new LipSyncEngine();
    for (const offset of [0, 0.3, 0.9, 1.2]) {
      expect(engine.computeTextMouthOpenness('（quiet breath）', 1, offset)).toBe(0);
    }
    expect(engine.computeTextMouthOpenness('', 1, 0.5)).toBe(0);
    expect(engine.computeTextMouthOpenness('abc', 0, 0.5)).toBe(0);
    expect(engine.computeTextMouthOpenness('abc', 2, -1)).toBe(0);
  });

  it('setTextMouthAt drives the lip-sync channel and stop() closes + releases it', () => {
    const engine = new LipSyncEngine();
    engine.setTextMouthAt('tomori', 'hello world', 2, 0.6);
    const mouthCalls = live2DMocks.setLipSyncParameter.mock.calls
      .filter(([characterId]) => characterId === 'tomori');
    expect(mouthCalls.some(([, parameterId, value]) =>
      parameterId === 'PARAM_MOUTH_OPEN_Y' && value > 0
    )).toBe(true);
    expect(mouthCalls.some(([, parameterId, value]) =>
      parameterId === 'ParamMouthOpenY' && value > 0
    )).toBe(true);

    engine.stop('tomori');
    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'PARAM_MOUTH_OPEN_Y', 0);
    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'ParamMouthOpenY', 0);
    expect(live2DMocks.clearLipSyncParameters).toHaveBeenCalledWith('tomori');
  });

  it('closes both mouth parameter aliases and releases the channel when audio-driven lip sync stops', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 4,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteFrequencyData: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const audioContext = {
      state: 'running',
      destination: {},
      createMediaElementSource: vi.fn(() => source),
      createAnalyser: vi.fn(() => analyser),
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('AudioContext', vi.fn(function AudioContext() {
      return audioContext;
    }));

    const engine = new LipSyncEngine();
    await engine.startAudioDrivenLipSync('tomori', {} as HTMLAudioElement);

    live2DMocks.setLipSyncParameter.mockClear();
    live2DMocks.clearLipSyncParameters.mockClear();
    engine.stop('tomori');

    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'PARAM_MOUTH_OPEN_Y', 0);
    expect(live2DMocks.setLipSyncParameter).toHaveBeenCalledWith('tomori', 'ParamMouthOpenY', 0);
    expect(live2DMocks.clearLipSyncParameters).toHaveBeenCalledWith('tomori');
  });
});
