// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import { RimLightFilter } from '../engine/RimLightFilter';

vi.mock('../engine/Live2DMotionController', () => ({
  Live2DMotionController: class {
    constructor() {}
  },
}));

afterEach(() => {
  gsap.globalTimeline.clear();
});

describe('Live2DManager rim light', () => {
  it('mounts and configures a directional rim filter on the character container', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const container = new PIXI.Container();
    const entry: any = {
      id: 'soyo',
      model: {},
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      injectedParams: {},
    };

    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).containers = new Map([['soyo', container]]);

    manager.setRimLight('soyo', '#00aaff', 0.8, 14, 30, 3, 0);

    const filter = container.filters?.[0] as RimLightFilter;
    expect(filter).toBeInstanceOf(RimLightFilter);
    expect(filter.color).toBe(0x00aaff);
    expect(filter.distance).toBe(14);
    expect(filter.rotation).toBe(30);
    expect(filter.blur).toBe(3);
    expect(filter.enabled).toBe(true);
    expect(entry.rimFilter).toBe(filter);
  });

  it('fades an existing rim light to zero without replacing its style', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const container = new PIXI.Container();
    const entry: any = {
      id: 'soyo',
      model: {},
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      injectedParams: {},
    };

    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).containers = new Map([['soyo', container]]);

    manager.setRimLight('soyo', '#00aaff', 0.8, 14, 30, 3, 0);
    const filter = container.filters?.[0] as RimLightFilter;

    manager.resetRimLight('soyo', 1);
    const tween = gsap.getTweensOf(entry.rimProxy)[0];
    expect(tween).toBeTruthy();
    tween.progress(0.5);
    expect(filter.alpha).toBeCloseTo(0.4);
    expect(filter.color).toBe(0x00aaff);

    tween.progress(1);
    expect(filter.alpha).toBe(0);
    expect(filter.enabled).toBe(false);
  });

  it('cancels an old alpha tween before seek reconciliation writes the state', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const container = new PIXI.Container();
    const entry: any = {
      id: 'soyo',
      model: {},
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      injectedParams: {},
    };

    (manager as any).characters = new Map([['soyo', entry]]);
    (manager as any).containers = new Map([['soyo', container]]);

    manager.setRimLight('soyo', '#00aaff', 1, 14, 30, 3, 2);
    manager.reconcileRimLights(0, {
      sceneId: 'seek-scene',
      meta: { title: 'Seek' },
      timeline: [],
    });

    expect(entry.rimProxy.alpha).toBe(0);
    expect(gsap.getTweensOf(entry.rimProxy)).toHaveLength(0);
  });

  it('applies a rim light queued before an independent model is mounted', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const container = new PIXI.Container();
    const entry: any = {
      id: 'soyo',
      model: {},
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      injectedParams: {},
    };

    (manager as any).characters = new Map();
    (manager as any).containers = new Map([['soyo', container]]);

    manager.setRimLight('soyo', '#00aaff', 0.8, 14, 30, 3, 0);
    (manager as any).characters.set('soyo', entry);
    (manager as any).applyPendingCharacterVisualState('soyo');

    const filter = container.filters?.[0] as RimLightFilter;
    expect(filter).toBeInstanceOf(RimLightFilter);
    expect(filter.color).toBe(0x00aaff);
    expect(filter.alpha).toBeCloseTo(0.8);
    expect(filter.enabled).toBe(true);
  });

  it('retains an absolute rim state reconciled before the model mounts', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const container = new PIXI.Container();
    const entry: any = {
      id: 'soyo',
      model: {},
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      injectedParams: {},
    };

    (manager as any).characters = new Map();
    (manager as any).containers = new Map([['soyo', container]]);
    manager.reconcileRimLights(1, {
      sceneId: 'rim-light-load',
      meta: { title: 'Rim light load' },
      timeline: [{
        time: 0,
        action: 'setCharacterRimLight',
        params: {
          id: 'soyo',
          color: '#ff8800',
          intensity: 0.6,
          thickness: 12,
          angle: 25,
          softness: 4,
          duration: 0,
        },
      }],
    } as any);

    (manager as any).characters.set('soyo', entry);
    (manager as any).applyPendingCharacterVisualState('soyo');

    const filter = container.filters?.[0] as RimLightFilter;
    expect(filter).toBeInstanceOf(RimLightFilter);
    expect(filter.color).toBe(0xff8800);
    expect(filter.alpha).toBeCloseTo(0.6);
    expect(filter.distance).toBe(12);
    expect(filter.rotation).toBe(25);
  });
});
