import type { Live2DRuntimeControlPort } from '../../runtime/Live2DRuntimeControlPort';
import type { CustomMotionStageHandle, InstallCustomMotionStageInput } from '../customMotionStage';
import type { Live2DModelHandle } from './Live2DRuntimeControlModule';

export function createBoundModelCustomMotion(
  model: object,
  controls: Live2DRuntimeControlPort,
): Pick<Live2DModelHandle, 'customMotion'> {
  return {
    customMotion: {
      installStage: (input: Omit<InstallCustomMotionStageInput, 'targets'>): CustomMotionStageHandle | null =>
        controls.installCustomMotionStage(model, input),
    },
  };
}
