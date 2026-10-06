import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { Live2DCompositeModel } from '../engine/Live2DCompositeModel';
import { Live2DMotionController } from '../engine/Live2DMotionController';
import { captureModelSnapshot } from '../engine/Live2DConfig';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

vi.mock('untitled-pixi-live2d-engine/cubism-legacy', () => ({
  config: {
    motionFadingDuration: 500,
    idleMotionFadingDuration: 2000,
  },
}));

function createMotionManager() {
  const mm = {
    playing: false,
    state: {
      currentGroup: undefined as string | undefined,
      reservedGroup: undefined as string | undefined,
    },
    _motionQueueManager: {
      stopAllMotions: vi.fn(),
    },
    update: vi.fn(),
    loadMotion: vi.fn().mockResolvedValue(undefined),
    startMotion: vi.fn().mockImplementation(async (group: string) => {
      mm.state.currentGroup = group;
      mm.playing = true;
      return true;
    }),
    stopAllMotions: vi.fn(),
  };
  return mm;
}

function createModel(name: string) {
  const model = new PIXI.Container() as any;
  model.name = name;
  model.update = vi.fn();
  const params = new Float32Array([0, 0, 0]);
  const opacities = new Float32Array([0, 0]);
  const mm = createMotionManager();
  model.internalModel = {
    settings: {
      motions: {
        angry03: [{}],
      },
    },
    motionManager: mm,
    parameterValues: params,
    partOpacities: opacities,
    coreModel: {
      getParameterValues: () => params,
      getPartOpacities: () => opacities,
    },
  };
  return { model, mm, params, opacities };
}

