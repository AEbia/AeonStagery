import { expect, test } from '@playwright/test';
import path from 'node:path';
import {
  captureFailureArtifacts,
  launchAeonApp,
  stopAeonApp,
  type LaunchedAeonApp,
} from './helpers/electronApp';

// Regression: the packaged app loads the renderer via file:// (loadFile on
// dist/index.html). A runtime string like src="/icon.png" resolves to the
// filesystem root there and the logo renders broken, while the dev server
// (http://localhost:5173/icon.png) hides the issue. The renderer must
// reference public assets by a document-relative URL so both hosts resolve
// them to dist/icon.png.
test('top-bar logo image decodes successfully when loaded from dist via file://', async ({}, testInfo) => {
  let launched: LaunchedAeonApp | null = null;
  let failed = false;

  try {
    // The open-dialog stub path is never triggered: this test only inspects
    // the shell that renders before any project is opened.
    launched = await launchAeonApp(path.resolve(__dirname, '../../dist/index.html'), testInfo);
    const { page } = launched;

    const logo = page.locator('.top-bar__logo');
    await expect(logo).toBeVisible({ timeout: 30_000 });

    const src = await logo.getAttribute('src');
    await expect
      .poll(
        async () =>
          logo.evaluate((img: HTMLImageElement) => (img.complete && img.naturalWidth > 0 ? 1 : 0)),
        {
          message: `logo image never decoded (broken image) for src="${src}"`,
          timeout: 15_000,
        },
      )
      .toBe(1);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
  }
});
