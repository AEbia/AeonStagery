import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStylesheet } from '../../src/__tests__/helpers/readStylesheet';

// This checks Chromium's 3D hit testing, which jsdom cannot model.
test.use({ screenshot: 'off', video: 'off', trace: 'off' });

const styles = readStylesheet('src/ui/onboarding/home/storyboard.css');

test('the pointer can move directly between storyboard cards behind the camera plane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeon-storyboard-pointer-'));
  const entry = join(directory, 'main.cjs');
  await writeFile(entry, `
    const { app, BrowserWindow } = require('electron');
    app.whenReady().then(() => {
      const window = new BrowserWindow({ width: 1200, height: 800 });
      window.loadURL('about:blank');
    });
  `);
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [entry] });
    const page = await app.firstWindow();
    // Preserve the production perspective hierarchy and negative depth of side
    // cards. A flat button fixture would miss the container intercepting hits.
    await page.setContent(`
      <style>
        ${styles}
        body { margin: 0; }
        .ph-storyboard { width: 900px; margin: 40px; }
      </style>
      <section class="ph-storyboard" data-engaged data-motion="running">
        <div class="ph-board__toolbar"></div>
        <div class="ph-board__viewport">
          <div class="ph-board__table"></div>
          <div class="ph-board__camera"><div class="ph-board__float">
            ${[0, 1, 2, 3].map(index => `
              <div class="ph-board__slot" ${index === 0 ? 'data-selected' : ''} ${index > 2 ? 'data-distant' : ''}
                style="--board-offset:${index};--board-distance:${index};--board-angle:${index === 0 ? -3 : -32}deg;z-index:${4 - index}">
                <button class="ph-board__card" data-card="${index}">
                  <span class="ph-board__cover"><span class="ph-board__cover-title">Project ${index}</span></span>
                  <span class="ph-board__card-info">Project ${index}</span>
                </button>
              </div>`).join('')}
          </div></div>
        </div>
      </section>
    `);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('.ph-board__card').forEach(card => {
        card.addEventListener('click', () => { document.body.dataset.clicked = card.dataset.card; });
      });
    });
    for (const motion of ['running', 'paused']) {
      await page.locator('.ph-storyboard').evaluate((element, value) => { element.setAttribute('data-motion', value); }, motion);
      // Stay inside the viewport throughout, including the return trip.
      for (const [x, card] of [[480, '0'], [800, '1'], [480, '0'], [800, '1']] as const) {
        await page.mouse.move(x, 250, { steps: 20 });
        await expect(page.locator('.ph-board__card:hover')).toHaveAttribute('data-card', card);
        await page.mouse.click(x, 250);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', card);
      }
    }
    await expect(page.locator('[data-distant] .ph-board__card')).toHaveCSS('pointer-events', 'none');
  } finally {
    try { await app?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
