import { expect, test } from '@playwright/test';
import {
  captureFailureArtifacts,
  launchAeonApp,
  stopAeonApp,
  type LaunchedAeonApp,
} from './helpers/electronApp';
import { openFixtureProject } from './helpers/editorUi';
import {
  cleanupFixtureProject,
  createSavedFixtureProject,
} from './helpers/fixtureProject';

test('script-action priority extends the side panel and gives the tracks the remaining width', async ({}, testInfo) => {
  const projectName = 'E2E Workbench Layout';
  const fixture = await createSavedFixtureProject({ name: projectName });
  let launched: LaunchedAeonApp | null = null;
  let failed = false;

  try {
    launched = await launchAeonApp(fixture.projectFilePath, testInfo);
    const { page } = launched;
    await page.addLocatorHandler(page.locator('.live2d-runtime-dialog'), async dialog => {
      await dialog.getByRole('button', { name: /我知道了|配置完成，进入/ }).click();
    });
    await page.evaluate(() => {
      const key = 'aeonstagery_settings';
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({
        ...saved,
        workbenchTimelineLayoutMode: 'list',
        showLive2DRuntimeSetupOnStartup: false,
      }));
    });
    await page.reload();
    await openFixtureProject(page, projectName);

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const bounds = element.getBoundingClientRect();
        return {
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
        };
      };
      return {
        sidePanel: rect('.side-panel'),
        navigator: rect('.inspector-workspace__pane--navigator'),
        main: rect('.main-content'),
        trackPanel: rect('.bottom-panel'),
        trackEditor: rect('.bottom-panel .timeline-editor-root'),
        trackViewport: rect('.bottom-panel .timeline-editor-scroll-container'),
        zoomSlider: rect('[data-testid="timeline-zoom-slider"]'),
        zoomWindow: rect('[data-testid="timeline-zoom-window"]'),
      };
    });

    expect(geometry.sidePanel.top).toBeCloseTo(geometry.main.top, 0);
    expect(geometry.sidePanel.bottom).toBeCloseTo(geometry.trackPanel.bottom, 0);
    expect(geometry.navigator.bottom).toBeCloseTo(geometry.trackPanel.bottom, 0);
    expect(geometry.trackPanel.right).toBeLessThanOrEqual(geometry.navigator.left + 1);
    expect(geometry.trackEditor.right).toBeLessThanOrEqual(geometry.navigator.left + 1);
    expect(geometry.trackViewport.right).toBeCloseTo(geometry.navigator.left, 0);
    expect(geometry.zoomSlider.right).toBeCloseTo(geometry.navigator.left, 0);
    expect(geometry.zoomWindow.right).toBeLessThanOrEqual(geometry.zoomSlider.right + 1);

    await page.getByTestId('timeline-zoom-handle-right').press('End');

    const separator = page.getByRole('separator', { name: '调整剧本动作面板宽度' });
    const separatorBounds = await separator.boundingBox();
    expect(separatorBounds).not.toBeNull();
    const x = separatorBounds!.x + separatorBounds!.width / 2;
    const y = separatorBounds!.y + separatorBounds!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 240, y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => page.evaluate(() => {
      const slider = document.querySelector('[data-testid="timeline-zoom-slider"]')!;
      const zoomWindow = document.querySelector('[data-testid="timeline-zoom-window"]')!;
      return zoomWindow.getBoundingClientRect().right - slider.getBoundingClientRect().right;
    })).toBeLessThanOrEqual(1);

    const resizedGeometry = await page.evaluate(() => {
      const navigator = document.querySelector('.inspector-workspace__pane--navigator')!;
      const viewport = document.querySelector('.bottom-panel .timeline-editor-scroll-container')!;
      return { navigatorLeft: navigator.getBoundingClientRect().left, viewportRight: viewport.getBoundingClientRect().right };
    });
    expect(resizedGeometry.navigatorLeft).toBeLessThan(geometry.navigator.left);
    expect(resizedGeometry.viewportRight).toBeCloseTo(resizedGeometry.navigatorLeft, 0);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
    await cleanupFixtureProject(fixture);
  }
});
