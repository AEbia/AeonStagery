import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import { installCustomMotionStage } from '../engine/live2d/customMotionStage';

/**
 * Fakes here reproduce the SDK's real intra-update ordering so the stage
 * contract is tested against the pipeline it plugs into
 * (pixi-live2d-display cubism2.es.js InternalModel.update):
 *
 *   1. motionManager.update        — resource motion writes parameters
 *   2. emit("afterMotionUpdate")   — ← the Motion-stage seam writes here
 *   3. saveParam()
 *   4. expressionManager.update    — composites OVER whatever step 2 wrote
 *   5. eyeBlink (only when no motion updated)
 */

type ParamValues = Map<string, number>;

interface ExpressionApply {
  apply(values: ParamValues): void;
}

function createCoreModel(names: readonly string[], values: ParamValues) {
  return {
    getParamIndex: (name: string) => names.indexOf(name),
    setParamFloat: (index: number, value: number) => {
      if (index < 0 || index >= names.length) return;
      values.set(names[index]!, value);
    },
  };
}

function createSdkOrderedModel(options: {
  params: Record<string, number>;
  expressions?: ExpressionApply[];
  eyeBlink?: boolean;
}) {
  const names = Object.keys(options.params);
  const values: ParamValues = new Map(Object.entries(options.params));
  const listeners = new Map<string, Set<() => void>>();
  let motionUpdated = false;

  const internalModel: any = {
    on: (event: string, handler: () => void) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(handler);
    },
    off: (event: string, handler: () => void) => {
      listeners.get(event)?.delete(handler);
    },
    emit: (event: string) => {
      listeners.get(event)?.forEach((handler) => handler());
    },
    motionManager: {
      update: () => {
        motionUpdated = true;
        return motionUpdated;
      },
    },
    eyeBlink: options.eyeBlink ? { update: vi.fn() } : undefined,
    expressionManager: options.expressions?.length
      ? { update: () => options.expressions!.forEach((expression) => expression.apply(values)) }
      : undefined,
    update: () => {
      internalModel.emit('beforeMotionUpdate');
      motionUpdated = !!internalModel.motionManager.update();
      internalModel.emit('afterMotionUpdate');
      internalModel.expressionManager?.update();
      if (!motionUpdated) internalModel.eyeBlink?.update(16);
    },
  };

  return { internalModel, values, coreModel: Object.assign(internalModel, { coreModel: createCoreModel(names, values) }).coreModel };
}

/** Linear track PARAM_ANGLE_X: 30 → 0 over the first second of a 3s custom motion. */
function createLinearAngleMotion(): Extract<CharacterMotionOutput, { kind: 'custom' }> {
  return {
    kind: 'custom',
    durationSeconds: 3,
    fadeInSeconds: 0,
    derivedFrom: { key: 'source-motion' },
    tracks: [
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 30 },
          { time: 1, value: 0 },
        ],
      },
    ],
  };
}

