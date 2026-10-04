/**
 * Live2DEngineBridge regression tests.
 *
 * Bug being locked down: `TypeError: instruction.prepare is not a function`
 * thrown from Live2DPipe.execute() on the first render frame after a Live2D
 * character enters the stage. Root cause: the app registered the render pipe
 * plugin from the engine's main entry while models were created from the
 * `cubism-legacy` entry — two self-contained bundles with disjoint class
 * identities, so the pipe's `instanceof Live2DModel` check failed and the
 * model was misread as a prepare pseudo-instruction.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as PIXI from 'pixi.js';
import { resolveCubism2CorePath, resolveCubismWebCorePath } from './helpers/live2dRuntimeFixture';

// Both engine entries evaluate against the live2d.min.js / live2dcubismcore
// runtime globals at module scope. In the browser the bridge must wait for
// public/runtime-bootstrap.js to finish injecting them. Evaluate the real
// runtime scripts here so tests can exercise the real engine module.
//
// Neither runtime is committed (ADR-0035): on a checkout without staged
// runtimes the vendor module cannot even be imported, so the SDK-dependent
// cases skip while the source-level guard below always runs.
const cubism2CorePath = resolveCubism2CorePath();
const cubismWebCorePath = resolveCubismWebCorePath();
const hasRuntimeGlobals = Boolean(cubism2CorePath && cubismWebCorePath);

if (hasRuntimeGlobals) {
  const g = globalThis as any;
  if (!(g.window && 'Live2D' in g.window)) {
    g.window = g;
    g.self = g.self ?? g;
    if (typeof g.document === 'undefined') {
      g.document = { createElement: () => ({ getContext: () => null, style: {} }) };
    }
    const runtimeScripts = [
      { file: 'live2d.min.js', resolved: cubism2CorePath },
      { file: 'live2dcubismcore.min.js', resolved: cubismWebCorePath },
    ];
    for (const script of runtimeScripts) {
      vm.runInThisContext(fs.readFileSync(script.resolved as string, 'utf8'), { filename: script.file });
    }
  }
}

function modelLike(Live2DModelCtor: any): any {
  // Enough of a Live2DModel for the pipe's execute() branch decision;
  // invisible so the model branch returns before touching GL state.
  const model = Object.create(Live2DModelCtor.prototype);
  model.visible = false;
  return model;
}

describe.skipIf(!hasRuntimeGlobals)('Live2DEngineBridge', () => {
  it('characterizes the crash: engine entries ship disjoint class copies (cross-entry instanceof fails)', async () => {
    const main: any = await import('untitled-pixi-live2d-engine');
    const legacy: any = await import('untitled-pixi-live2d-engine/cubism-legacy');

    expect(main.Live2DModel).toBeDefined();
    expect(legacy.Live2DModel).toBeDefined();
    // The two bundles carry separate class identities.
    expect(main.Live2DModel).not.toBe(legacy.Live2DModel);

    const pipe = new main.Live2DPlugin({ renderPipes: {} });
    const model = modelLike(legacy.Live2DModel);

    // This is the exact production symptom the mixed wiring caused.
    expect(() => pipe.execute(model)).toThrow(/instruction\.prepare is not a function/);
  });

  it('registers the render pipe plugin from the same entry that creates models', async () => {
    const added: unknown[] = [];
    const spy = vi.spyOn(PIXI.extensions, 'add').mockImplementation(((...exts: unknown[]) => {
      added.push(...exts);
      return undefined as unknown;
    }) as typeof PIXI.extensions.add);

    try {
      const {
        ensureLive2DRenderPipe,
        loadLive2DEngineModule,
        __resetLive2DRenderPipeRegistrationForTests,
      } = await import('../engine/Live2DEngineBridge');
      __resetLive2DRenderPipeRegistrationForTests();
      await ensureLive2DRenderPipe();
      __resetLive2DRenderPipeRegistrationForTests();

      const mod = await loadLive2DEngineModule();
      expect(added).toContain(mod.Live2DPlugin);

      // The registered plugin must accept models produced through the same
      // bridge — i.e. no TypeError from the instanceof branch.
      const pipe = new mod.Live2DPlugin({ renderPipes: {} });
      const model = modelLike(mod.Live2DModel);
      expect(() => pipe.execute(model)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('waits for runtime bootstrap for both stage registration and model consumers', async () => {
    const {
      ensureLive2DRenderPipe,
      loadLive2DEngineModule,
      __resetLive2DRenderPipeRegistrationForTests,
    } = await import('../engine/Live2DEngineBridge');
    const previousBootstrap = window.__aeonLive2DRuntimeBootstrap;
    let release!: (detail: { cubism2Loaded: boolean; cubismCoreLoaded: boolean }) => void;
    window.__aeonLive2DRuntimeBootstrap = {
      ready: new Promise(resolve => { release = resolve; }),
    };
    const spy = vi.spyOn(PIXI.extensions, 'add').mockImplementation(() => undefined as unknown);
    __resetLive2DRenderPipeRegistrationForTests();
    let loaded = false;
    const registration = ensureLive2DRenderPipe();
    const modelConsumer = loadLive2DEngineModule().then(mod => {
      loaded = true;
      return mod;
    });

    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(loaded).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      release({ cubism2Loaded: true, cubismCoreLoaded: true });
      await registration;
      expect(spy).toHaveBeenCalledWith((await modelConsumer).Live2DPlugin);
    } finally {
      release({ cubism2Loaded: true, cubismCoreLoaded: true });
      await Promise.all([registration, modelConsumer]);
      window.__aeonLive2DRuntimeBootstrap = previousBootstrap;
      __resetLive2DRenderPipeRegistrationForTests();
      spy.mockRestore();
    }
  });
});

// Source-level guard: independent of any staged Live2D runtime, so it runs on
// every checkout (ADR-0035).
describe('Live2DEngineBridge source guard', () => {
  it('keeps engine module references centralized in the bridge', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/from ['"]untitled-pixi-live2d-engine|import\(['"]untitled-pixi-live2d-engine/.test(text)) {
            // Normalize separators so the expectation holds on Windows too.
            offenders.push(path.relative(srcRoot, full).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual(['engine/Live2DEngineBridge.ts']);
  });
});
