import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

// ADR-0035: Live2D runtimes are never committed. The Electron dev seed root is
// `<appPath>/public`, so `window.Live2D` only exists when a runtime was staged
// there; that half of the assertion is therefore conditional while the real
// regression (a blank renderer) stays unconditional.
function hasStagedCubism2Runtime(): boolean {
  return existsSync(path.join(repoRoot, 'public', 'live2d.min.js'));
}

test('dist renders on the first launch even when runtime scripts arrive after app modules', async () => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeon-first-launch-'));
  const entry = path.join(userDataDir, 'main.cjs');
  let app: ElectronApplication | null = null;

  try {
    // Exercise the real dist entry with an empty profile. Slow disk/antivirus
    // can delay the optional runtime scripts independently of ES modules.
    await fs.writeFile(entry, `
      const { app, protocol } = require('electron');
      app.setAppPath(${JSON.stringify(repoRoot)});
      const handle = protocol.handle.bind(protocol);
      protocol.handle = (scheme, handler) => handle(scheme, scheme === 'aeon-runtime'
        ? async (request) => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            return handler(request);
          }
        : handler);
      require(${JSON.stringify(path.join(repoRoot, 'dist-electron/main.js'))});
    `);

    app = await electron.launch({
      args: ['--force-device-scale-factor=1', entry],
      cwd: repoRoot,
      env: {
        ...process.env,
        AEON_E2E: '1',
        AEON_E2E_LOAD_DIST: '1',
        AEON_E2E_USER_DATA: userDataDir,
      },
      timeout: 30_000,
    });
    const errors: string[] = [];
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForLoadState('load');
    const startup = await page.evaluate(() => ({
      children: document.getElementById('root')?.childElementCount ?? 0,
      runtimeLoaded: !!window.Live2D,
    }));
    expect(startup.children, `renderer stayed blank; errors: ${errors.join('; ')}`).toBeGreaterThan(0);
    if (hasStagedCubism2Runtime()) {
      expect(startup.runtimeLoaded).toBe(true);
    }
    await expect(page.locator('.top-bar__logo')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ph-overlay')).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
