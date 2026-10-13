import type { CustomMotionStageHandle, InstallCustomMotionStageInput } from '../customMotionStage';
import type { Live2DRuntimeModelControls } from '../../runtime/Live2DRuntimeContracts';
import type { Live2DModelHandle } from './Live2DRuntimeControlModule';

export function createBoundModelCustomMotion(
  model: object,
  controls: Live2DRuntimeModelControls,
): Pick<Live2DModelHandle, 'customMotion'> {
  return {
    customMotion: {
      installStage: (input: Omit<InstallCustomMotionStageInput, 'targets'>): CustomMotionStageHandle | null =>
        controls.installCustomMotionStage(model, input),
    },
  };
}
