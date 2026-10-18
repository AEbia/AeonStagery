import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

test('editor, workspace tools and agent retain their preload bridge with sandbox enabled', async () => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeon-sandbox-'));
  const assetPath = path.join(userDataDir, 'sandbox-asset.txt');
  await fs.writeFile(assetPath, 'sandbox-asset');
  await fs.mkdir(path.join(userDataDir, 'live2d-runtime'), { recursive: true });
  await fs.writeFile(path.join(userDataDir, 'live2d-runtime', 'sandbox.txt'), 'sandbox-runtime');
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ['--force-device-scale-factor=1', repoRoot], cwd: repoRoot,
      env: { ...process.env, AEON_E2E: '1', AEON_E2E_LOAD_DIST: '1', AEON_E2E_USER_DATA: userDataDir },
      timeout: 30_000,
    });
    const editor = await app.firstWindow();
    await editor.waitForLoadState('load');
    await expect(editor.locator('.top-bar__logo')).toBeVisible();
    for (const open of ['tools', 'agent'] as const) {
      const nextWindow = app.waitForEvent('window');
      const result = await editor.evaluate(async (surface) => surface === 'tools'
        ? window.aeonStageryAPI.workspaceTools!.open()
        : window.aeonStageryAPI.projectAgent!.openWindow(), open);
      expect(result).toMatchObject({ success: true });
      const page = await nextWindow;
      await page.waitForLoadState('load');
      await expect(page.locator('#root')).not.toBeEmpty();
    }
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
      const preferences = window.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    }))).toEqual(Array.from({ length: 3 }, () => ({ sandbox: true, contextIsolation: true, nodeIntegration: false })));
    for (const page of app.windows()) {
      const bridge = await page.evaluate(async () => ({
        appPath: await window.aeonStageryAPI.app.getPath(),
        nodeExposed: 'require' in window,
      }));
      expect(bridge.appPath).toBe(repoRoot);
      expect(bridge.nodeExposed).toBe(false);
    }
    const protocols = await editor.evaluate(async (localPath) => ({
      asset: await (await fetch(`asset://localhost/${encodeURIComponent(localPath)}`)).text(),
      runtime: await (await fetch('aeon-runtime://runtime/sandbox.txt')).text(),
    }), assetPath);
    expect(protocols).toEqual({ asset: 'sandbox-asset', runtime: 'sandbox-runtime' });
  } finally {
    await app?.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
