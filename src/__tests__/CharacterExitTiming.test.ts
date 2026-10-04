import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { scheduleRemoveCharacter } from '../engine/actions/removeCharacter';
import type { SchedulerContext, TransformationProxy } from '../engine/actions/types';

const mocks = vi.hoisted(() => ({
  live2D: {
    removeCharacter: vi.fn(),
  },
  animationDirector: {
    characterExit: vi.fn(),
  },
}));

vi.mock('../engine/Live2DManager', () => ({ live2DManager: mocks.live2D }));
vi.mock('../engine/AnimationDirector', () => ({ animationDirector: mocks.animationDirector }));

function createContext(
  proxy: TransformationProxy,
  isReconstructing: () => boolean = () => false,
): SchedulerContext {
  return {
    tl: gsap.timeline({ paused: true }),
    resolvePath: (value: string) => value,
    transformationProxies: new Map([['tomori', proxy]]),
    environmentLayerProxies: new Map(),
    backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
    isReconstructing,
    audioElements: new Map(),
    takeSnapshot: vi.fn(),
    getCurrentTime: () => 0,
    getCharacterMeta: vi.fn(),
  };
}

describe('Task 2 character exit scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gsap.globalTimeline.clear();
    mocks.animationDirector.characterExit.mockImplementation((
      characterId: string,
      _preset: string,
      duration: number,
      ease: string,
      proxy: TransformationProxy,
    ) => gsap.timeline().to(proxy, {
      opacity: 0,
      duration,
      ease,
      onComplete: () => mocks.live2D.removeCharacter(characterId),
    }));
  });

  it('adds the exit child to the scheduler timeline and removes only at completion', () => {
    const proxy = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 };
    const ctx = createContext(proxy);

    scheduleRemoveCharacter(ctx, {
      time: 2,
      params: {
        id: 'tomori',
        exit: 'fadeOut',
        duration: 0.6,
        exitEase: 'power2.in',
      },
    });

    const child = mocks.animationDirector.characterExit.mock.results[0].value;
    expect(ctx.tl.getChildren(false, false, true)).toContain(child);
    expect(ctx.tl.duration()).toBeCloseTo(2.6, 6);

    ctx.tl.seek(2.3, false);
    expect(proxy.opacity).toBeLessThan(1);
    expect(mocks.live2D.removeCharacter).not.toHaveBeenCalled();

    ctx.tl.pause();
    expect(ctx.tl.paused()).toBe(true);
    ctx.tl.seek(2.6, false);
    expect(mocks.live2D.removeCharacter).toHaveBeenCalledTimes(1);
  });

  it('keeps immediate removal on the master timeline and suppresses it during reconstruction', () => {
    let reconstructing = true;
    const ctx = createContext(
      { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
      () => reconstructing,
    );

    scheduleRemoveCharacter(ctx, {
      time: 1,
      params: { id: 'tomori', exit: 'none' },
    });

    expect(ctx.tl.duration()).toBeCloseTo(1.001, 6);
    ctx.tl.seek(1.001, false);
    expect(mocks.live2D.removeCharacter).not.toHaveBeenCalled();

    reconstructing = false;
    ctx.tl.seek(0, false);
    ctx.tl.seek(1.001, false);
    expect(mocks.live2D.removeCharacter).toHaveBeenCalledWith('tomori');
  });
});
