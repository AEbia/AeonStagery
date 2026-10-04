import { promises as fs } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SCENE_SCHEMA_VERSION_V5, type SceneDocumentV5 } from '../../src/api/types/semantic-scene';
import { chooseInspectorView, openFixtureProject } from './helpers/editorUi';
import {
  captureFailureArtifacts,
  launchAeonApp,
  stopAeonApp,
  type LaunchedAeonApp,
} from './helpers/electronApp';
import { cleanupFixtureProject, createEmptyFixtureProject } from './helpers/fixtureProject';

const PROJECT_NAME = 'E2E Color Picker Responsiveness';

function createColorPickerStressScene(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'main',
    meta: {
      title: PROJECT_NAME,
      resolution: [1920, 1080],
      fps: 60,
      durationSeconds: 15,
      characters: [],
    },
    statements: Array.from({ length: 15 }, (_, index) => ({
      id: `e2e-post-${index}`,
      time: index * 0.25,
      type: 'lighting' as const,
      params: {
        effect: 'post' as const,
        mode: 'set' as const,
        target: 'panorama',
        overlayColor: '#ffffff',
        overlayIntensity: 0.25,
        durationSeconds: 0.5,
      },
    })),
  };
}

async function dispatchColorDrag(page: Page, testId: string) {
  return page.getByTestId(testId).evaluate(async (element) => {
    const input = element as HTMLInputElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setNativeValue) throw new Error('Native color input value setter is unavailable');

    let finalColor = '';
    let nextDispatch = performance.now();

    for (let index = 0; index < 45; index += 1) {
      nextDispatch += 8;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, Math.max(0, nextDispatch - performance.now()));
      });

      const color = `#${((index * 7919 + 1024) % 0xffffff).toString(16).padStart(6, '0')}`;
      finalColor = color;
      setNativeValue.call(input, color);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    return finalColor;
  });
}

test('color picker defers scene updates until a drag is committed', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createEmptyFixtureProject({ name: PROJECT_NAME });
  await fs.writeFile(fixture.sceneFilePath, JSON.stringify(createColorPickerStressScene(), null, 2), 'utf8');

  let launched: LaunchedAeonApp | null = null;
  let failed = false;
  try {
    launched = await launchAeonApp(fixture.projectFilePath, testInfo);
    const { page } = launched;
    await openFixtureProject(page, PROJECT_NAME);
    await page.getByTestId('timeline-track-block').first().click();
    await chooseInspectorView(page, '剧本动作');

    const colorInput = page.getByTestId('action-param-overlayColor-color');
    await expect(colorInput).toBeVisible();
    const colorLabel = colorInput.locator('xpath=../span');
    const originalColor = await colorLabel.textContent();
    const finalColor = await dispatchColorDrag(page, 'action-param-overlayColor-color');

    await expect(colorInput).toHaveValue(finalColor);
    await page.waitForTimeout(700);
    expect(await colorLabel.textContent()).toBe(originalColor);

    await colorInput.evaluate((element) => {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(colorLabel).toHaveText(finalColor);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
    await cleanupFixtureProject(fixture);
  }
});
