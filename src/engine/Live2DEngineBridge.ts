/** Live2D engine imports and render-pipe registration.
 * The legacy and modern entries ship separate model constructors. Mixed
 * stages dispatch both through a shared native Pixi pipe; all consumers load
 * the same entry here to preserve class identity within each runtime family.
 */
import * as PIXI from 'pixi.js';
import { waitForLive2DRuntimeBootstrap } from './Live2DRuntimeAvailability';
import { isLive2DCubism2RuntimeAvailable } from './Live2DRuntimeResolver';

export interface Live2DEngineModule {
  Live2DModel?: any;
  Live2DPlugin?: any;
  config?: any;
  [key: string]: unknown;
}

const CUBISM2_UNAVAILABLE_MESSAGE =
  'Cubism 2.1 runtime (live2d.min.js) is not available in this install. '
  + 'Live2D models will report a runtime-missing error until one is staged '
  + '(setup instructions: https://github.com/AEbia/aeonstagery#live2d-runtimes-are-not-part-of-the-repository).';

function hasCubism2RuntimeGlobal(): boolean {
  return typeof window !== 'undefined' && Boolean((window as { Live2D?: unknown }).Live2D);
}

/**
 * Whether the engine bundle can safely be evaluated. The vendor bundle reads
 * `window.Live2D` at module scope, so a release build without a staged runtime
 * (ADR-0035) must never reach the dynamic import.
 */
export function isLive2DEngineLoadable(): boolean {
  return hasCubism2RuntimeGlobal() && isLive2DCubism2RuntimeAvailable();
}

/**
 * Load the shared engine module. Every engine class used anywhere in the app
 * (pipe plugin, model class, config) must come from this exact call so that
 * identity checks like `instanceof` succeed across subsystems.
 */
export async function loadLive2DEngineModule(): Promise<Live2DEngineModule> {
  // Both stage registration and model loading reach this entry. The legacy
  // engine reads runtime globals during module evaluation, so every caller
  // must wait for the dynamically injected scripts before importing it.
  await waitForLive2DRuntimeBootstrap();
  try {
    const mod = await import('untitled-pixi-live2d-engine/cubism-legacy');
    return mod as unknown as Live2DEngineModule;
  } catch (error) {
    // The bundle reads `window.Live2D` while it is being evaluated, so without
    // a staged Cubism 2.1 runtime (ADR-0035) the import itself rejects — and
    // the module record stays failed for the rest of the session. Translate
    // that into an actionable error. The availability check stays *after* the
    // import so that a caller which legitimately supplies the module (tests
    // mock this specifier) still works.
    if (!isLive2DEngineLoadable()) {
      const unavailable = new Error(CUBISM2_UNAVAILABLE_MESSAGE);
      (unavailable as { cause?: unknown }).cause = error;
      throw unavailable;
    }
    throw error;
  }
}

/** Modern entry remains independent of the optional Cubism 2.1 core. */
export async function loadCubismEngineModule(): Promise<Live2DEngineModule & { cubismReady: () => Promise<void> }> {
  await waitForLive2DRuntimeBootstrap();
  if (!hasCubismCore()) throw new Error('Cubism 3/4/5 requires live2dcubismcore.min.js.');
  return await import('untitled-pixi-live2d-engine/cubism') as any;
}

function hasCubismCore(): boolean {
  return typeof window !== 'undefined'
    && typeof (window.Live2DCubismCore as any)?.Version?.csmGetVersion === 'function';
}

let live2DRenderPipeRegistered = false;

/** Both bundles use the same pipe name but different model constructors.
 * Dispatch to each model's native render method so mixed stages and bake
 * renderers can accept either bundle without cross-bundle instanceof checks.
 */
export async function ensureLive2DRenderPipe(): Promise<void> {
  if (live2DRenderPipeRegistered) return;
  await waitForLive2DRuntimeBootstrap();
  const legacy = isLive2DEngineLoadable() ? await loadLive2DEngineModule() : null;
  const modern = hasCubismCore() ? await loadCubismEngineModule() : null;
  const base = legacy ?? modern;
  if (!base?.Live2DPlugin) {
    console.warn('[Live2D] No runtime Core is available. Skipping render-pipe registration.');
    return;
  }
  if (legacy && modern) {
    class CombinedLive2DPipe extends base.Live2DPlugin {
      execute(instruction: any): void {
        if (instruction instanceof legacy!.Live2DModel || instruction instanceof modern!.Live2DModel) {
          if (instruction.visible && instruction.alpha > 0) instruction.renderLive2D(this.renderer);
        } else {
          instruction.prepare();
        }
      }
    }
    PIXI.extensions.add(CombinedLive2DPipe as any);
  } else {
    PIXI.extensions.add(base.Live2DPlugin);
  }
  live2DRenderPipeRegistered = true;
}

export function __resetLive2DRenderPipeRegistrationForTests(): void {
  live2DRenderPipeRegistered = false;
}
