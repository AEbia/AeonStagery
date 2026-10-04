import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import {
  scheduleCharacterBlink,
  scheduleCharacterLookAt,
  schedulePlayMotion,
  scheduleSetExpression,
  scheduleSetCharacterRimLight,
} from '../engine/actions/characterStateActions';
import type { SchedulerContext } from '../engine/actions/types';

const live2DMocks = vi.hoisted(() => ({
  lookAt: vi.fn(),
  getPoint: vi.fn<(id: string, part: string) => { x: number; y: number } | null>().mockReturnValue(null),
  setBlink: vi.fn(),
  playMotion: vi.fn(),
  setExpression: vi.fn(),
  setRimLight: vi.fn(),
  resetRimLight: vi.fn(),
}));

vi.mock('../engine/Live2DManager', () => ({ live2DManager: live2DMocks }));

function createContext(): SchedulerContext {
  return {
    tl: gsap.timeline({ paused: true }),
    resolvePath: (value: string) => value,
    transformationProxies: new Map(),
    environmentLayerProxies: new Map(),
    backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
    isReconstructing: () => false,
    audioElements: new Map(),
    takeSnapshot: vi.fn(),
    getCurrentTime: () => 0,
    getCharacterMeta: vi.fn(),
  };
}

describe('Task 2 character state scheduler contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gsap.globalTimeline.clear();
  });

  it('uses the semantic point tuple and keeps old scalar look-at actions readable', () => {
    const pointContext = createContext();
    scheduleCharacterLookAt(pointContext, {
      time: 1,
      params: { id: 'tomori', point: [0.25, -0.4], duration: 0.75 },
    });
    pointContext.tl.seek(1.001, false);
    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith('tomori', 0.25, -0.4, 0.75);

    const legacyContext = createContext();
    scheduleCharacterLookAt(legacyContext, {
      time: 2,
      params: { id: 'tomori', focusX: -0.2, focusY: 0.6 },
    });
    legacyContext.tl.seek(2.001, false);
    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith('tomori', -0.2, 0.6, 0.5);
  });

  it('returns disabled look-at to the neutral point', () => {
    const ctx = createContext();
    scheduleCharacterLookAt(ctx, {
      time: 0,
      params: { id: 'tomori', point: [0.8, 0.9], enabled: false },
    });
    ctx.tl.seek(0.001, false);

    expect(live2DMocks.lookAt).toHaveBeenCalledWith('tomori', 0, 0, 0.5);
  });

  it('turns a character gaze target into a directional focus instead of staring ahead', () => {
    const ctx = createContext();
    live2DMocks.getPoint = vi.fn((id: string) => {
      if (id === 'tomori') return { x: 0.25, y: 0.6 };
      if (id === 'anon') return { x: 0.75, y: 0.6 };
      return null;
    });

    scheduleCharacterLookAt(ctx, {
      time: 0,
      params: { id: 'tomori', target: 'anon', point: [0, 0], duration: 0.75 },
    });
    ctx.tl.seek(0.001, false);

    // anon sits to the right at equal height → full rightward gaze, not [0, 0].
    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith('tomori', expect.closeTo(1), expect.closeTo(0), 0.75);
  });

  it('aims a gaze target vertically and scales it by look-at intensity', () => {
    live2DMocks.getPoint = vi.fn((id: string) => {
      if (id === 'tomori') return { x: 0.5, y: 0.8 };
      if (id === 'anon') return { x: 0.5, y: 0.3 };
      return null;
    });

    const ctx = createContext();
    scheduleCharacterLookAt(ctx, {
      time: 0,
      params: { id: 'tomori', target: 'anon' },
    });
    ctx.tl.seek(0.001, false);

    // anon is straight above → full upward gaze (positive focusY looks up).
    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith('tomori', expect.closeTo(0, 3), expect.closeTo(1), 0.5);

    const softCtx = createContext();
    scheduleCharacterLookAt(softCtx, {
      time: 0,
      params: { id: 'tomori', target: 'anon', intensity: 0.5 },
    });
    softCtx.tl.seek(0.001, false);

    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith('tomori', expect.closeTo(0, 3), expect.closeTo(0.5), 0.5);
  });

  it('uses proportional target offset instead of binary left/right gaze', () => {
    live2DMocks.getPoint = vi.fn((id: string) => {
      if (id === 'tomori') return { x: 0.5, y: 0.5 };
      if (id === 'anon') return { x: 0.6, y: 0.5 };
      return null;
    });

    const ctx = createContext();
    scheduleCharacterLookAt(ctx, {
      time: 0,
      params: { id: 'tomori', target: 'anon' },
    });
    ctx.tl.seek(0.001, false);

    // Target is only slightly to the right: gaze should be a small rightward
    // value (0.2 = displacement × STAGE_TO_FOCUS_SCALE), not hard-left/hard-right.
    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith(
      'tomori',
      expect.closeTo(0.2, 6),
      expect.closeTo(0, 6),
      0.5,
    );
  });

  it('falls back to the semantic point when a gaze target cannot be resolved', () => {
    live2DMocks.getPoint = vi.fn(() => null);

    const ctx = createContext();
    scheduleCharacterLookAt(ctx, {
      time: 0,
      params: { id: 'tomori', target: 'ghost', point: [0.25, -0.4] },
    });
    ctx.tl.seek(0.001, false);

    expect(live2DMocks.lookAt).toHaveBeenLastCalledWith('tomori', 0.25, -0.4, 0.5);
  });

  it('converts semantic blink seconds to runtime milliseconds exactly once', () => {
    const ctx = createContext();
    scheduleCharacterBlink(ctx, {
      time: 1,
      params: { id: 'tomori', enabled: false, interval: 2.5 },
    });
    ctx.tl.seek(1.001, false);

    expect(live2DMocks.setBlink).toHaveBeenCalledWith('tomori', false, 2500);
  });

  it('uses the four-second semantic default and does not double-convert it', () => {
    const ctx = createContext();
    scheduleCharacterBlink(ctx, {
      time: 0,
      params: { id: 'tomori' },
    });
    ctx.tl.seek(0.001, false);

    expect(live2DMocks.setBlink).toHaveBeenCalledWith('tomori', true, 4000);
  });

  it('clears rim light on reset and preserves its transition duration', () => {
    const ctx = createContext();
    scheduleSetCharacterRimLight(ctx, {
      time: 1,
      params: { id: 'tomori', mode: 'reset', duration: 0.4 },
    });
    ctx.tl.seek(1.001, false);

    expect(live2DMocks.resetRimLight).toHaveBeenCalledWith('tomori', 0.4);
    expect(live2DMocks.setRimLight).not.toHaveBeenCalled();
  });

  it('does not require an onStart callback when a seek suppresses timeline events', () => {
    const ctx = createContext();
    scheduleCharacterBlink(ctx, {
      time: 1,
      params: { id: 'tomori', enabled: false, interval: 2.5 },
    });

    ctx.tl.seek(1.001, true);

    expect(live2DMocks.setBlink).not.toHaveBeenCalled();
  });

  it('only schedules complete play-motion actions and snapshots them at the trigger time', () => {
    const incomplete = createContext();
    schedulePlayMotion(incomplete, {
      time: 1,
      params: { id: 'tomori' },
    });

    incomplete.tl.seek(1.001, false);
    expect(live2DMocks.playMotion).not.toHaveBeenCalled();
    expect(incomplete.takeSnapshot).not.toHaveBeenCalled();

    const ctx = createContext();
    schedulePlayMotion(ctx, {
      time: 1,
      params: { id: 'tomori', motion: 'wave' },
    });

    ctx.tl.seek(1.25, false);

    expect(live2DMocks.playMotion).toHaveBeenCalledWith('tomori', 'wave', 3, expect.closeTo(0.001), expect.closeTo(1.001));
    expect(ctx.takeSnapshot).toHaveBeenCalledWith(expect.closeTo(1.001));
  });

  it('requires an expression target while still allowing an explicit expression reset', () => {
    const missingTarget = createContext();
    scheduleSetExpression(missingTarget, {
      time: 1,
      params: { expression: 'smile' },
    });

    missingTarget.tl.seek(1.001, false);
    expect(live2DMocks.setExpression).not.toHaveBeenCalled();

    const ctx = createContext();
    scheduleSetExpression(ctx, {
      time: 2,
      params: { id: 'tomori', expression: null },
    });

    ctx.tl.seek(2.001, false);
    expect(live2DMocks.setExpression).toHaveBeenCalledWith('tomori', null);
  });

  it('defers expression side effects to state synchronization during reconstruction', () => {
    const ctx = createContext();
    ctx.isReconstructing = () => true;

    scheduleSetExpression(ctx, {
      time: 2,
      params: { id: 'tomori', expression: 'smile' },
    });

    ctx.tl.seek(2.001, false);

    expect(live2DMocks.setExpression).not.toHaveBeenCalled();
  });
});
