/**
 * Live2DModelSetup — Model patching functions applied during addCharacter().
 *
 * These fix Cubism 2.1 SDK behaviors (erratic head sway, mask pollution, etc.)
 * and wire up the parameter override system for lip sync and other real-time control.
 */

import type { CharacterEntry } from './Live2DConfig';
import { getScriptEngineForSetup } from './Live2DSetupState';
import {
  resetPixiShaderState,
  wrapRenderBoundary,
} from './live2d/runtime/Cubism2RenderGuardSeam';
import { createBlinkControlState, evaluateBlinkMultiplier } from './live2d/blinkController';

// ─── Mask sprite discovery ────────────────────────────────────────────

export function findMaskSprite(obj: any): any {
  if (!obj) return null;
  if (obj.maskSprite) return obj.maskSprite;
  if (obj.clippingManager?.maskSprite) return obj.clippingManager.maskSprite;
  if (obj.drawData) {
    if (obj.drawData.maskSprite) return obj.drawData.maskSprite;
    if (obj.drawData.clippingManager?.maskSprite) {
      return obj.drawData.clippingManager.maskSprite;
    }
  }
  if (obj.children) {
    for (const child of obj.children) {
      const found = findMaskSprite(child);
      if (found) return found;
    }
  }
  return null;
}

// ─── Behavior fixes ───────────────────────────────────────────────────

const EXPRESSION_FADE_FIX_MARK = '__aeonstageryExpressionFadeFixApplied';
const EXPRESSION_MOTION_PATCH_MARK = '__aeonstageryExpressionMotionPatched';

/**
 * Cubism 2's expression implementation writes `param.val * weight` directly.
 * That makes the first fade-in frame temporarily overwrite the live parameter
 * with zero. Keep the runtime's target value, but blend it from the pose that
 * is active for the current frame so a later default expression can release
 * control back to a motion that changed underneath it.
 */
function applyExpressionFadeFix(internalModel: any): void {
  const expressionManager = internalModel?.motionManager?.expressionManager;
  if (
    !expressionManager
    || typeof expressionManager._setExpression !== 'function'
    || expressionManager[EXPRESSION_FADE_FIX_MARK]
  ) {
    return;
  }

  const originalSetExpression = expressionManager._setExpression;

  expressionManager._setExpression = function (motion: any) {
    if (
      motion
      && Array.isArray(motion.params)
      && typeof motion.updateParamExe === 'function'
      && !motion[EXPRESSION_MOTION_PATCH_MARK]
    ) {
      const originalUpdateParamExe = motion.updateParamExe;
      motion.updateParamExe = function (model: any, time: number, weight: number, motionQueueEntry: any) {
        const params = this.params;
        if (!Array.isArray(params) || typeof model?.getParamFloat !== 'function' || typeof model?.setParamFloat !== 'function') {
          originalUpdateParamExe.call(this, model, time, weight, motionQueueEntry);
          return;
        }

        const fadeWeight = Math.max(0, Math.min(1, Number(weight)));
        if (!Number.isFinite(fadeWeight)) {
          originalUpdateParamExe.call(this, model, time, weight, motionQueueEntry);
          return;
        }

        for (const param of params) {
          const target = Number(param.val);
          const current = Number(model.getParamFloat(param.id));
          if (!Number.isFinite(target) || !Number.isFinite(current)) {
            originalUpdateParamExe.call(this, model, time, weight, motionQueueEntry);
            return;
          }
          model.setParamFloat(param.id, current + (target - current) * fadeWeight);
        }
      };
      motion[EXPRESSION_MOTION_PATCH_MARK] = true;
    }

    return originalSetExpression.call(this, motion);
  };
  expressionManager[EXPRESSION_FADE_FIX_MARK] = true;
}

