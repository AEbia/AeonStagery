import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import { evaluateCustomMotionRuntime, type CustomMotionHandoffPose } from './customMotionRuntime';

/**
 * Motion-stage writer for inline custom motions (ADR-0029).
 *
 * The stage installs an `afterMotionUpdate` listener on each concrete model's
 * InternalModel. pixi-live2d-display emits that event right after the SDK
 * motion queue update and BEFORE `saveParam()` / expression compositing, so
 * values written by the stage enter the pipeline at the same stage position as
 * a resource motion's curves: the active Expression layers on top of them
 * until the next expression or `default` releases control back.
 *
 * A target only counts as attachable when it has BOTH the emitter seam and a
 * writable Cubism 2 coreModel (`getParamIndex`/`setParamFloat`). Installing on
 * an emitter without a writable core would silently freeze the motion's
 * parameters AND disable the legacy post-update fallback in updateAll, so such
 * targets are skipped; if no target qualifies, install returns null and the
 * caller keeps the legacy path (e.g. the official-cubism-web runtime, whose
 * internalModel facade has neither emitter nor Cubism 2 core API).
 */

export const EYE_BLINK_PARAMETER_IDS: readonly string[] = [
  'PARAM_EYE_L_OPEN',
  'PARAM_EYE_R_OPEN',
  'ParamEyeLOpen',
  'ParamEyeROpen',
];

export interface CustomMotionStageTarget {
  /** Concrete model InternalModel; must be the emitter that owns coreModel updates. */
  readonly internalModel: any;
}

/** Live custom-motion state the stage evaluates per frame. */
export interface CustomMotionStageState {
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  readonly startSceneTime: number;
  readonly handoff: CustomMotionHandoffPose;
  readonly controlledParameterIds: readonly string[];
}

export interface CustomMotionStageHandle {
  /** Scene time (seconds) evaluated by the next afterMotionUpdate pass. */
  setSceneTime(sceneTimeSeconds: number): void;
  /** Remove listeners and restore eye blink. Safe to call more than once. */
  dispose(): void;
}

export interface InstallCustomMotionStageInput {
  targets: readonly CustomMotionStageTarget[];
  getState: () => CustomMotionStageState | null;
  /** Effect-channel parameters the stage must never write (e.g. live lip sync). */
  lipSyncParameterIds?: ReadonlySet<string>;
}

interface AttachedTarget {
  readonly internalModel: any;
  readonly handler: () => void;
  readonly restoredEyeBlink: { value: unknown } | null;
}

/** A target is attachable only when the stage can actually drive its coreModel. */
function hasWritableCubism2Core(internalModel: any): boolean {
  const coreModel = internalModel?.coreModel;
  return !!coreModel
    && typeof coreModel.getParamIndex === 'function'
    && typeof coreModel.setParamFloat === 'function';
}

function writeEvaluationValues(
  internalModel: any,
  values: Record<string, number>,
  protectedIds: ReadonlySet<string> | undefined,
): void {
  const coreModel = internalModel?.coreModel;
  if (!coreModel || typeof coreModel.getParamIndex !== 'function' || typeof coreModel.setParamFloat !== 'function') {
    return;
  }
  for (const [parameterId, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || protectedIds?.has(parameterId)) continue;
    const index = coreModel.getParamIndex(parameterId);
    if (index === -1) continue;
    // ID-keyed write first: the Cubism 2 SDK's numeric-overload
    // setParamFloat silently no-ops on the real runtime, so the stage's
    // per-frame fade evaluation never reached the core (seek preview stuck on
    // the rest pose). Both forms are written — the index form is a no-op on
    // the real SDK and the only form understood by index-keyed runtimes.
    coreModel.setParamFloat(parameterId, value);
    coreModel.setParamFloat(index, value);
  }
}

export function installCustomMotionStage(input: InstallCustomMotionStageInput): CustomMotionStageHandle | null {
  let sceneTimeSeconds = 0;
  let disposed = false;
  const attached: AttachedTarget[] = [];
  const initialState = input.getState();
  const controlledParameterIds = initialState?.controlledParameterIds ?? [];

  // Memoize the per-tick evaluation: composite models emit afterMotionUpdate
  // once per sub-model, and every emission evaluates identical inputs. The
  // identity check is safe because both manager and bake replace the custom
  // motion state object on takeover instead of mutating it in place.
  let evaluationCache: {
    motion: CustomMotionStageState['motion'];
    sceneTime: number;
    values: Record<string, number>;
  } | null = null;
  const evaluateForTick = (state: CustomMotionStageState): Record<string, number> => {
    if (evaluationCache && evaluationCache.motion === state.motion && evaluationCache.sceneTime === sceneTimeSeconds) {
      return evaluationCache.values;
    }
    const evaluation = evaluateCustomMotionRuntime(state.motion, state.startSceneTime, sceneTimeSeconds, state.handoff);
    evaluationCache = { motion: state.motion, sceneTime: sceneTimeSeconds, values: evaluation.values };
    return evaluation.values;
  };

  for (const target of input.targets) {
    const internalModel = target?.internalModel;
    if (!internalModel || typeof internalModel.on !== 'function' || typeof internalModel.off !== 'function') continue;
    if (!hasWritableCubism2Core(internalModel)) continue;

    // Selective blink suppression: the SDK only suppresses its own eye blink
    // while a resource motion updates. A custom motion stops that queue, so
    // when its tracks own the blink parameters we disable the blink channel
    // for as long as the stage lives — matching resource-motion behaviour
    // where motion curves win over blink (ADR-0029 keeps blink running in its
    // normal stage for parameters the motion does not own).
    //
    // Install-time snapshot contract: this decision (and nothing else) is
    // frozen from the FIRST getState() result. Callers must assign the final
    // takeover state — customMotion, handoff, and controlledParameterIds —
    // before installing; a stage installed before the tracks are known would
    // never suppress blink for them. Manager-side install goes through
    // takeOverCustomMotion, which guarantees that ordering.
    let restoredEyeBlink: AttachedTarget['restoredEyeBlink'] = null;
    const ownsBlinkParameter = controlledParameterIds.some((id) => EYE_BLINK_PARAMETER_IDS.includes(id));
    if (ownsBlinkParameter && internalModel.eyeBlink != null) {
      restoredEyeBlink = { value: internalModel.eyeBlink };
      internalModel.eyeBlink = undefined;
    }

    const handler = () => {
      if (disposed) return;
      const state = input.getState();
      if (!state) return; // released mid-motion: keep last pose, write nothing
      writeEvaluationValues(internalModel, evaluateForTick(state), input.lipSyncParameterIds);
    };
    internalModel.on('afterMotionUpdate', handler);
    attached.push({ internalModel, handler, restoredEyeBlink });
  }

  if (attached.length === 0) return null;

  return {
    setSceneTime(sceneTime: number): void {
      if (Number.isFinite(sceneTime)) sceneTimeSeconds = sceneTime;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const target of attached) {
        target.internalModel.off('afterMotionUpdate', target.handler);
        if (target.restoredEyeBlink) {
          target.internalModel.eyeBlink = target.restoredEyeBlink.value;
        }
      }
      attached.length = 0;
    },
  };
}