describe('customMotionStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the evaluated curve value into coreModel during the SDK update pass', () => {
    const model = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 } });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X'],
      }),
    });

    expect(handle).not.toBeNull();
    handle!.setSceneTime(10.5); // localTime 0.5s on a 30→0 linear curve = 15
    model.internalModel.update();

    expect(model.values.get('PARAM_ANGLE_X')).toBe(15);
    handle!.dispose();
  });

  it('lets an active Expression composite over the staged motion values', () => {
    const model = createSdkOrderedModel({
      params: { PARAM_ANGLE_X: 0, PARAM_MOUTH_FORM: 0 },
      expressions: [
        // add-type: offsets whatever base the Motion stage wrote
        { apply: (values) => values.set('PARAM_ANGLE_X', values.get('PARAM_ANGLE_X')! + 5) },
        // overwrite-type: replaces the parameter outright
        { apply: (values) => values.set('PARAM_MOUTH_FORM', 1) },
      ],
    });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X', 'PARAM_MOUTH_FORM'],
      }),
    });

    handle!.setSceneTime(10.5);
    model.internalModel.update();

    // add-type proves the curve reached coreModel BEFORE the expression ran:
    // legacy post-update injection would leave this at 15.
    expect(model.values.get('PARAM_ANGLE_X')).toBe(20);
    expect(model.values.get('PARAM_MOUTH_FORM')).toBe(1);
    handle!.dispose();
  });

  it('suppresses the SDK eye blink only when the tracks own blink parameters', () => {
    const blinkMotion = createLinearAngleMotion();
    const ownedIds = ['PARAM_EYE_L_OPEN'];
    const withEyes = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 }, eyeBlink: true });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: withEyes.internalModel }],
      getState: () => ({
        motion: blinkMotion,
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ownedIds,
      }),
    });

    expect(withEyes.internalModel.eyeBlink).toBeUndefined();

    handle!.dispose();
    expect(withEyes.internalModel.eyeBlink).not.toBeUndefined();
  });

  it('keeps the SDK eye blink when the tracks do not own blink parameters', () => {
    const model = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 }, eyeBlink: true });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X'],
      }),
    });

    expect(model.internalModel.eyeBlink).not.toBeUndefined();
    handle!.dispose();
  });

  it('never writes effect-channel parameters owned by live lip sync', () => {
    const model = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0, PARAM_MOUTH_OPEN_Y: 2 } });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X', 'PARAM_MOUTH_OPEN_Y'],
      }),
      lipSyncParameterIds: new Set(['PARAM_MOUTH_OPEN_Y']),
    });
    (model.internalModel as any).coreModel.setParamFloat(
      (model.internalModel as any).coreModel.getParamIndex('PARAM_MOUTH_OPEN_Y'),
      2,
    );

    handle!.setSceneTime(10.5);
    model.internalModel.update();

    expect(model.values.get('PARAM_MOUTH_OPEN_Y')).toBe(2); // untouched
    expect(model.values.get('PARAM_ANGLE_X')).toBe(15); // unprotected track still written
    handle!.dispose();
  });

  it('stops writing after dispose and tolerates repeated disposal', () => {
    const model = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 } });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X'],
      }),
    });

    handle!.setSceneTime(10.5);
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(15);

    handle!.dispose();
    handle!.dispose(); // must not throw

    model.values.set('PARAM_ANGLE_X', 7); // some later motion writes the param
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(7); // stage no longer interferes
  });

  it('returns null when no target supports the emitter seam so callers keep the legacy path', () => {
    const legacyModel = { internalModel: { coreModel: {} } }; // no .on/.off
    const handle = installCustomMotionStage({
      targets: [{ internalModel: legacyModel.internalModel }],
      getState: () => null,
    });

    expect(handle).toBeNull();
  });

  it('writes each composite sub-model only for parameters it actually has', () => {
    const head = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 } });
    const body = createSdkOrderedModel({ params: { PARAM_BODY_ANGLE_X: 0 } });
    const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
      kind: 'custom',
      durationSeconds: 3,
      fadeInSeconds: 0,
      derivedFrom: { key: 'source-motion' },
      tracks: [
        {
          parameterId: 'PARAM_ANGLE_X',
          keyframes: [
            { time: 0, value: 30 },
            { time: 1, value: 0 },
          ],
        },
        {
          parameterId: 'PARAM_BODY_ANGLE_X',
          keyframes: [
            { time: 0, value: -10 },
            { time: 1, value: 10 },
          ],
        },
      ],
    };
    const handle = installCustomMotionStage({
      targets: [
        { internalModel: head.internalModel },
        { internalModel: body.internalModel },
      ],
      getState: () => ({
        motion,
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X', 'PARAM_BODY_ANGLE_X'],
      }),
    });

    handle!.setSceneTime(10.5);
    head.internalModel.update();
    body.internalModel.update();

    expect(head.values.get('PARAM_ANGLE_X')).toBe(15);
    expect(body.values.get('PARAM_BODY_ANGLE_X')).toBe(0); // -10 + (10 - -10) * 0.5
    handle!.dispose();
  });

  it('returns null when a target has the emitter but no writable Cubism2 core', () => {
    // An emitter without getParamIndex/setParamFloat would install a stage
    // that silently freezes the motion's parameters AND disables the legacy
    // post-update fallback — it must fall back to null instead.
    const bareEmitter = { on: vi.fn(), off: vi.fn(), emit: vi.fn(), coreModel: {} };
    const handle = installCustomMotionStage({
      targets: [{ internalModel: bareEmitter }],
      getState: () => null,
    });

    expect(handle).toBeNull();
    expect(bareEmitter.on).not.toHaveBeenCalled();
  });

  it('attaches only capable targets in a mixed-capability composite', () => {
    const capable = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 } });
    const inert = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      coreModel: {}, // emitter present, core unwritable
    };
    const handle = installCustomMotionStage({
      targets: [
        { internalModel: capable.internalModel },
        { internalModel: inert },
      ],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X'],
      }),
    });

    expect(handle).not.toBeNull();
    expect(inert.on).not.toHaveBeenCalled();

    handle!.setSceneTime(10.5);
    capable.internalModel.update();
    expect(capable.values.get('PARAM_ANGLE_X')).toBe(15);
    handle!.dispose();
    expect(inert.off).not.toHaveBeenCalled(); // never attached, nothing to detach
  });

  it('stops writing once getState reports the release', () => {
    const model = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 } });
    const baseState = {
      motion: createLinearAngleMotion(),
      startSceneTime: 10,
      handoff: { values: {} as Record<string, number> },
      controlledParameterIds: ['PARAM_ANGLE_X'],
    };
    let active: typeof baseState | null = baseState;
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => active,
    });

    handle!.setSceneTime(10.5);
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(15);

    active = null; // released mid-motion (e.g. resource-motion takeover)
    model.values.set('PARAM_ANGLE_X', 7); // some later writer owns the param
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(7); // stage keeps its hands off
    handle!.dispose();
  });

  it('ignores non-finite scene time updates and keeps evaluating the previous tick', () => {
    const model = createSdkOrderedModel({ params: { PARAM_ANGLE_X: 0 } });
    const handle = installCustomMotionStage({
      targets: [{ internalModel: model.internalModel }],
      getState: () => ({
        motion: createLinearAngleMotion(),
        startSceneTime: 10,
        handoff: { values: {} },
        controlledParameterIds: ['PARAM_ANGLE_X'],
      }),
    });

    handle!.setSceneTime(10.5);
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(15);

    handle!.setSceneTime(Number.NaN); // must not clobber the stashed tick
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(15);

    handle!.setSceneTime(11); // curve end value from 10→0 over 0–1s
    model.internalModel.update();
    expect(model.values.get('PARAM_ANGLE_X')).toBe(0);
    handle!.dispose();
  });
});