export function applyBehaviorFixes(
  entry: CharacterEntry,
  internalModel: any,
  coreModel: any,
): void {
  if (!internalModel) return;
  internalModel._characterEntry = entry;
  if (internalModel.__aeonstageryBehaviorFixesApplied) return;
  internalModel.__aeonstageryBehaviorFixesApplied = true;
  internalModel._aeonBlinkControl = createBlinkControlState(false);

  // 1. Replace aggressive natural movements with gentle breathing only.
  //    Uses a local counter driven by dt for deterministic behavior across seeks and exports.
  const breathParamIndex = internalModel.breathParamIndex;
  let breathingCounter = 0;
  internalModel.updateNaturalMovements = function (dt: number, _now: number) {
    breathingCounter += dt;
    const t = (breathingCounter / 1000) * 2 * Math.PI;
    if (coreModel && breathParamIndex > 0) {
      coreModel.setParamFloat(breathParamIndex, 0.5 + 0.5 * Math.sin(t / 3.2345));
    }
    
    const blinkControl = this._aeonBlinkControl;
    if (blinkControl) {
      this._currentBlinkMultiplier = evaluateBlinkMultiplier(
        blinkControl.sceneTimeSeconds,
        blinkControl,
      );
      blinkControl.sceneTimeSeconds += Math.max(0, dt) / 1000;
    } else if (this.eyeBlink) {
      // Critical Fix: We must manually update the eyeBlink system here because
      // we overrode the SDK's natural movement update which usually handles it.
      this.eyeBlink.update(dt);
    }
  };

  // 2. Neutralize focus controller to (0, 0).
  if (internalModel.focusController) {
    internalModel.focusController.focus(0, 0, true);
  }

  applyExpressionFadeFix(internalModel);

  // 3. Multiplier-based eye blinking (Post-processing approach)
  const configuredEyeParamNames = typeof internalModel.settings?.getEyeBlinkParameters === 'function'
    ? internalModel.settings.getEyeBlinkParameters()
    : [];
  const eyeParamNames = [
    ...(Array.isArray(configuredEyeParamNames) ? configuredEyeParamNames : []),
    'PARAM_EYE_L_OPEN', 'PARAM_EYE_R_OPEN', 
    'ParamEyeLOpen', 'ParamEyeROpen',
    'PARAM_EYE_L_SMILE', 'PARAM_EYE_R_SMILE',
    'ParamEyeLSmile', 'ParamEyeRSmile'
  ];
  const eyeTargets = eyeParamNames
    .map(name => ({
      name,
      idx: coreModel?.getParamIndex?.(name),
    }))
    .filter(target => target.idx !== undefined && target.idx !== -1);

  // Store targets and indices for the coreModel.update hook
  (internalModel as any)._eyeTargets = eyeTargets;
  (internalModel as any)._eyeIndices = eyeTargets.map(t => t.idx);

  if (internalModel.eyeBlink) {
    const randomInterval = () => 2000 + Math.random() * 4000;
    internalModel.eyeBlink.blinkInterval = randomInterval();

    const eb = internalModel.eyeBlink;
    const originalBlinkUpdate = eb.update;
    let currentBlinkMultiplier = 1.0;

    const mockModel = {
      setParamFloat: (_idx: number, val: number) => {
        currentBlinkMultiplier = val;
      }
    };

    eb.update = (dt: number) => {
      // 1. Motion Awareness: If a motion is currently playing (priority > 1), 
      //    we disable the automatic blink to prevent interference.
      const mm = internalModel.motionManager;
      const isMotionPlaying = mm && mm.state && !mm.isFinished() && (mm.state.reservedPriority > 1 || mm.state.currentPriority > 1);

      if (isMotionPlaying) {
        internalModel._currentBlinkMultiplier = 1.0;
        // Reset the timer so it starts fresh after the motion ends
        eb.nextBlinkTimeLeft = eb.blinkInterval;
        return;
      }

      const wasBlinking = eb.blinkingState !== 0;
      originalBlinkUpdate.call(eb, mockModel, dt); 
      // Store multiplier on internalModel for the coreModel.update hook to consume
      internalModel._currentBlinkMultiplier = (eb.blinkingState === 0) ? 1.0 : currentBlinkMultiplier;

      if (wasBlinking && eb.blinkingState === 0) {
        if (eb.blinkInterval < 3600000) {
          eb.blinkInterval = randomInterval();
        }
      }
    };
  }

  console.log(`[Live2D] Fixed head/eye behaviors for "${entry.id}"`);
}

function getConcreteModels(model: any): any[] {
  if (!model) return [];
  if (typeof model.getAllModels === 'function') {
    return model.getAllModels().filter(Boolean);
  }
  return [model];
}

export function applyBehaviorFixesToModelTree(entry: CharacterEntry, model: any): void {
  for (const concreteModel of getConcreteModels(model)) {
    const internalModel = concreteModel.internalModel;
    const coreModel = internalModel?.coreModel;
    if (internalModel && coreModel) {
      applyBehaviorFixes(entry, internalModel, coreModel);
    }
  }
}

// ─── Parameter override hook ──────────────────────────────────────────

