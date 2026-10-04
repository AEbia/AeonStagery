// @vitest-environment jsdom
/**
 * Release builds ship no Live2D runtime (ADR-0035).
 *
 * The vendor engine bundle reads `window.Live2D` during module evaluation, so a
 * release install cannot even import it. Stage initialization must degrade
 * gracefully — the app has to boot and render everything that does not need
 * Live2D — while any *explicit* engine request fails with an actionable error
 * instead of a cryptic vendor TypeError.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';

function reportRuntimeMissing(): void {
  delete (window as { Live2D?: unknown }).Live2D;
  (window as { __aeonLive2DRuntimeBootstrap?: unknown }).__aeonLive2DRuntimeBootstrap = {
    detail: { cubism2Loaded: false, cubismCoreLoaded: false },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  delete (window as { Live2D?: unknown }).Live2D;
  delete (window as { __aeonLive2DRuntimeBootstrap?: unknown }).__aeonLive2DRuntimeBootstrap;
});

describe('Live2DEngineBridge without a staged runtime', () => {
  it('reports the engine as unloadable once the bootstrap settles without Cubism 2.1', async () => {
    reportRuntimeMissing();
    const bridge = await import('../engine/Live2DEngineBridge');

    await bridge.ensureLive2DRenderPipe();

    expect(bridge.isLive2DEngineLoadable()).toBe(false);
  });

  it('skips render-pipe registration instead of failing stage initialization', async () => {
    reportRuntimeMissing();
    const bridge = await import('../engine/Live2DEngineBridge');
    bridge.__resetLive2DRenderPipeRegistrationForTests();
    const addSpy = vi.spyOn(PIXI.extensions, 'add').mockImplementation((() => undefined) as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(bridge.ensureLive2DRenderPipe()).resolves.toBeUndefined();

    expect(addSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping render-pipe registration'));
  });

  it('rejects an explicit engine load with an actionable message', async () => {
    reportRuntimeMissing();
    const bridge = await import('../engine/Live2DEngineBridge');

    await expect(bridge.loadLive2DEngineModule()).rejects.toThrow(
      /Cubism 2\.1 runtime \(live2d\.min\.js\) is not available/,
    );
  });

  it('does not trip on a re-run once the pipe was registered on a machine with a runtime', async () => {
    reportRuntimeMissing();
    const bridge = await import('../engine/Live2DEngineBridge');
    bridge.__resetLive2DRenderPipeRegistrationForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Two consecutive calls, as StageManager.init() and a later mount would do.
    await bridge.ensureLive2DRenderPipe();
    await expect(bridge.ensureLive2DRenderPipe()).resolves.toBeUndefined();
  });
});
