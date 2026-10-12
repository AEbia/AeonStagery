import { resetCoreParams } from '../../Live2DConfig';
import type {
  Live2DIdleBaseline, Live2DInitializationInput, Live2DInitializationResult,
  Live2DRuntimeModelControls, Live2DRuntimeResetInput,
} from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle, Live2DRuntimeCapabilities } from './Live2DRuntimeControlModule';
import { readPartOpacities, writePartOpacities } from './Cubism2PartOpacity';

interface NeutralCore {
  getParameterValues?: () => Float32Array;
  paramValues?: Float32Array;
  _$5S?: { _$_2?: Float32Array };
  saveParam?: () => void;
}
interface NeutralInternal {
  parameterValues?: Float32Array;
  coreModel?: NeutralCore;
  __aeonstageryNeutralPose?: { params: Float32Array; opacities?: Float32Array };
  focusController?: { focus: (x: number, y: number, instant: boolean) => void };
}
interface NeutralModel {
  visible?: boolean;
  alpha?: number;
  internalModel?: NeutralInternal;
  getAllModels?: () => NeutralModel[];
}

function concreteModels(model: object): NeutralModel[] {
  const target = model as NeutralModel;
  return target.getAllModels?.() ?? [target];
}
function parameterValues(internal: NeutralInternal): Float32Array | undefined {
  const core = internal.coreModel;
  return internal.parameterValues ?? core?.getParameterValues?.() ?? core?.paramValues ?? core?._$5S?._$_2;
}

/** Adapter-private SDK traversal. The mark survives pooling and new handles. */
export function captureModelNeutralPoseOnce(model: object): void {
  for (const target of concreteModels(model)) {
    const internal = target.internalModel;
    if (!internal?.coreModel || internal.__aeonstageryNeutralPose) continue;
    try {
      const params = parameterValues(internal);
      if (!params?.length) continue;
      const opacities = readPartOpacities(internal);
      internal.__aeonstageryNeutralPose = {
        params: Float32Array.from(params),
        opacities: opacities?.length ? Float32Array.from(opacities) : undefined,
      };
    } catch {
      // Unreadable model parameters retain the SDK default reset fallback.
    }
  }
}

function restoreBoundNeutralPose(model: object, fallback: Live2DIdleBaseline | null): void {
  for (const target of concreteModels(model)) {
    const internal = target.internalModel;
    const core = internal?.coreModel;
    if (!internal || !core) continue;
    const pose = internal.__aeonstageryNeutralPose ?? fallback;
    const values = parameterValues(internal);
    let wrote = false;
    if (pose && values?.length) {
      for (let index = 0; index < Math.min(values.length, pose.params.length); index++) values[index] = pose.params[index];
      wrote = true;
    }
    if (pose?.opacities) wrote = writePartOpacities(internal, pose.opacities) || wrote;
    if (wrote) core.saveParam?.();
    else resetCoreParams(core);
  }
}

/**
 * Warmup runs before the owner entry exists. Binding then retains that entry's
 * live parameter source and installs behavior, masks and render protections
 * before publication. Neither phase acquires resource or texture ownership.
 */
export function createBoundModelInitialization(
  id: string, model: object, controls: Live2DRuntimeModelControls, capabilities: Live2DRuntimeCapabilities,
): Pick<Live2DModelHandle, 'initialize' | 'bindRuntimeSource' | 'resetRuntimeState' | 'quiesce' | 'dispose'> {
  const resetRuntimeState = (input: Live2DRuntimeResetInput = {}): void => {
    if (input.stopPlayback !== false) {
      controls.stopAllMotions(model);
      controls.clearMotionState(model);
    }
    if (input.clearExpression !== false) controls.setExpression(model, null);
    if (input.pose === 'neutral' || input.pose === 'idle') restoreBoundNeutralPose(model, input.idleSnapshot ?? null);
    if (input.pose === 'idle' && input.idleSnapshot) controls.applySnapshot(model, input.idleSnapshot);
    if (input.keepFocus === false) {
      for (const target of concreteModels(model)) target.internalModel?.focusController?.focus(0, 0, true);
    }
  };
  return {
    async initialize(input: Live2DInitializationInput): Promise<Live2DInitializationResult> {
      if (!input.isCurrent()) return { status: 'cancelled' };
      captureModelNeutralPoseOnce(model);
      resetRuntimeState({ pose: 'neutral' });
      if (input.mode === 'live') {
        controls.advanceFrame(model, 100);
        if (capabilities.usesCubism2PrivateControls) await controls.flushIdleState(model, input.isCurrent);
        else {
          try { controls.stopAllMotions(model); controls.advanceFrame(model, 16); } catch { /* legacy warmup fallback */ }
        }
        if (!input.isCurrent()) return { status: 'cancelled' };
        try { resetRuntimeState({ pose: 'neutral' }); }
        catch (error) { console.warn(`[Live2D] Failed to neutralise idle baseline for ${id}`, error); }
        (model as NeutralModel).visible = false;
      } else {
        const display = model as NeutralModel;
        display.visible = true;
        display.alpha = 1;
        controls.installBakeRenderGuards(model);
        try { controls.stepBakeFrame(model, 16, input.renderer, id, false); }
        catch (error) { console.warn(`[BakeEngine] Initial render failed for ${id}`, error); }
        if (capabilities.requiresIdleMotionFlush) {
          try {
            await controls.flushIdleState(model, input.isCurrent);
            if (!input.isCurrent()) return { status: 'cancelled' };
            controls.stepBakeFrame(model, 0, input.renderer, id, false);
          } catch { /* preserve legacy idle-flush fallback */ }
        }
        if (!input.isCurrent()) return { status: 'cancelled' };
        const snapshot = controls.captureSnapshot(id, model);
        return { status: 'ready', idleSnapshot: snapshot ? { params: snapshot.params, opacities: snapshot.opacities } : null };
      }
      return { status: 'ready', idleSnapshot: controls.captureIdleSnapshot(model) };
    },
    bindRuntimeSource(input) {
      if (!input.isCurrent()) return false;
      controls.prepareModel(model, { ...input, id });
      return input.isCurrent();
    },
    resetRuntimeState,
    quiesce: () => controls.quiesceModel(model),
    dispose: input => controls.disposeModel(model, input),
  };
}
