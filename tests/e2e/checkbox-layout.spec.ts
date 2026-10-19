import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStylesheet } from '../../src/__tests__/helpers/readStylesheet';

test.use({ screenshot: 'off', video: 'off', trace: 'off' });

// Use the shipped Electron: Chromium 150 briefly exposes text-field padding on
// native checkboxes during a box-shadow transition; newer Chromium may not.
const styles = [
  'src/styles/index.css',
  'src/ui/timeline/Inspector.css',
  'src/ui/onboarding/projectHome.css',
  'src/ui/changelog/changelog.css',
].map(readStylesheet).join('\n');

async function expectStableToggle(page: Page, id: string, activate: () => Promise<unknown>) {
  const input = page.locator(`#${id}`);
  const wasChecked = await input.isChecked();
  // Sample every animation frame, including pointer down and the focus
  // transition. Comparing only the settled layout misses this regression.
  const sampling = page.evaluate(async () => {
    const measure = () => Array.from(document.querySelectorAll('.fixture, .fixture input, .fixture label, .fixture span, .fixture p'))
      .map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { element: element.id || element.className || element.tagName, x, y, width, height };
      });
    const samples = [];
    for (let frame = 0; frame < 24; frame += 1) {
      samples.push(measure());
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return samples;
  });
  await activate();
  const samples = await sampling;
  await expect(input).toBeChecked({ checked: !wasChecked });
  const changedFrame = samples.find(sample => JSON.stringify(sample) !== JSON.stringify(samples[0]));
  const changes = changedFrame?.flatMap((after, index) => {
    const before = samples[0][index];
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ before, after }];
  }) ?? [];
  expect(changes, `${id} must keep its size and surrounding layout throughout activation`).toEqual([]);
}

for (const theme of ['light', 'dark']) {
  test(`checkboxes keep their layout while toggling in the ${theme} theme`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeon-checkbox-layout-'));
    const entry = join(directory, 'main.cjs');
    await writeFile(entry, `
      const { app, BrowserWindow } = require('electron');
      app.whenReady().then(() => {
        const window = new BrowserWindow({ width: 800, height: 600 });
        window.loadURL('about:blank');
      });
    `);
    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({ args: [entry] });
      const page = await app.firstWindow();
      await page.setContent(`
        <style>${styles}</style>
        <main data-theme="${theme}" style="width: 240px">
          <section class="fixture selected-action-inspector" style="height: auto">
            <div class="inspector-row"><div></div>
              <div style="display: flex; align-items: center; gap: 8px">
                <input id="inspector" type="checkbox" checked>
                <label for="inspector" class="inspector-label" style="margin: 0; text-align: left">启用视线</label>
              </div>
            </div><p>后续属性</p>
          </section>
          <section class="fixture voice-workbench" style="height: auto">
            <label for="voice" class="voice-workbench__toggle"><input id="voice" type="checkbox"><span>并行推理</span></label>
            <p>后续语音设置</p>
          </section>
          <section class="fixture">
            <label for="home" class="ph-checkbox-row"><input id="home" type="checkbox" checked><span>允许网络访问</span></label>
            <p>后续项目设置</p>
          </section>
          <section class="fixture">
            <label for="changelog" class="changelog-auto-prompt-label"><input id="changelog" type="checkbox" class="changelog-auto-prompt-checkbox"><span>自动显示更新日志</span></label>
            <p>后续设置</p>
          </section>
          <section class="fixture">
            <label for="agent" class="agent-promptbox__access"><input id="agent" type="checkbox"><span class="agent-promptbox__access-track"></span><span>完全访问</span></label>
            <p>后续智能体设置</p>
          </section>
          <section class="fixture"><label><input id="disabled" type="checkbox" checked disabled>不可修改</label></section>
        </main>
      `);
      for (const id of ['inspector', 'voice', 'home', 'changelog', 'agent']) {
        const input = page.locator(`#${id}`);
        // The agent checkbox is intentionally clipped behind its switch.
        if (id !== 'agent') {
          await expectStableToggle(page, id, () => input.click({ delay: 45 }));
          await page.locator('input:focus').evaluate(element => (element as HTMLElement).blur());
        }
        await expectStableToggle(page, id, () => page.locator(`label[for="${id}"]`).click({ delay: 45 }));
        await expectStableToggle(page, id, () => input.press('Space'));
        await expect(input).toBeFocused();
        if (id !== 'agent') await expect(input).toHaveCSS('outline-style', 'solid');
      }
      await expect(page.locator('#disabled')).toBeChecked();
      await expect(page.locator('#disabled')).toBeDisabled();
    } finally {
      try {
        await app?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
}