describe('Live2DMotionController composite motion fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the same motion on the main model and all sub-models', async () => {
    (globalThis as any).window = {};

    const main = createModel('main');
    const arm = createModel('arm');
    const face = createModel('face');

    const composite = new Live2DCompositeModel(main.model, [arm.model, face.model]);
    const entry: any = {
      id: 'soyo',
      model: composite,
      motionEpoch: 1,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0, 0, true, 1);

    expect(main.mm.loadMotion).toHaveBeenCalledWith('angry03', 0);
    expect(arm.mm.loadMotion).toHaveBeenCalledWith('angry03', 0);
    expect(face.mm.loadMotion).toHaveBeenCalledWith('angry03', 0);
    expect(main.mm.startMotion).toHaveBeenCalledWith('angry03', 0, 3);
    expect(arm.mm.startMotion).toHaveBeenCalledWith('angry03', 0, 3);
    expect(face.mm.startMotion).toHaveBeenCalledWith('angry03', 0, 3);
  });

  it('preserves the handoff pose when Cubism2 seek starts a motion at offset zero', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([1, 2, 3]);
    main.opacities.set([0.25, 0.75]);
    main.model.update = vi.fn(() => {
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0, 10, true, 1);

    expect(main.mm.startMotion).toHaveBeenCalledWith('angry03', 0, 3);
    expect(main.model.update).not.toHaveBeenCalled();
    expect(Array.from(main.params)).toEqual([1, 2, 3]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);
    expect(entry.lastSnapshot.params).toEqual(new Float32Array([1, 2, 3]));
    expect(entry.motionStartTime).toBe(10);
  });

  it('falls back to the last valid pose when a boundary handoff capture is default pose', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([0, 0, 0]);
    main.opacities.set([1, 1]);
    main.mm.startMotion = vi.fn().mockImplementation(async (group: string) => {
      main.mm.state.currentGroup = group;
      main.mm.playing = true;
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
      return true;
    });

    const lastSnapshot = {
      params: new Float32Array([1, 2, 3]),
      opacities: new Float32Array([0.25, 0.75]),
    };
    const defaultHandoff = {
      params: new Float32Array([0, 0, 0]),
      opacities: new Float32Array([1, 1]),
    };
    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      lastSnapshot,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0, 10, true, 1, defaultHandoff);

    expect(Array.from(main.params)).toEqual([1, 2, 3]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);
    expect(entry.lastSnapshot).toBe(lastSnapshot);
    expect(entry.pendingSeekBoundarySnapshot).toBe(lastSnapshot);
  });

  it('does not cache a default pose as boundary handoff when no valid pose exists', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([0, 0, 0]);
    main.opacities.set([1, 1]);
    const defaultHandoff = {
      params: new Float32Array([0, 0, 0]),
      opacities: new Float32Array([1, 1]),
    };
    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0, 10, true, 1, defaultHandoff);

    expect(entry.lastSnapshot).toBeUndefined();
    expect(entry.pendingSeekBoundarySnapshot).toBeUndefined();
  });

  it('does not expose the Cubism2 default pose at offset zero when no cached handoff exists', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([2, 3, 4]);
    main.opacities.set([0.25, 0.75]);
    main.mm.startMotion = vi.fn().mockImplementation(async (group: string) => {
      main.mm.state.currentGroup = group;
      main.mm.playing = true;
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
      return true;
    });
    main.mm.update = vi.fn((_coreModel: any, _time: number) => {
      main.params.set([4, 5, 6]);
      main.opacities.set([0.5, 1]);
      return true;
    });

    const defaultHandoff = {
      params: new Float32Array([0, 0, 0]),
      opacities: new Float32Array([1, 1]),
    };
    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0, 10, true, 1, defaultHandoff);

    expect(main.model.update).not.toHaveBeenCalled();
    expect(main.model.internalModel.update).toBeUndefined();
    expect(main.mm.update).not.toHaveBeenCalled();
    expect(Array.from(main.params)).toEqual([2, 3, 4]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);
  });

  it('keeps the handoff pose when early Cubism2 motion evaluation returns default pose during drag seek', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([2, 3, 4]);
    main.opacities.set([0.25, 0.75]);
    main.mm.startMotion = vi.fn().mockImplementation(async (group: string) => {
      main.mm.state.currentGroup = group;
      main.mm.playing = true;
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
      return true;
    });
    main.mm.update = vi.fn(() => {
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
      return true;
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.1, 10.1, true, 1);

    expect(main.model.update).not.toHaveBeenCalled();
    expect(main.model.internalModel.update).toBeUndefined();
    expect(main.mm.update).toHaveBeenCalled();
    expect(Array.from(main.params)).toEqual([2, 3, 4]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);
    expect(entry.pendingSeekBoundarySnapshot).toBeDefined();
    expect(entry.pendingSeekBoundaryDuration).toBe(0.5);
  });

  it('keeps the boundary handoff for the seek flush even when the motion produces a non-default pose', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([1, 2, 3]);
    main.opacities.set([0.25, 0.75]);
    main.model.update = vi.fn();
    main.mm.update = vi.fn((_coreModel: any, now?: number) => {
      if ((now ?? 0) >= 1000) {
        main.params.set([4, 5, 6]);
        main.opacities.set([0.5, 1]);
        return;
      }
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.003, 10.003, true, 1);

    expect(main.model.update).not.toHaveBeenCalled();
    expect(main.model.internalModel.update).toBeUndefined();
    expect(main.mm.update).toHaveBeenCalledWith(main.model.internalModel.coreModel, 1000);
    expect(Array.from(main.params)).toEqual([4, 5, 6]);
    expect(Array.from(main.opacities)).toEqual([0.5, 1]);
    expect(entry.pendingSeekBoundarySnapshot).toBeDefined();
    expect(entry.pendingSeekBoundaryDuration).toBe(0.5);
  });

  it('re-evaluates the current Cubism2 motion when dragging farther into the same motion', async () => {
    let ut = 1000;
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => ut),
        setUserTimeMSec: vi.fn((next: number) => { ut = next; }),
      },
    };

    const main = createModel('main');
    main.mm.state.currentGroup = 'angry03';
    main.mm.playing = true;
    main.params.set([0, 0, 0]);
    main.opacities.set([0, 0]);
    main.mm.update = vi.fn((_coreModel: any, _time: number) => {
      main.params.set([7, 8, 9]);
      main.opacities.set([0.4, 0.9]);
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 10,
      motionStartUtTime: 900,
      lastOffset: 0.003,
      pendingSeekBoundarySnapshot: {
        params: new Float32Array([1, 2, 3]),
        opacities: new Float32Array([0.25, 0.75]),
      },
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.1, 10.1, true, 1);

    expect(main.mm.startMotion).not.toHaveBeenCalled();
    expect(main.model.internalModel.update).toBeUndefined();
    expect(main.mm.update).toHaveBeenCalledWith(main.model.internalModel.coreModel, 1000);
    expect(Array.from(main.params)).toEqual([7, 8, 9]);
    expect(main.opacities[0]).toBeCloseTo(0.4);
    expect(main.opacities[1]).toBeCloseTo(0.9);
    expect(entry.pendingSeekBoundarySnapshot).toBeUndefined();
  });

  it('clears the Cubism2 motion queue before restarting the same motion while seeking backward', async () => {
    let ut = 1000;
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => ut),
        setUserTimeMSec: vi.fn((next: number) => { ut = next; }),
      },
    };

    const main = createModel('main');
    main.mm.state.currentGroup = 'angry03';
    main.mm.playing = true;
    main.params.set([2, 3, 4]);
    main.opacities.set([0.25, 0.75]);
    main.mm.startMotion = vi.fn().mockImplementation(async (group: string) => {
      if (main.mm.state.currentGroup === group) return false;
      main.mm.state.currentGroup = group;
      main.mm.playing = true;
      return true;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 10,
      motionStartUtTime: 900,
      lastOffset: 0.3,
      lastSnapshot: {
        params: new Float32Array([2, 3, 4]),
        opacities: new Float32Array([0.25, 0.75]),
      },
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.1, 10.1, true, 1);

    expect(main.mm.stopAllMotions).toHaveBeenCalled();
    expect(main.mm._motionQueueManager.stopAllMotions).toHaveBeenCalled();
    expect(main.mm.startMotion).toHaveBeenCalledWith('angry03', 0, 3);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('failed to start'));
    expect(Array.from(main.params)).toEqual([2, 3, 4]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);

    warnSpy.mockRestore();
  });

  it('keeps Cubism2 fade-in enabled for boundary seeks so the next motion blends from the handoff pose', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    const motionDef = { fade_in: 500, fade_out: 500 };
    main.model.internalModel.settings.motions.angry03 = [motionDef];
    main.params.set([1, 2, 3]);
    main.opacities.set([0.25, 0.75]);

    let fadeInSeenByStartMotion: number | undefined;
    main.mm.startMotion = vi.fn().mockImplementation(async (group: string) => {
      fadeInSeenByStartMotion = main.model.internalModel.settings.motions[group][0].fade_in;
      main.mm.state.currentGroup = group;
      main.mm.playing = true;
      return true;
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.003, 10.003, true, 1);

    expect(fadeInSeenByStartMotion).toBe(500);
    expect(motionDef.fade_in).toBe(500);
    expect(motionDef.fade_out).toBe(500);
  });

  it('keeps Cubism2 global fade durations enabled for boundary seeks', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const cubism2 = await import('untitled-pixi-live2d-engine/cubism-legacy');
    (cubism2.config as any).motionFadingDuration = 500;
    (cubism2.config as any).idleMotionFadingDuration = 2000;

    const main = createModel('main');
    main.params.set([1, 2, 3]);
    main.opacities.set([0.25, 0.75]);

    let fadeSeenByStartMotion: number | undefined;
    main.mm.startMotion = vi.fn().mockImplementation(async (group: string) => {
      fadeSeenByStartMotion = (cubism2.config as any).motionFadingDuration;
      main.mm.state.currentGroup = group;
      main.mm.playing = true;
      return true;
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.003, 10.003, true, 1);

    expect(fadeSeenByStartMotion).toBe(500);
    expect((cubism2.config as any).motionFadingDuration).toBe(500);
    expect((cubism2.config as any).idleMotionFadingDuration).toBe(2000);
  });

  it('does not accumulate outer model delta while fast-forwarding a boundary seek', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([1, 2, 3]);
    main.opacities.set([0.25, 0.75]);
    main.model.update = vi.fn();
    main.mm.update = vi.fn((_coreModel: any, _time: number) => {
      main.params.set([4, 5, 6]);
      main.opacities.set([0.5, 1]);
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => ({ isReconstructing: true }),
    );

    await controller._executePlayMotion('soyo', 'angry03', 3, 0.003, 10.003, true, 1);

    expect(main.model.update).not.toHaveBeenCalled();
    expect(main.model.internalModel.update).toBeUndefined();
    expect(main.mm.update).toHaveBeenCalledWith(main.model.internalModel.coreModel, 1000);
    expect(Array.from(main.params)).toEqual([4, 5, 6]);
    expect(Array.from(main.opacities)).toEqual([0.5, 1]);
  });

  it('captures the boundary handoff pose before a scrub seek resets expressions', async () => {
    (globalThis as any).window = {
      UtSystem: {
        getUserTimeMSec: vi.fn(() => 1000),
        setUserTimeMSec: vi.fn(),
      },
    };

    const main = createModel('main');
    main.params.set([1, 2, 3]);
    main.opacities.set([0.25, 0.75]);
    main.model.update = vi.fn(() => {
      main.params.set([0, 0, 0]);
      main.opacities.set([0, 0]);
    });

    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      motionStartTime: 9,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('soyo', 'angry03', 3, 0.003, 10.003, true);

    // CharacterSynchronizer resets the expression before updateAll dispatches
    // the queued motion. That reset must not become the handoff pose.
    main.params.set([0, 0, 0]);
    main.opacities.set([0, 0]);

    await controller.dispatchMotion('soyo', entry._pendingPlayMotion);

    expect(Array.from(main.params)).toEqual([1, 2, 3]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);
    expect(main.model.update).not.toHaveBeenCalled();
  });

  it('clears and stops motions on every concrete model during seek-style reset', () => {
    const main = createModel('main');
    const arm = createModel('arm');
    const face = createModel('face');

    const composite = new Live2DCompositeModel(main.model, [arm.model, face.model]);
    const entry: any = {
      id: 'soyo',
      model: composite,
      motionEpoch: 7,
      lastOffset: 1.25,
      _pendingPlayMotion: { key: 'angry03' },
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.clearAllPendingMotions();
    controller.stopAllMotions('soyo');

    expect(entry._pendingPlayMotion).toBeUndefined();
    expect(entry.lastOffset).toBeUndefined();
    expect(main.mm.stopAllMotions).toHaveBeenCalled();
    expect(arm.mm.stopAllMotions).toHaveBeenCalled();
    expect(face.mm.stopAllMotions).toHaveBeenCalled();
    expect(main.mm.state.currentGroup).toBeUndefined();
    expect(arm.mm.state.currentGroup).toBeUndefined();
    expect(face.mm.state.currentGroup).toBeUndefined();
  });

  it('applies snapshots only to the composite primary model state', () => {
    const main = createModel('main');
    const arm = createModel('arm');
    const face = createModel('face');

    const composite = new Live2DCompositeModel(main.model, [arm.model, face.model]);
    const entry: any = {
      id: 'soyo',
      model: composite,
      motionEpoch: 1,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.applySnapshot('soyo', {
      params: new Float32Array([1, 2, 3]),
      opacities: new Float32Array([0.25, 0.75]),
      motion: { key: 'angry03', startTime: 2 },
    });

    expect(Array.from(main.params)).toEqual([1, 2, 3]);
    expect(Array.from(main.opacities)).toEqual([0.25, 0.75]);
    expect(Array.from(arm.params)).toEqual([0, 0, 0]);
    expect(Array.from(face.params)).toEqual([0, 0, 0]);
  });

  it('ignores snapshots that contain non-finite values', () => {
    const main = createModel('main');
    const arm = createModel('arm');
    const face = createModel('face');

    const composite = new Live2DCompositeModel(main.model, [arm.model, face.model]);
    const entry: any = {
      id: 'soyo',
      model: composite,
      motionEpoch: 1,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.applySnapshot('soyo', {
      params: new Float32Array([Number.NaN, 2, 3]),
      opacities: new Float32Array([0.25, 0.75]),
      motion: { key: 'angry03', startTime: 2 },
    });

    expect(Array.from(main.params)).toEqual([0, 0, 0]);
    expect(Array.from(main.opacities)).toEqual([0, 0]);
  });

  it('captures numeric opacities instead of Cubism internal id arrays', () => {
    const params = new Float32Array([0.1, 0.2]);
    const opacities = new Float32Array([0.5, 1]);
    const model = {
      x: 0,
      y: 0,
      rotation: 0,
      alpha: 1,
      scale: { x: 1, y: 1 },
      internalModel: {
        parameterValues: params,
        partOpacities: ['PARAM_ANGLE_X', 'PARAM_ANGLE_Y'],
        coreModel: {
          getPartOpacities: () => opacities,
        },
      },
    };

    const snap = captureModelSnapshot('soyo', model);

    expect(snap).toBeTruthy();
    expect(snap!.params[0]).toBeCloseTo(0.1);
    expect(snap!.params[1]).toBeCloseTo(0.2);
    expect(Array.from(snap!.opacities)).toEqual([0.5, 1]);
  });

  it('uses the non-Cubism2 runtime path for official runtime motions', async () => {
    const preloadMotion = vi.fn(async () => {});
    const model = {
      startMotion: vi.fn(async () => true),
      internalModel: {
        settings: { motions: { idle: [{ file: 'idle.motion3.json', index: 0 }] } },
      },
    };
    const entry: any = {
      id: 'rana',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      motionEpoch: 4,
      injectedParams: {},
    };
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      getControls: () => mockControls({ preloadMotion }),
    }) as any);

    const controller = new Live2DMotionController(
      new Map([['rana', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    await controller._executePlayMotion('rana', 'idle', 3, 1.25, 5, true, 4);

    expect(preloadMotion).toHaveBeenCalledWith(model, 'idle');
    expect(model.startMotion).toHaveBeenCalledWith('idle', 0, 3, 1.25);
    expect(entry.motionStartTime).toBeCloseTo(3.75);
    expect(entry.lastOffset).toBeCloseTo(1.25);
  });

  it('preserves the live previous pose as the official runtime motion fade-in source', async () => {
    const preloadMotion = vi.fn(async () => {});
    const handoffSnapshot = {
      params: new Float32Array([1.2, 2.4]),
      opacities: new Float32Array([0.8]),
    };
    const applySnapshot = vi.fn();
    const captureSnapshot = vi.fn(() => handoffSnapshot);
    const model = {
      startMotion: vi.fn(async () => true),
      internalModel: {
        settings: { motions: { next: [{ file: 'next.motion3.json', index: 0 }] } },
      },
    };
    const entry: any = {
      id: 'rana',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      motionEpoch: 1,
      injectedParams: {},
    };
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      getControls: () => mockControls({
        getAvailableMotions: () => ['next'],
        preloadMotion,
        captureSnapshot,
        applySnapshot,
      }),
    }) as any);

    const controller = new Live2DMotionController(
      new Map([['rana', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('rana', 'next', 3, 0, 1, true);
    await controller.dispatchMotion('rana', entry._pendingPlayMotion);

    expect(captureSnapshot).toHaveBeenCalledWith('rana', model, undefined);
    expect(applySnapshot).toHaveBeenCalledWith(model, handoffSnapshot);
    expect(model.startMotion).toHaveBeenCalledWith('next', 0, 3, 0);
  });

  it('treats official runtime seek offsets as fresh motion intent after clearing pending state', async () => {
    const preloadMotion = vi.fn(async () => {});
    const model = {
      startMotion: vi.fn(async () => true),
      internalModel: {
        settings: { motions: { wave: [{ file: 'wave.motion3.json', index: 0 }] } },
      },
    };
    const entry: any = {
      id: 'rana',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      motionEpoch: 8,
      lastOffset: 3.0,
      injectedParams: {},
    };
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      getControls: () => mockControls({
        getAvailableMotions: () => ['wave'],
        preloadMotion,
      }),
    }) as any);

    const controller = new Live2DMotionController(
      new Map([['rana', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.clearAllPendingMotions();
    controller.playMotion('rana', 'wave', 3, 0.75, 5, true);
    await controller.dispatchMotion('rana', entry._pendingPlayMotion);

    expect(model.startMotion).toHaveBeenCalledWith('wave', 0, 3, 0.75);
    expect(entry.motionStartTime).toBeCloseTo(4.25);
    expect(entry.lastOffset).toBeCloseTo(0.75);
  });

  it('preserves tiny seek offsets when queuing Cubism2 motion intent', async () => {
    const main = createModel('main');
    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('soyo', 'angry03', 3, 0.005, 10.005, true);
    await controller.dispatchMotion('soyo', entry._pendingPlayMotion);

    expect(entry._pendingPlayMotion.offset).toBe(0.005);
    expect(entry.motionStartTime).toBeCloseTo(10);
    expect(entry.lastOffset).toBe(0.005);
  });

  it('drops official runtime motion completion when the entry generation changed during await', async () => {
    let resolveStart!: (value: boolean) => void;
    let markStartCalled!: () => void;
    const startCalled = new Promise<void>((resolve) => { markStartCalled = resolve; });
    const preloadMotion = vi.fn(async () => {});
    const oldModel = {
      startMotion: vi.fn(() => {
        markStartCalled();
        return new Promise<boolean>((resolve) => { resolveStart = resolve; });
      }),
      internalModel: {
        settings: { motions: { wave: [{ file: 'wave.motion3.json', index: 0 }] } },
      },
    };
    const oldEntry: any = {
      id: 'rana',
      model: oldModel,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      motionEpoch: 2,
      lifecycleGeneration: 1,
      injectedParams: {},
    };
    const newEntry: any = {
      id: 'rana',
      model: { startMotion: vi.fn(), internalModel: { settings: { motions: {} } } },
      runtime: oldEntry.runtime,
      motionEpoch: 1,
      lifecycleGeneration: 2,
      injectedParams: {},
    };
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      getControls: () => mockControls({
        getAvailableMotions: () => ['wave'],
        preloadMotion,
      }),
    }) as any);
    const characters = new Map<string, any>([['rana', oldEntry]]);
    const controller = new Live2DMotionController(
      characters,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    const motionPromise = controller._executePlayMotion('rana', 'wave', 3, 0.75, 5, true, 2);
    await startCalled;
    characters.set('rana', newEntry);
    oldEntry.lifecycleGeneration = 2;
    resolveStart(true);
    await motionPromise;

    expect(oldModel.startMotion).toHaveBeenCalledWith('wave', 0, 3, 0.75);
    expect(oldEntry.motionStartTime).toBeUndefined();
    expect(oldEntry.lastOffset).toBeUndefined();
    expect(newEntry.motionStartTime).toBeUndefined();
    expect(newEntry.lastOffset).toBeUndefined();
  });

  it('hard-resets official runtime models via runtime controls and idle snapshot restore', async () => {
    const model = {
      update: vi.fn(),
      stopAllMotions: vi.fn(),
      scale: {},
      internalModel: {
        focusController: { focus: vi.fn() },
      },
    };
    const entry: any = {
      id: 'rana',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      injectedParams: {},
      idleSnapshot: {
        params: new Float32Array([0.4]),
        opacities: new Float32Array([0.9]),
      },
      lastSnapshot: {
        params: new Float32Array([1]),
        opacities: new Float32Array([1]),
      },
      motionStartTime: 3,
      lastOffset: 1,
    };
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(runtimeAdapter.cubismPixiLive2DAdapter as any);
    const officialControls = runtimeAdapter.cubismPixiLive2DAdapter.getControls();
    const clearMotionState = vi.spyOn(officialControls, 'clearMotionState');
    const applySnapshot = vi.spyOn(officialControls, 'applySnapshot');

    const controller = new Live2DMotionController(
      new Map([['rana', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    await controller._hardReset('rana', model);

    expect(model.stopAllMotions).toHaveBeenCalled();
    expect(clearMotionState).toHaveBeenCalledWith(model);
    expect(applySnapshot).toHaveBeenCalledWith(model, entry.idleSnapshot);
    expect(entry.motionStartTime).toBeUndefined();
    expect(entry.lastOffset).toBeUndefined();
    expect(entry.lastSnapshot).toBeUndefined();
    expect(model.internalModel.focusController.focus).toHaveBeenCalledWith(0, 0, true);
    expect(model.update).toHaveBeenCalledWith(16);
  });

  it('drops a preview motion buffered in the same frame when stopAllMotions runs first', async () => {
    vi.restoreAllMocks();
    (globalThis as any).window = {};

    const main = createModel('main');
    const entry: any = {
      id: 'soyo',
      model: main.model,
      motionEpoch: 1,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('soyo', 'angry03', 3, 0, 0, true);

    // Simulate the updateAll frame collecting the buffered intent…
    const req = entry._pendingPlayMotion;
    entry._pendingPlayMotion = undefined;
    const motionPromise = controller.dispatchMotion('soyo', req);

    // …but the hover-leave lands before the background task executes.
    controller.stopAllMotions('soyo');

    await motionPromise;

    expect(entry._pendingPlayMotion).toBeUndefined();
    expect(entry.motionEpoch).toBeGreaterThan(req.reqEpoch);
    expect(main.mm.stopAllMotions).toHaveBeenCalled();
    expect(main.mm.loadMotion).not.toHaveBeenCalled();
    expect(main.mm.startMotion).not.toHaveBeenCalled();
  });

  it('clears the buffered preview intent even when the model is still loading', () => {
    const entry: any = {
      id: 'soyo',
      model: undefined,
      motionEpoch: 1,
      injectedParams: {},
    };

    const controller = new Live2DMotionController(
      new Map([['soyo', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('soyo', 'angry03', 3, 0, 0, true);
    expect(entry._pendingPlayMotion).toBeDefined();

    controller.stopAllMotions('soyo');

    expect(entry._pendingPlayMotion).toBeUndefined();
    expect(entry.motionEpoch).toBe(3);
  });

  it('clears a pending motion when stopping before the character entry exists', () => {
    const pendingMotions = new Map();
    const controller = new Live2DMotionController(
      new Map(),
      new Map(),
      pendingMotions,
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('soyo', 'angry03', 3, 0, 0, true);
    expect(pendingMotions.has('soyo')).toBe(true);

    controller.stopAllMotions('soyo');

    expect(pendingMotions.has('soyo')).toBe(false);
  });
});
