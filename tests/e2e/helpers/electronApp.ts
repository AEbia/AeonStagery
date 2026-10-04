import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { TestInfo } from '@playwright/test';

export interface LaunchedAeonApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  stopTrace: (failed: boolean) => Promise<void>;
}

const repoRoot = path.resolve(__dirname, '../../..');

export async function launchAeonApp(projectPathForOpenDialog: string, testInfo: TestInfo): Promise<LaunchedAeonApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeon-e2e-user-data-'));
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: ['--force-device-scale-factor=1', repoRoot],
      cwd: repoRoot,
      env: {
        ...process.env,
        AEON_E2E: '1',
        AEON_E2E_LOAD_DIST: '1',
        AEON_E2E_USER_DATA: userDataDir,
      },
      timeout: 30_000,
    });

    await app.evaluate(({ dialog }, projectPath) => {
      (globalThis as Record<string, unknown>).__AEON_E2E_ORIGINAL_SHOW_OPEN_DIALOG ??= dialog.showOpenDialog;
      (dialog as unknown as { showOpenDialog: () => Promise<{ canceled: false; filePaths: string[] }> }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [projectPath],
      });
    }, projectPathForOpenDialog);

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });

    const stopTrace = async (failed: boolean) => {
      try {
        if (failed) {
          await app!.context().tracing.stop({ path: testInfo.outputPath('trace.zip') });
        } else {
          await app!.context().tracing.stop();
        }
      } catch {
        // The app may already be closed after a launch failure.
      }
    };

    return { app, page, userDataDir, stopTrace };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function closeAeonApp(launched: LaunchedAeonApp | null | undefined): Promise<void> {
  if (!launched) return;
  try {
    await launched.app.close();
  } catch {
    // The process may already have exited during a failing test.
  } finally {
    await fs.rm(launched.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stopAeonApp(
  launched: LaunchedAeonApp | null | undefined,
  failed: boolean,
): Promise<void> {
  if (!launched) return;
  await launched.stopTrace(failed);
  await closeAeonApp(launched);
}

export async function captureFailureArtifacts(page: Page | null | undefined, testInfo: TestInfo): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => undefined);
}
