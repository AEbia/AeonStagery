import { expect, test, type Page } from '@playwright/test';
import { captureFailureArtifacts, launchAeonApp, stopAeonApp, type LaunchedAeonApp } from './helpers/electronApp';
import { dragBy, chooseInspectorView, getTimelineAction, openFixtureProject, saveScene, setInlineNumber } from './helpers/editorUi';
import {
  cleanupFixtureProject,
  createEmptyFixtureProject,
  readFixtureProjectFiles,
} from './helpers/fixtureProject';

const DIALOGUE_TEXT = 'E2E dialogue persisted';
const PROJECT_NAME = 'E2E First Editing';

test('editing a project through the Electron UI saves a realistic dialogue edit to disk', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const fixture = await createEmptyFixtureProject({ name: PROJECT_NAME });
  let launched: LaunchedAeonApp | null = null;
  let failed = false;

  try {
    launched = await launchAeonApp(fixture.projectFilePath, testInfo);
    const { page } = launched;

    await openFixtureProject(page, PROJECT_NAME);

    await chooseInspectorView(page, '角色管理');
    await page.getByTestId('character-add-button').click();
    await expect(page.getByTestId('character-id-input')).toHaveValue('1');
    await page.getByTestId('character-id-input').fill('e2e_hero');
    await expect(page.getByTestId('character-list-item').filter({ hasText: 'e2e_hero' })).toBeVisible();
    await page.getByTestId('character-name-input').fill('E2E 主角');
    await expect(page.getByTestId('character-list-item').filter({ hasText: 'E2E 主角' })).toBeVisible();

    const characterTrack = page.locator('[data-testid="timeline-track-row"][data-track-id="char:e2e_hero"]');
    await expect(characterTrack).toBeVisible();
    await characterTrack.click({ button: 'right', position: { x: 220, y: 20 } });
    await expect(page.getByTestId('timeline-blank-insert-menu')).toBeVisible();
    await page.locator('[data-block-id="dialogue.basic"]').click();

    const insertedDialogueBlock = page.getByTestId('timeline-track-block').first();
    await expect(insertedDialogueBlock).toBeVisible();
    await expect(insertedDialogueBlock).toHaveAttribute('data-track-id', 'char:e2e_hero');
    const dialogueActionId = await insertedDialogueBlock.getAttribute('data-action-id');
    expect(dialogueActionId).toBeTruthy();

    await chooseInspectorView(page, '剧本动作');
    const dialogueTextInput = page.getByTestId('action-param-text');
    await expect(dialogueTextInput).toBeVisible();
    await dialogueTextInput.click();
    await dialogueTextInput.fill(DIALOGUE_TEXT);
    await dialogueTextInput.blur();
    await page.getByTestId('action-param-speakerId').click();
    await page.getByRole('option', { name: /E2E 主角.*e2e_hero/ }).click();
    await setInlineNumber(page, 'action-param-durationSeconds', '2.0');

    await expect(page.getByTestId('timeline-selection-bar')).toContainText(DIALOGUE_TEXT);
    const dialogueBlock = await getTimelineAction(page, dialogueActionId!);
    await expect(dialogueBlock).toHaveAttribute('data-action-duration', '2');

    const timeBeforeDrag = Number(await dialogueBlock.getAttribute('data-action-time'));
    await dragBy(page, dialogueBlock, 260);
    await expect.poll(async () => Number(await dialogueBlock.getAttribute('data-action-time'))).toBeGreaterThan(timeBeforeDrag);
    const timeAfterDrag = Number(await dialogueBlock.getAttribute('data-action-time'));

    const durationBeforeResize = Number(await dialogueBlock.getAttribute('data-action-duration'));
    const resizeHandle = page.locator(`[data-testid="timeline-resize-handle"][data-action-id="${dialogueActionId}"]`);
    await dragBy(page, resizeHandle, 120);
    await expect.poll(async () => Number(await dialogueBlock.getAttribute('data-action-duration'))).toBeGreaterThan(durationBeforeResize);
    const durationAfterResize = Number(await dialogueBlock.getAttribute('data-action-duration'));

    await page.getByTestId('action-param-text').blur();
    await expect(page.getByTestId('timeline-selection-bar')).toContainText(DIALOGUE_TEXT);
    await saveScene(page);

    await expect.poll(async () => {
      const files = await readFixtureProjectFiles(fixture);
      return files.scene.statements[0]?.params.text;
    }).toBe(DIALOGUE_TEXT);

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
    expect(savedFiles.scene.statements).toHaveLength(1);
    expect(savedFiles.scene.statements[0]).toEqual(expect.objectContaining({
      type: 'dialogue',
      params: expect.objectContaining({
        speakerId: 'e2e_hero',
        text: DIALOGUE_TEXT,
      }),
    }));
    expect(savedFiles.scene.statements[0].time).toBeCloseTo(timeAfterDrag, 1);
    expect(savedFiles.scene.statements[0].params.durationSeconds).toBeCloseTo(durationAfterResize, 1);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
    await cleanupFixtureProject(fixture);
  }
});
