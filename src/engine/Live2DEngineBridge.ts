/**
 * AeonStagery — Live2D Engine Bridge
 *
 * `untitled-pixi-live2d-engine` ships its entry points ("." and
 * "./cubism-legacy") as two fully self-contained bundles. Each bundle carries
 * its OWN copies of `Live2DPipe`/`Live2DModel`. The pipe's `execute()` uses
 * `instanceof Live2DModel` to tell a model apart from prepare pseudo
 * instructions; when the app registers the main-entry plugin (as
 * StageManager used to do) while models are created from "./cubism-legacy"
 * (as the Cubism 2 adapter does), `instanceof` fails and the pipe treats the
 * model as a prepare instruction — the first render frame after a character
 * enters the stage throws `TypeError: instruction.prepare is not a function`.
 *
 * Both consumers MUST therefore obtain the engine from the single entry
 * exported here. The literal import below is the only place in src/ allowed
 * to reference the engine module (guarded by Live2DEngineBridge.test.ts).
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

let live2DRenderPipeRegistered = false;

/**
 * Register the Live2D render pipe extension with PIXI *before* any renderer
 * is created. Uses the same engine copy as `loadLive2DEngineModule()`.
 *
 * When the install has no Cubism 2.1 runtime (the default release package,
 * ADR-0035) there is nothing to render and the engine bundle cannot even be
 * evaluated, so registration is skipped with a warning. Stage initialization
 * must not fail because of an absent optional runtime.
 */
export async function ensureLive2DRenderPipe(): Promise<void> {
  if (live2DRenderPipeRegistered) return;
  await waitForLive2DRuntimeBootstrap();
  if (!isLive2DEngineLoadable()) {
    console.warn(`[Live2D] ${CUBISM2_UNAVAILABLE_MESSAGE} Skipping render-pipe registration.`);
    return;
  }
  const { Live2DPlugin } = await loadLive2DEngineModule();
  PIXI.extensions.add(Live2DPlugin);
  live2DRenderPipeRegistered = true;
}

/** Test-only: reset the registration flag so the guard can be re-exercised. */
export function __resetLive2DRenderPipeRegistrationForTests(): void {
  live2DRenderPipeRegistered = false;
}
