import { loadCubismEngineModule } from './Live2DEngineBridge';
import { waitForLive2DRuntimeBootstrap } from './Live2DRuntimeAvailability';

export const CUBISM_CORE_MISSING_MESSAGE = 'Cubism 3/4/5 Core 脚本缺失或未加载（live2dcubismcore.min.js）。';
let initialized = false;
let initPromise: Promise<void> | null = null;
let initError: string | null = null;

export function getCubismPixiSdkStatus(): { available: boolean; initialized: boolean; message: string | null } {
  const available = typeof window !== 'undefined'
    && typeof (window.Live2DCubismCore as any)?.Version?.csmGetVersion === 'function';
  return { available, initialized, message: available ? initError : CUBISM_CORE_MISSING_MESSAGE };
}

export async function initCubismPixiSdk(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await waitForLive2DRuntimeBootstrap();
    if (!getCubismPixiSdkStatus().available) throw new Error(CUBISM_CORE_MISSING_MESSAGE);
    const engine = await loadCubismEngineModule();
    await engine.cubismReady();
    initialized = true;
    initError = null;
  })();
  try {
    await initPromise;
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    initPromise = null;
  }
}
