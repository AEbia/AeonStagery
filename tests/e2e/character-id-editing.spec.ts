import { expect, test } from '@playwright/test';
import { captureFailureArtifacts, launchAeonApp, stopAeonApp, type LaunchedAeonApp } from './helpers/electronApp';
import { chooseInspectorView, openFixtureProject, saveScene } from './helpers/editorUi';
import {
  cleanupFixtureProject,
  createEmptyFixtureProject,
  readFixtureProjectFiles,
} from './helpers/fixtureProject';

const PROJECT_NAME = 'E2E Character Id Editing';

test('editing a character id keeps accepting keystrokes after the value is deleted', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const fixture = await createEmptyFixtureProject({ name: PROJECT_NAME });
  let launched: LaunchedAeonApp | null = null;
  let failed = false;

  try {
    launched = await launchAeonApp(fixture.projectFilePath, testInfo);
    const { page } = launched;

    const reactWarnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        reactWarnings.push(message.text());
      }
    });

    await openFixtureProject(page, PROJECT_NAME);
    await chooseInspectorView(page, '角色管理');

    await page.getByTestId('character-add-button').click();
    await page.getByTestId('character-add-button').click();

    const listItems = page.getByTestId('character-list-item');
    await expect(listItems).toHaveCount(2);

    // Rename the second character with real keyboard events.
    await listItems.nth(1).click();
    const idInput = page.getByTestId('character-id-input');
    await expect(idInput).toHaveValue('2');

    await idInput.selectText();
    await page.keyboard.press('Backspace');
    await expect(idInput).toHaveValue('');
    await page.keyboard.type('hero');

    await expect(idInput).toHaveValue('hero');
    await expect(idInput).toBeFocused();
    await expect(listItems.nth(1)).toContainText('hero');

    // Deleting a single digit must leave the field editable for the next keys.
    await page.keyboard.press('Backspace');
    await page.keyboard.type('o2');
    await expect(idInput).toHaveValue('hero2');
    await expect(listItems.nth(1)).toContainText('hero2');

    // The first character keeps its own id and its own field value.
    await listItems.nth(0).click();
    await expect(page.getByTestId('character-id-input')).toHaveValue('1');
    await listItems.nth(1).click();
    await expect(page.getByTestId('character-id-input')).toHaveValue('hero2');

    expect(reactWarnings.filter((warning) => warning.includes('same key'))).toEqual([]);

    await saveScene(page);
    await expect.poll(async () => {
      const files = await readFixtureProjectFiles(fixture);
      return files.scene.meta.characters?.map((character) => character.id);
    }).toEqual(['1', 'hero2']);
  } catch (error) {
    failed = true;
    await captureFailureArtifacts(launched?.page, testInfo);
    throw error;
  } finally {
    await stopAeonApp(launched, failed);
    await cleanupFixtureProject(fixture);
  }
});
