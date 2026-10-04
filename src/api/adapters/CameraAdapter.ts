import { cameraController } from '../../engine/CameraController';
import type { CameraMotionConfig, CameraKeyframe, CameraPathConfig, CameraShakeConfig } from '../../api/types/camera';
import type { ICameraAdapter } from '../../api/interfaces';

export class CameraAdapter implements ICameraAdapter {
  private nextPathId = 0;

  init(): void {
    cameraController.init();
  }

  focusOn(characterId: string, part: string = 'center'): void {
    cameraController.moveTo({
      targetCharacter: characterId,
      targetPart: part as 'head' | 'chest' | 'feet' | 'center',
      duration: 1,
      ease: 'power2.inOut',
    });
  }

  executeMotion(config: CameraMotionConfig): void {
    cameraController.executeMotion(config);
  }

  createPath(keyframes: CameraKeyframe[], config?: CameraPathConfig): string {
    cameraController.createPath(keyframes, config ?? {} as CameraPathConfig);
    return `path-${++this.nextPathId}`;
  }

  shake(config?: CameraShakeConfig): void {
    cameraController.shake(config ?? {} as CameraShakeConfig);
  }

  reset(duration: number = 1, ease: string = 'power2.inOut'): void {
    cameraController.reset(duration, ease);
  }
}
