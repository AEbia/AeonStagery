import { expect, type Locator, type Page } from '@playwright/test';

export async function chooseInspectorView(page: Page, label: string): Promise<void> {
  await page.locator('.inspector-view-picker summary').click();
  await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
}

export async function setInlineNumber(page: Page, testId: string, value: string): Promise<void> {
  const control = page.getByTestId(testId);
  await control.click();

  const input = page.locator(`input[data-testid="${testId}"]`);
  await expect(input).toBeEditable();
  await input.fill(value);
  await input.press('Enter');
  await expect(page.getByTestId(testId)).toHaveAttribute('role', 'spinbutton');
}

/** Drive the pointer listeners used by timeline drag and resize interactions. */
export async function dragBy(
  page: Page,
  locator: Locator,
  dx: number,
  dy = 0,
): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();

  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;

  await locator.evaluate((element, { x, y }) => {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
    }));
  }, { x: startX, y: startY });

  await page.waitForTimeout(50);
  await page.evaluate(({ startX: x, startY: y, deltaX, deltaY }) => {
    const dispatchPointer = (type: string, clientX: number, clientY: number, buttons: number) => {
      window.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: type === 'pointerup' ? 0 : -1,
        buttons,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: 'mouse',
      }));
    };
    dispatchPointer('pointermove', x + deltaX * 0.35, y + deltaY * 0.35, 1);
    dispatchPointer('pointermove', x + deltaX * 0.7, y + deltaY * 0.7, 1);
    dispatchPointer('pointermove', x + deltaX, y + deltaY, 1);
    dispatchPointer('pointerup', x + deltaX, y + deltaY, 0);
  }, { startX, startY, deltaX: dx, deltaY: dy });
}

export async function openFixtureProject(page: Page, projectName = 'E2E Editing Smoke'): Promise<void> {
  await page.getByRole('button', { name: '打开项目' }).first().click();
  await expect(page.getByText(projectName).first()).toBeVisible();
  await expect(page.getByTestId('timeline-track-area')).toBeVisible();
}

export async function saveScene(page: Page): Promise<void> {
  await page.locator('body').press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
}

export async function getTimelineAction(page: Page, actionId: string): Promise<Locator> {
  const action = page.locator(`[data-testid="timeline-track-block"][data-action-id="${actionId}"]`);
  await expect(action).toBeVisible();
  return action;
}

export async function getFirstTimelineActionOnTrack(page: Page, trackId: string): Promise<Locator> {
  const action = page.locator(`[data-testid="timeline-track-block"][data-track-id="${trackId}"]`).first();
  await expect(action).toBeVisible();
  return action;
}
