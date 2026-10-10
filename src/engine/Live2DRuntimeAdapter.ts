import type { Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import type { Live2DRuntimeAdapter } from './runtime/Live2DRuntimeContracts';
import {
  Cubism2PixiLive2DAdapter,
  defaultCubism2RuntimeDescriptor,
} from './runtime/Cubism2PixiLive2DAdapter';
import { CubismPixiLive2DAdapter } from './runtime/CubismPixiLive2DAdapter';

export type {
  Live2DModelCreateOptions,
  Live2DSeekMotionState,
  Live2DSeekExpressionState,
  Live2DSeekRestoreTier,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
  Live2DRuntimeClock,
  Live2DMotionStartOptions,
  Live2DMotionStartResult,
  Live2DModelResetOptions,
  Live2DModelPrepareOptions,
  Live2DDisposeOptions,
  Live2DFocusInput,
  Live2DFocusOptions,
  Live2DRuntimeModelControls,
  Live2DRuntimeAdapter,
} from './runtime/Live2DRuntimeContracts';
export { Cubism2PixiLive2DAdapter } from './runtime/Cubism2PixiLive2DAdapter';
export { Cubism2PixiLive2DModelControls } from './runtime/Cubism2PixiLive2DModelControls';
export { CubismPixiLive2DAdapter } from './runtime/CubismPixiLive2DAdapter';
export { resolveHeadAnchorFromSettings } from './runtime/modelMetadata';

export const cubism2Live2DAdapter = new Cubism2PixiLive2DAdapter();
export const cubismPixiLive2DAdapter = new CubismPixiLive2DAdapter();

export function getLive2DRuntimeAdapter(runtime?: Live2DRuntimeDescriptor | null): Live2DRuntimeAdapter {
  const resolvedRuntime = runtime ?? defaultCubism2RuntimeDescriptor;
  if (resolvedRuntime.adapterId === 'untitled-pixi-live2d-engine-cubism') return cubismPixiLive2DAdapter;
  return cubism2Live2DAdapter;
}
