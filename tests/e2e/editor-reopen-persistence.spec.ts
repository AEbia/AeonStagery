import { expect, test } from '@playwright/test';
import { captureFailureArtifacts, launchAeonApp, stopAeonApp, type LaunchedAeonApp } from './helpers/electronApp';
import { chooseInspectorView, getFirstTimelineActionOnTrack, openFixtureProject, saveScene } from './helpers/editorUi';
import {
  cleanupFixtureProject,
  createSavedFixtureProject,
  FIXTURE_DIALOGUE_ACTION_ID,
  readFixtureProjectFiles,
} from './helpers/fixtureProject';

const INITIAL_TEXT = 'E2E dialogue before restart';
const UPDATED_TEXT = 'E2E dialogue after restart';
const FINAL_TEXT = 'E2E dialogue continued after reopen';
const PROJECT_NAME = 'E2E Reopen Persistence';

test('reopening a saved project restores the scene and permits another disk-backed edit', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const fixture = await createSavedFixtureProject({ name: PROJECT_NAME });
  let launched: LaunchedAeonApp | null = null;
  let failed = false;

  try {
    launched = await launchAeonApp(fixture.projectFilePath, testInfo);
    let page = launched.page;
    await openFixtureProject(page, PROJECT_NAME);

    await chooseInspectorView(page, '剧本动作');
    const firstBlock = await getFirstTimelineActionOnTrack(page, 'char:e2e_hero');
    await firstBlock.click();
    await expect(page.getByTestId('action-param-text')).toHaveValue(INITIAL_TEXT);
    await page.getByTestId('action-param-text').fill(UPDATED_TEXT);
    await page.getByTestId('action-param-text').blur();
    await expect(page.getByTestId('timeline-selection-bar')).toContainText(UPDATED_TEXT);
    await saveScene(page);

    await expect.poll(async () => {
      const files = await readFixtureProjectFiles(fixture);
      return files.scene.statements.find((statement) => statement.id === FIXTURE_DIALOGUE_ACTION_ID)?.params.text;
    }).toBe(UPDATED_TEXT);

    const firstSavedFiles = await readFixtureProjectFiles(fixture);
    expect(firstSavedFiles.project).toEqual(expect.objectContaining({
      name: PROJECT_NAME,
      defaultSceneId: 'main',
      scenes: [expect.objectContaining({ id: 'main', path: 'project/main.scene.json' })],
    }));
    expect(firstSavedFiles.scene.meta).toEqual(expect.objectContaining({ title: PROJECT_NAME }));

    await stopAeonApp(launched, false);
    launched = null;

    launched = await launchAeonApp(fixture.projectFilePath, testInfo);
    page = launched.page;
    await openFixtureProject(page, PROJECT_NAME);

    await chooseInspectorView(page, '剧本动作');
    const reopenedBlock = await getFirstTimelineActionOnTrack(page, 'char:e2e_hero');
    await reopenedBlock.click();
    await expect(page.getByTestId('action-param-text')).toHaveValue(UPDATED_TEXT);
    await page.getByTestId('action-param-text').fill(FINAL_TEXT);
    await page.getByTestId('action-param-text').blur();
    await expect(page.getByTestId('timeline-selection-bar')).toContainText(FINAL_TEXT);
    await saveScene(page);

    await expect.poll(async () => {
      const files = await readFixtureProjectFiles(fixture);
      return files.scene.statements.find((statement) => statement.id === FIXTURE_DIALOGUE_ACTION_ID)?.params.text;
    }).toBe(FINAL_TEXT);

    const savedFiles = await readFixtureProjectFiles(fixture);
    expect(savedFiles.project).toEqual(expect.objectContaining({
      name: PROJECT_NAME,
      defaultSceneId: 'main',
      scenes: [expect.objectContaining({ id: 'main', path: 'project/main.scene.json' })],
    }));
    expect(savedFiles.scene.meta).toEqual(expect.objectContaining({ title: PROJECT_NAME }));
    expect(savedFiles.scene.meta.characters).toEqual([
      expect.objectContaining({ id: 'e2e_hero', name: 'E2E 主角' }),
    ]);
    expect(savedFiles.scene.statements).toEqual([
      expect.objectContaining({
        id: FIXTURE_DIALOGUE_ACTION_ID,
        type: 'dialogue',
        time: 1,
        params: expect.objectContaining({
          speakerId: 'e2e_hero',
          text: FINAL_TEXT,
        }),
      }),
    ]);
    expect(savedFiles.scene.statements[0].params.durationSeconds).toBeGreaterThan(0);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
    await cleanupFixtureProject(fixture);
  }
});