export function applyParameterOverride(
  entry: CharacterEntry,
  coreModel: any,
  internalModel: any,
  isExportMode: boolean,
): void {
  if (!coreModel) return;
  if (internalModel) internalModel._characterEntry = entry;
  if (coreModel.__aeonstageryParameterOverrideApplied) return;
  coreModel.__aeonstageryParameterOverrideApplied = true;

  const originalCoreUpdate = typeof coreModel.update === 'function'
    ? coreModel.update.bind(coreModel)
    : () => {};
  coreModel.update = function () {
    const currentEntry = internalModel?._characterEntry || entry;
    // 1. Apply standard injected params (lip sync, etc.)
    if (currentEntry.injectedParams) {
      for (const [paramName, value] of Object.entries(currentEntry.injectedParams)) {
        const idx = coreModel.getParamIndex?.(paramName);
        if (idx !== undefined && idx !== -1) {
          // Commit by parameter id first: the Cubism 2 SDK's setParamFloat is
          // ID-keyed and the numeric-index overload silently no-ops on the
          // real runtime (bake snapshots stayed at the rest pose). Both forms
          // are written — the index form is a no-op on the real SDK and the
          // only form understood by index-keyed runtimes (test doubles).
          coreModel.setParamFloat?.(paramName, value as number);
          coreModel.setParamFloat?.(idx, value as number);
        }
      }
    }

    // 2. Apply eye blink multiplier ON TOP of motion/expression parameter results
    // MUST run BEFORE originalCoreUpdate() so that the Cubism 2 native vertex computation
    // evaluates deformers using the closed-eye parameter values!
    const multiplier = internalModel?._currentBlinkMultiplier;
    const eyeTargets = (internalModel?._eyeTargets as Array<{ name: string; idx: number }> | undefined)
      ?? (internalModel?._eyeIndices as number[] | undefined)?.map((idx) => ({ name: '', idx }));
    if (multiplier !== undefined && multiplier < 1.0 && eyeTargets) {
      for (const target of eyeTargets) {
        const motionVal = coreModel.getParamFloat?.(target.idx) ?? (target.name ? coreModel.getParamFloat?.(target.name) : undefined);
        if (motionVal !== undefined && coreModel.setParamFloat) {
          if (target.name) {
            coreModel.setParamFloat(target.name, motionVal * multiplier);
          }
          coreModel.setParamFloat(target.idx, motionVal * multiplier);
        }
      }
    }

    // 3. Call original update (evaluates deformers and vertex positions from parameters)
    originalCoreUpdate();

    if (internalModel.focusController && typeof internalModel.focusController.update === 'function') {
      internalModel.focusController.update(0.016);
    }
  };

  // Sync UtSystem time on init (unless in export mode)
  // 核心修复：UtSystem 时钟只允许单调递增！
  // 当角色在回退 seek 中被重新加载时（forceReconstruct），场景时间可能远小于
  // UtSystem 的当前值。如果在此处将 UtSystem 设为更早的时间，
  // 下一次 model.update() 物理引擎会算出负 dt → NaN → 角色坍缩（"两个小点"）。
  const UtSystem = typeof window !== 'undefined'
    ? (window as any).UtSystem
    : undefined;
  if (UtSystem && !isExportMode) {
    const currentTime = getScriptEngineForSetup()?.getCurrentTime() || 0;
    const targetUtMs = currentTime * 1000;
    const currentUtMs = UtSystem.getUserTimeMSec();
    if (targetUtMs > currentUtMs) {
      UtSystem.setUserTimeMSec(targetUtMs);
    }
  }

  console.log(`[Live2D] coreModel.update hooked for "${entry.id}"`);
}

// ─── Render hook (GL guard + proxy sync) ──────────────────────────────

/** Lives in the shared seam; re-exported so existing engine imports still work. */
export { resetPixiShaderState };

/**
 * Wrap a live-stage model's Cubism 2 draw boundary.
 *
 * On PixiJS 8 the draw boundary is the per-instance `renderLive2D(renderer)`
 * field — `Container` no longer has `render()`/`_render()`, so the v7 anchor
 * silently matched nothing and the guard never ran. Anchor resolution, the
 * viewport capture/restore, and the shader-cache invalidation all live in
 * Cubism2RenderGuardSeam; this hook adds only the proxy-transform sync.
 *
 * (The v7 GL-scissor dance is gone for good: PixiJS 8 never enables
 * GL_SCISSOR_TEST — masks go through render-target viewports and stencils —
 * and the Cubism 2 SDK disables the scissor test itself at GL init.)
 */
export function applyRenderHook(
  characterId: string,
  model: any,
  applyProxyTransform: (id: string, proxy: any) => void,
): void {
  wrapRenderBoundary(model, {
    before: (renderer: any) => {
      // Sync proxy transforms at the draw boundary so the camera/TL writer's
      // values reach the model right before Cubism 2 issues its GL calls.
      try {
        const scriptEngine = getScriptEngineForSetup();
        if (scriptEngine?.transformationProxies) {
          const currentId = (model as any)._characterEntry?.id || characterId;
          const proxy = scriptEngine.transformationProxies.get(currentId);
          if (proxy) {
            applyProxyTransform(currentId, proxy);
          }
        }
      } catch (e) { /* suppress */ }

      resetPixiShaderState(renderer);
    },
    after: (renderer: any) => {
      // A following filter/sibling draw must rebind its own program.
      resetPixiShaderState(renderer);
    },
  }, `applyRenderHook("${characterId}")`);
}

// ─── Bake breathing fix (deterministic, no Date.now()) ─────────────────

export function applyBakeBreathingFix(internalModel: any, coreModel: any): void {
  if (!internalModel || !coreModel) return;
  const breathParamIndex = internalModel.breathParamIndex;
  if (breathParamIndex <= 0) return;

  let counter = 0;
  internalModel.updateNaturalMovements = function (_dt: number, _now: number) {
    counter += 0.016; // ~60fps equivalent step
    coreModel.setParamFloat(
      breathParamIndex,
      0.5 + 0.5 * Math.sin((counter * Math.PI * 2) / 3.2345),
    );
  };
}
