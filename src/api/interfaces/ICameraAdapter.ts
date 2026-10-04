import type { CameraMotionConfig, CameraKeyframe, CameraPathConfig, CameraShakeConfig } from '../types/camera';

export interface ICameraAdapter {
  init(): void;
  focusOn(characterId: string, part?: string): void;
  executeMotion(config: CameraMotionConfig): void;
  createPath(keyframes: CameraKeyframe[], config?: CameraPathConfig): string;
  shake(config?: CameraShakeConfig): void;
  reset(duration?: number, ease?: string): void;
}
