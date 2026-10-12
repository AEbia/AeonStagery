import { createLive2DModelHandle } from '../../engine/live2d/runtime/Live2DRuntimeControlModule';
import { vi } from 'vitest';
import type {
  Live2DRuntimeAdapter,
  Live2DRuntimeModelControls,
  Live2DSeekRestoreResult,
} from '../../engine/Live2DRuntimeAdapter';

/**
 * Shared runtime-controls mock for engine tests.
 *
 * The engine seam (BakeEngine / Live2DManager / Live2DMotionController) calls
 * the full controls surface, so every adapter mock must provide all methods.
 * Tests override the behaviours they actually assert on; everything else
 * defaults to benign no-ops.
 */
export function mockControls(overrides: Partial<Live2DRuntimeModelControls> = {}): Live2DRuntimeModelControls {
  return {
    getCoreModel: vi.fn(() => null),
    describeInvalidState: vi.fn(() => null),
    getAvailableMotions: vi.fn(() => []),
    getAvailableExpressions: vi.fn(() => []),
    getMotionDuration: vi.fn(() => 0),
    getMotionDebugState: vi.fn(() => null),
    getParameterValues: vi.fn(() => null),
    getParameterMetadata: vi.fn(() => null),
    registerExternalMotion: vi.fn(async () => ({
      status: 'compatible' as const, missingParameterIds: [], ignoredParameterIds: [], diagnostics: [],
    })),
    registerExternalExpression: vi.fn(async () => ({
      status: 'compatible' as const, missingParameterIds: [], ignoredParameterIds: [], diagnostics: [],
    })),
    unregisterExternalPerformance: vi.fn(),
    clearMotionState: vi.fn(),
    stopAllMotions: vi.fn(),
    preloadMotion: vi.fn(async () => {}),
    setExpression: vi.fn(),
    setInjectedParameter: vi.fn(),
    syncInputParameters: vi.fn(),
    captureSnapshot: vi.fn(() => null),
    applySnapshot: vi.fn(),
    restoreSeekState: vi.fn(async () => ({ status: 'restored', tierUsed: 'native' }) as Live2DSeekRestoreResult),
    renderForBake: vi.fn(),
    getConcreteModels: vi.fn((model: any) => (model ? [model] : [])),
    advanceFrame: vi.fn(),
    advanceMotionOnly: vi.fn(),
    stepBakeFrame: vi.fn(),
    flushIdleState: vi.fn(async () => {}),
    resetModelToIdle: vi.fn(async () => {}),
    applyIdleBaseline: vi.fn(),
    captureIdleSnapshot: vi.fn(() => null),
    restartIdleMotion: vi.fn(async () => {}),
    hasMotionGroup: vi.fn(() => true),
    startMotion: vi.fn(async () => ({ ok: true, offsetReplayMs: 0 })),
    getMotionSamplingTargets: vi.fn(() => []),
    installCustomMotionStage: vi.fn(() => null),
    quiesceModel: vi.fn(),
    disposeModel: vi.fn(),
    prepareModel: vi.fn(),
    isolateMask: vi.fn(),
    installBakeRenderGuards: vi.fn(),
    setBlink: vi.fn(),
    applyFocus: vi.fn(),
    getFocusControllers: vi.fn(() => []),
    getHeadAnchor: vi.fn(() => null),
    ...overrides,
  };
}

/** Shared adapter mock with benign defaults (override per test). */
export function mockAdapter(overrides: Partial<Live2DRuntimeAdapter> = {}): Live2DRuntimeAdapter {
  return {
    id: 'pixi-live2d-display-cubism2',
    supported: true,
    init: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    getModelClass: vi.fn(() => null),
    getConfig: vi.fn(() => null),
    getControls: vi.fn(() => mockControls()),
    createModelHandle: vi.fn((id, model, runtime) => createLive2DModelHandle({
      id, model, runtime: runtime ?? { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls: overrides.getControls?.() ?? mockControls(),
    })),
    createModel: vi.fn(async () => ({})),
    getUnsupportedMessage: vi.fn(() => null),
    getClock: vi.fn(() => null),
    createFallbackModel: vi.fn(() => null),
    disposeBakeRenderTexture: vi.fn(),
    ...overrides,
  };
}
