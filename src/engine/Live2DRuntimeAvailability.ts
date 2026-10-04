/**
 * Live2DRuntimeAvailability — renderer-side detection of which Live2D runtime
 * families are actually loadable in this install.
 *
 * Boundaries (ADR-0019):
 * - A family is only reported missing on positive evidence: the main process
 *   says its seed file could not be served, or the runtime bootstrap has
 *   completed and the expected global is still absent.
 * - Unknown stays conservative (`available`) so a probe race never blocks a
 *   working path.
 * - This module has NO UI side effects. It only calls
 *   `setLive2DCubism2RuntimeAvailable()` on the resolver; missing runtimes
 *   surface exclusively where a matching model is loaded. Cubism 3+ keeps its
 *   live Core check in `getCubismPixiSdkStatus()`.
 */

import { setLive2DCubism2RuntimeAvailable } from './Live2DRuntimeResolver';

export const LIVE2D_RUNTIME_BOOTSTRAP_EVENT = 'live2d-runtime-bootstrap-complete';

interface BootstrapDetail {
  cubism2Loaded?: boolean;
  cubismCoreLoaded?: boolean;
}

declare global {
  interface Window {
    Live2D?: unknown;
    Live2DCubismCore?: { Version?: unknown };
    __aeonLive2DRuntimeBootstrap?: {
      detail?: BootstrapDetail;
      ready?: Promise<BootstrapDetail>;
    };
  }
}

let initialized = false;

function hasWindowLive2D(): boolean {
  return typeof window !== 'undefined' && !!window.Live2D;
}

function hasWindowCubismCore(): boolean {
  return typeof window !== 'undefined' && !!window.Live2DCubismCore?.Version;
}

function applyBootstrapDetail(detail: BootstrapDetail | undefined): void {
  if (!detail) return;
  if (detail.cubism2Loaded === false && !hasWindowLive2D()) {
    setLive2DCubism2RuntimeAvailable(false);
  } else if (detail.cubism2Loaded === true) {
    setLive2DCubism2RuntimeAvailable(true);
  }
}

function getBootstrapState(): Window['__aeonLive2DRuntimeBootstrap'] | undefined {
  return typeof window === 'undefined' ? undefined : window.__aeonLive2DRuntimeBootstrap;
}

/**
 * Wait for the page bootstrap when it is present. This is deliberately a
 * no-op outside the Electron/Vite page so isolated consumers remain usable.
 */
export async function waitForLive2DRuntimeBootstrap(): Promise<void> {
  const bootstrap = getBootstrapState();
  if (!bootstrap) return;

  if (bootstrap.detail) {
    applyBootstrapDetail(bootstrap.detail);
    return;
  }

  if (bootstrap.ready) {
    applyBootstrapDetail(await bootstrap.ready);
  }
}

async function queryMainAvailability(loadedAfterStart: () => boolean): Promise<void> {
  // Duck-typed lookup: the preload bridge may be absent (pure browser dev),
  // and test doubles only implement this slice of AeonStageryElectronAPI.
  const api = typeof window !== 'undefined'
    ? (window.aeonStageryAPI as { live2dRuntime?: { getAvailability?: () => Promise<{ cubism2?: boolean } | null> } } | undefined)
    : undefined;
  const getAvailability = api?.live2dRuntime?.getAvailability;
  if (typeof getAvailability !== 'function') return;
  try {
    const report = await getAvailability();
    // Normalize a null/undefined report (handler not registered yet) to
    // "unknown" rather than throwing on property access.
    const cubism2 = report?.cubism2;
    if (cubism2 === false && !hasWindowLive2D() && !loadedAfterStart()) {
      setLive2DCubism2RuntimeAvailable(false);
    } else if (cubism2 === true && !hasWindowLive2D()) {
      // File exists but the script may still be executing; stay conservative
      // until the bootstrap event settles it either way.
      setLive2DCubism2RuntimeAvailable(true);
    }
  } catch (err) {
    console.warn('[Live2DRuntimeAvailability] main-process availability query failed:', err);
  }
}

/** Idempotent wiring; safe to call from any consumer before reading state. */
export function initLive2DRuntimeAvailability(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // Scripts are injected synchronously in <head>, so normally neither global
  // exists yet here. If a re-initialization happens after load, keep the
  // positive evidence instead of letting a stale main-process report flip
  // availability back to missing.
  const globalsAlreadyLoaded = () => hasWindowLive2D() || hasWindowCubismCore();

  window.addEventListener(LIVE2D_RUNTIME_BOOTSTRAP_EVENT, (event) => {
    applyBootstrapDetail((event as CustomEvent).detail as BootstrapDetail | undefined);
  });

  // The external scripts can finish before the deferred entry module runs.
  // Read the retained result in addition to listening for the live event.
  void waitForLive2DRuntimeBootstrap();
  void queryMainAvailability(globalsAlreadyLoaded);
}
