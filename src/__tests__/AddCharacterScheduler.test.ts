import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import { scheduleAddCharacter } from '../engine/actions/addCharacter';
import type { SchedulerContext, TransformationProxy } from '../engine/actions/types';
import { computeSceneStateAtTime } from '../engine/RuntimeSceneState';

const live2DMocks = vi.hoisted(() => ({
  getAllCharacters: vi.fn(),
  removeCharacter: vi.fn(),
  addCharacter: vi.fn(),
  applyProxyTransform: vi.fn(),
  getModel: vi.fn(),
  getContainer: vi.fn(),
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: live2DMocks,
}));

function createContext(proxy: TransformationProxy): SchedulerContext {
  return {
    tl: gsap.timeline({ paused: true }),
    resolvePath: (p: string) => `resolved:${p}`,
    transformationProxies: new Map([['char1', proxy]]),
    environmentLayerProxies: new Map(),
    backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
    isReconstructing: () => false,
    audioElements: new Map(),
    takeSnapshot: vi.fn(),
    getCurrentTime: () => 0,
    getCharacterMeta: vi.fn(),
  };
}

describe('scheduleAddCharacter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live2DMocks.getAllCharacters.mockReturnValue(new Map());
    live2DMocks.getModel.mockReturnValue(undefined);
    live2DMocks.getContainer.mockReturnValue(undefined);
    gsap.globalTimeline.clear();
  });

  it('keeps an entering character transparent in computed scene state until fade-in progresses', () => {
    const scene = {
      meta: { characters: [] },
      timeline: [
        {
          time: 2,
          action: 'addCharacter',
          params: {
            id: 'char1',
            model: 'models/char.model3.json',
            enter: 'fadeIn',
            duration: 1,
            opacity: 0.75,
          },
        },
      ],
    } as any;

    expect(computeSceneStateAtTime(scene, 2).characters.get('char1').opacity).toBe(0);
    expect(computeSceneStateAtTime(scene, 2.5).characters.get('char1').opacity).toBeCloseTo(0.65625);
    expect(computeSceneStateAtTime(scene, 3.5).characters.get('char1').opacity).toBeCloseTo(0.75);
  });

  it('uses explicit opacity as the entrance target rather than the first-frame value', () => {
    const proxy = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, z: 0 };
    const ctx = createContext(proxy);

    live2DMocks.addCharacter.mockResolvedValue(undefined);

    scheduleAddCharacter(ctx, {
      time: 1,
      params: {
        id: 'char1',
        model: 'models/char.model3.json',
        enter: 'fadeIn',
        duration: 1,
        opacity: 0.6,
      },
    });

    ctx.tl.seek(1, false);
    expect(proxy.opacity).toBe(0);

    ctx.tl.seek(2, false);
    expect(proxy.opacity).toBeCloseTo(0.6);
  });

  it('does not fade an explicit enter none even when duration is present', () => {
    const scene = {
      meta: { characters: [] },
      timeline: [
        {
          time: 2,
          action: 'addCharacter',
          params: {
            id: 'char1',
            model: 'models/char.model3.json',
            enter: 'none',
            duration: 1,
            opacity: 0.8,
          },
        },
      ],
    } as any;

    expect(computeSceneStateAtTime(scene, 2).characters.get('char1').opacity).toBeCloseTo(0.8);
    expect(computeSceneStateAtTime(scene, 2.5).characters.get('char1').opacity).toBeCloseTo(0.8);

    const proxy = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, z: 0 };
    const ctx = createContext(proxy);
    live2DMocks.addCharacter.mockResolvedValue(undefined);

    scheduleAddCharacter(ctx, {
      time: 2,
      params: {
        id: 'char1',
        model: 'models/char.model3.json',
        enter: 'none',
        duration: 1,
        opacity: 0.8,
      },
    });

    ctx.tl.seek(2, false);
    expect(proxy.opacity).toBeCloseTo(0.8);
    ctx.tl.seek(2.5, false);
    expect(proxy.opacity).toBeCloseTo(0.8);
  });

  it('sets immediate opacity to one when there is no entrance and no explicit opacity', () => {
    const proxy = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 0, z: 0 };
    const ctx = createContext(proxy);
    live2DMocks.addCharacter.mockResolvedValue(undefined);

    scheduleAddCharacter(ctx, {
      time: 1,
      params: {
        id: 'char1',
        model: 'models/char.model3.json',
        enter: 'none',
      },
    });

    ctx.tl.seek(1, false);
    expect(proxy.opacity).toBeCloseTo(1);
  });
});
