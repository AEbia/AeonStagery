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
    await page.evaluate(() => {
      const key = 'aeonstagery_settings';
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({
        ...saved,
        workbenchTimelineLayoutMode: 'list',
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
      };
    });

    expect(geometry.sidePanel.top).toBeCloseTo(geometry.main.top, 0);
    expect(geometry.sidePanel.bottom).toBeCloseTo(geometry.trackPanel.bottom, 0);
    expect(geometry.navigator.bottom).toBeCloseTo(geometry.trackPanel.bottom, 0);
    expect(geometry.trackPanel.right).toBeLessThanOrEqual(geometry.navigator.left + 1);
    expect(geometry.trackEditor.right).toBeLessThanOrEqual(geometry.navigator.left + 1);

    await page.getByTestId('timeline-track-block').first().click();
    await expect(page.getByTestId('action-param-text')).toBeVisible();

    const readSplitGeometry = async () => page.evaluate(() => {
      const boundsOf = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        return element.getBoundingClientRect();
      };
      const main = boundsOf('.main-content');
      const sidePanel = boundsOf('.side-panel');
      const navigator = boundsOf('.inspector-workspace__pane--navigator');
      const detail = boundsOf('.inspector-workspace__detail');
      const trackPanel = boundsOf('.bottom-panel');
      const pointBelowDetail = document.elementFromPoint(
        detail.left + detail.width / 2,
        trackPanel.top + trackPanel.height / 2,
      );
      return {
        mainBottom: main.bottom,
        sidePanelLeft: sidePanel.left,
        sidePanelBottom: sidePanel.bottom,
        navigatorLeft: navigator.left,
        navigatorBottom: navigator.bottom,
        detailBottom: detail.bottom,
        trackRight: trackPanel.right,
        trackBottom: trackPanel.bottom,
        belowDetailIsTrack: !!pointBelowDetail?.closest('.bottom-panel'),
      };
    });

    await expect.poll(async () => {
      const current = await readSplitGeometry();
      return current.trackRight > current.sidePanelLeft && current.belowDetailIsTrack;
    }).toBe(true);

    const splitGeometry = await readSplitGeometry();

    expect(splitGeometry.sidePanelBottom).toBeCloseTo(splitGeometry.trackBottom, 0);
    expect(splitGeometry.navigatorBottom).toBeCloseTo(splitGeometry.trackBottom, 0);
    expect(splitGeometry.detailBottom).toBeCloseTo(splitGeometry.mainBottom, 0);
    expect(splitGeometry.trackRight).toBeLessThanOrEqual(splitGeometry.navigatorLeft + 1);
    expect(splitGeometry.trackRight).toBeGreaterThan(splitGeometry.sidePanelLeft);
    expect(splitGeometry.belowDetailIsTrack).toBe(true);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
    await cleanupFixtureProject(fixture);
  }
});
