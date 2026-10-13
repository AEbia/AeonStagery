import type { Live2DFocusAnimationAction, Live2DFocusInput, Live2DRuntimeModelControls } from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle } from './Live2DRuntimeControlModule';

export function createBoundModelFocus(
  model: object,
  controls: Live2DRuntimeModelControls,
): Pick<Live2DModelHandle, 'focus'> {
  return {
    focus: {
      apply: (input: Live2DFocusInput) => controls.applyFocus(model, input),
      manageAnimations: (action: Live2DFocusAnimationAction) => controls.manageFocusAnimations(model, action),
    },
  };
}
