import type { Live2DRuntimeDescriptor } from './Live2DRuntimeResolver';
import type { Live2DRuntimeAdapter } from './runtime/Live2DRuntimeContracts';
import {
  Cubism2PixiLive2DAdapter,
  defaultCubism2RuntimeDescriptor,
} from './runtime/Cubism2PixiLive2DAdapter';
import { CubismPixiLive2DAdapter } from './runtime/CubismPixiLive2DAdapter';

export type {
  Live2DModelCreateOptions,
  Live2DDeterminismTier,
  Live2DDeterminismCapabilities,
  Live2DSeekMotionState,
  Live2DSeekExpressionState,
  Live2DSeekRestoreTier,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
  Live2DModelResetOptions,
  Live2DDisposeOptions,
  Live2DFocusInput,
  Live2DFocusOptions,
  Live2DPerformanceKind,
  Live2DPerformanceRuntimeFamily,
  Live2DPerformanceMetadata,
  Live2DPerformanceResource,
  PerformanceCompatibility,
  PreparedPerformance,
  Live2DPerformanceModelBinding,
  Live2DMotionSampledCurve,
  Live2DMotionSamplingOptions,
  Live2DMotionSamplingMetadata,
  Live2DMotionSamplingResult,
  Live2DRuntimeAdapter,
} from './runtime/Live2DRuntimeContracts';
export { Live2DPerformanceRegistry } from './runtime/Live2DPerformanceRegistry';
export { Cubism2PixiLive2DAdapter } from './runtime/Cubism2PixiLive2DAdapter';
export { CubismPixiLive2DAdapter } from './runtime/CubismPixiLive2DAdapter';
export {
  parseCubism3MotionBuffer,
  parseCubism3MotionJson,
} from './live2d/cubism3MotionParser';
export {
  loadCubism3Motion,
  resolveCubism3MotionMeta,
  Cubism3MotionSamplingError,
} from './live2d/cubism3MotionSampler';
export { resolveHeadAnchorFromSettings } from './runtime/modelMetadata';

export const cubism2Live2DAdapter = new Cubism2PixiLive2DAdapter();
export const cubismPixiLive2DAdapter = new CubismPixiLive2DAdapter();

export function getLive2DRuntimeAdapter(runtime?: Live2DRuntimeDescriptor | null): Live2DRuntimeAdapter {
  const resolvedRuntime = runtime ?? defaultCubism2RuntimeDescriptor;
  if (resolvedRuntime.adapterId === 'untitled-pixi-live2d-engine-cubism') return cubismPixiLive2DAdapter;
  return cubism2Live2DAdapter;
}
