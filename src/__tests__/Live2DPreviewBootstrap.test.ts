import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const bootstrap = readFileSync(new URL('../../public/runtime-bootstrap.js', import.meta.url), 'utf8');

describe('preview frame runtime bootstrap', () => {
  it.each([
    ['?runtimeHost=desktop', 'aeon-runtime://localhost/'],
    ['', './'],
  ])('loads frame-owned runtimes for %s without accessing parent globals', async (search, prefix) => {
    const scripts: Array<{ src: string; addEventListener: (type: string, listener: () => void) => void }> = [];
    const completions: Array<() => void> = [];
    const frame = {
      location: { search },
      get parent(): never { throw new Error('parent realm must not be accessed'); },
      dispatchEvent() {},
      __aeonLive2DRuntimeBootstrap: undefined as {
        ready: Promise<{ cubism2Loaded: boolean; cubismCoreLoaded: boolean }>;
      } | undefined,
    };
    runInNewContext(bootstrap, {
      window: frame, URLSearchParams,
      document: {
        createElement: () => ({ src: '', addEventListener: (type: string, listener: () => void) => {
          if (type === 'error') completions.push(listener);
        } }),
        head: { appendChild: (script: typeof scripts[number]) => scripts.push(script) },
      },
    });
    expect(scripts.map((script) => script.src)).toEqual([
      `${prefix}live2d.min.js`, `${prefix}live2dcubismcore.min.js`,
    ]);
    completions.forEach((finish) => finish());
    await expect(frame.__aeonLive2DRuntimeBootstrap?.ready).resolves.toEqual({
      cubism2Loaded: false, cubismCoreLoaded: false,
    });
    expect(frame).not.toHaveProperty('Live2D');
    expect(frame).not.toHaveProperty('Live2DCubismCore');
  });
});
