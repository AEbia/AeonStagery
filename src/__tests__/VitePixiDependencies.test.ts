import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps Pixi extensions shared when loading renderer dependencies after optimization', () => {
  // Use a fresh Node process to evaluate the real optimized ESM modules without
  // Vitest's module runner or Pixi mocks hiding duplicate extension handlers.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveConfig, optimizeDeps } from 'vite';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import assert from 'node:assert/strict';

    const cacheDir = await mkdtemp(path.join(tmpdir(), 'aeon-vite-pixi-'));
    try {
      const config = await resolveConfig({
        cacheDir,
        logLevel: 'error',
        optimizeDeps: { entries: [], noDiscovery: true },
      }, 'serve');
      const initial = await optimizeDeps(config, true, true);
      const pixi = await import(pathToFileURL(initial.optimized['pixi.js'].file).href);

      // Simulate Vite discovering renderer imports after the initial bundle
      // has already executed. Splitting Pixi across batches used to register
      // texture-source a second time against the same extension registry.
      const rendererDependencies = [
        'pixi.js/unsafe-eval',
        'pixi.js/advanced-blend-modes',
        'pixi-filters',
      ];
      let updated = initial;
      if (rendererDependencies.some(dependency => !initial.optimized[dependency])) {
        const discoveredConfig = await resolveConfig({
          cacheDir,
          logLevel: 'error',
          optimizeDeps: {
            entries: [],
            noDiscovery: true,
            include: [...new Set([...config.optimizeDeps.include, ...rendererDependencies])],
          },
        }, 'serve');
        updated = await optimizeDeps(discoveredConfig, true, true);
      }
      for (const dependency of rendererDependencies) {
        await import(pathToFileURL(updated.optimized[dependency].file).href);
      }
      const filters = await import(pathToFileURL(updated.optimized['pixi-filters'].file).href);
      assert(filters.AdjustmentFilter.prototype instanceof pixi.Filter, 'Filters must share the initial Pixi module');
      console.log('Pixi renderer dependencies loaded');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  `], {
    cwd: process.cwd(),
    env: { ...process.env, VITEST: 'true' },
    encoding: 'utf8',
    timeout: 25_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  expect(output).toContain('Pixi renderer dependencies loaded');
}, 30_000);
