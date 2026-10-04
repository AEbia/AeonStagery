import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  Live2D?: unknown;
  aeonStageryAPI?: {
    live2dRuntime?: {
      getAvailability?: () => Promise<{ cubism2: boolean; cubism3Plus: boolean } | null>;
    };
  };
  __aeonLive2DRuntimeBootstrap?: {
    detail?: { cubism2Loaded?: boolean; cubismCoreLoaded?: boolean };
    ready?: Promise<{ cubism2Loaded?: boolean; cubismCoreLoaded?: boolean }>;
  };
  addEventListener?: (type: string, listener: (event: { detail?: unknown }) => void) => void;
}

/**
 * Fresh module instances per case: the availability module and the resolver
 * flag store it writes into must come from the same post-reset graph.
 */
async function loadFresh(fakeWindow: FakeWindow) {
  const globalRef = globalThis as Record<string, unknown>;
  globalRef.window = fakeWindow as never;
  vi.resetModules();
  const availability = await import('../engine/Live2DRuntimeAvailability');
  const resolver = await import('../engine/Live2DRuntimeResolver');
  return { availability, resolver };
}

describe('Live2DRuntimeAvailability', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('stays conservative when no main-process API exists (pure browser dev)', async () => {
    const listeners: Array<(event: { detail?: unknown }) => void> = [];
    const { availability, resolver } = await loadFresh({
      addEventListener: (_type, listener) => { listeners.push(listener); },
    });

    availability.initLive2DRuntimeAvailability();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolver.isLive2DCubism2RuntimeAvailable()).toBe(true);
  });

  it('flips Cubism 2 unavailable when the main report confirms the seed is missing', async () => {
    let dispatchBootstrap: ((event: { detail?: unknown }) => void) | null = null;
    const { availability, resolver } = await loadFresh({
      addEventListener: (_type, listener) => { dispatchBootstrap = listener; },
      aeonStageryAPI: {
        live2dRuntime: {
          getAvailability: async () => ({ cubism2: false, cubism3Plus: false }),
        },
      },
    });

    availability.initLive2DRuntimeAvailability();
    await vi.waitFor(() => {
      expect(resolver.isLive2DCubism2RuntimeAvailable()).toBe(false);
    });
    expect(dispatchBootstrap).not.toBeNull();
  });

  it('keeps availability when the window global already exists despite a negative report', async () => {
    const { availability, resolver } = await loadFresh({
      Live2D: {},
      addEventListener: () => {},
      aeonStageryAPI: {
        live2dRuntime: {
          getAvailability: async () => ({ cubism2: false, cubism3Plus: false }),
        },
      },
    });

    availability.initLive2DRuntimeAvailability();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolver.isLive2DCubism2RuntimeAvailable()).toBe(true);
  });

  it('applies bootstrap completion detail from the registered event listener', async () => {
    let dispatchBootstrap: ((event: { detail?: unknown }) => void) | null = null;
    const fakeWindow: FakeWindow = {
      addEventListener: (_type, listener) => { dispatchBootstrap = listener; },
    };
    const { availability, resolver } = await loadFresh(fakeWindow);

    availability.initLive2DRuntimeAvailability();
    // Start from a known-available baseline so assertions below exercise the
    // handler rather than leftover module state.
    resolver.setLive2DCubism2RuntimeAvailable(true);

    dispatchBootstrap!({ detail: { cubism2Loaded: false, cubismCoreLoaded: false } });
    expect(resolver.isLive2DCubism2RuntimeAvailable()).toBe(false);

    fakeWindow.Live2D = {};
    dispatchBootstrap!({ detail: { cubism2Loaded: true, cubismCoreLoaded: true } });
    expect(resolver.isLive2DCubism2RuntimeAvailable()).toBe(true);
  });

  it('consumes a completed bootstrap result when the event fired before initialization', async () => {
    const { availability, resolver } = await loadFresh({
      addEventListener: () => {},
      __aeonLive2DRuntimeBootstrap: {
        detail: { cubism2Loaded: false, cubismCoreLoaded: false },
      },
    });

    availability.initLive2DRuntimeAvailability();
    await vi.waitFor(() => {
      expect(resolver.isLive2DCubism2RuntimeAvailable()).toBe(false);
    });
  });

  it('is idempotent across repeated init calls', async () => {
    const addEventListener = vi.fn();
    const { availability } = await loadFresh({ addEventListener });

    availability.initLive2DRuntimeAvailability();
    availability.initLive2DRuntimeAvailability();
    expect(addEventListener).toHaveBeenCalledTimes(1);
  });
});
