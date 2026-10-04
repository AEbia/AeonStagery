import type { PreparedCompiledScene } from '../../api/types/semantic-scene';
import type { FrameCaptureVisualRuntime } from './FrameCaptureEngine';
import { objectCompositeRuntimeController } from '../visual-runtime/ObjectCompositeRuntimeController';
import { resolveVisualLightingOverlayAtTime } from '../visual-runtime/VisualRuntimeResolver';
import {
  resolveVisualStateAtTime,
  type VisualTimelineScene,
} from '../../services/visual-authoring/VisualStateResolver';

export function createPreparedFrameCaptureVisualRuntime(
  scene: PreparedCompiledScene,
): FrameCaptureVisualRuntime {
  const visualScene: VisualTimelineScene = {
    meta: scene.meta,
    visual: scene.visual,
    timeline: scene.actions,
  };
  return {
    timeline: scene.actions,
    applyCompositeAtTime(time: number) {
      const visualState = resolveVisualStateAtTime(visualScene, time);
      objectCompositeRuntimeController.apply(visualScene, visualState, time);
    },
    resolveLightingOverlayAtTime(time: number) {
      return resolveVisualLightingOverlayAtTime(visualScene, time);
    },
  };
}
