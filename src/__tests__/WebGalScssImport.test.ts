import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installWebGalTemplatePackage,
  inspectWebGalTemplateDirectory,
} from '../../electron/webgal-scss-import';
import { WEBGAL_IMPORT_RECORD_FILE } from '../services/import/webgal/WebGalScssPackageNaming';

/**
 * A template exercising the paths a real theme uses: a container scale, a `%`
 * body size, an outline layer, a `background-clip: text` fill, a gradient
 * nameplate, a corner ornament and a declared font.
 */
const SCSS = `
.TextBox_main {
  position: absolute;
  left: 120px;
  right: 120px;
  bottom: 60px;
  height: 300px;
  padding: 40px;
  font-size: 40px;
  transform: scale(0.5);
  align-items: flex-start;
}
.text { font-size: 240%; line-height: 1.4; }
.TextBox_Background {
  background: rgba(255, 255, 255, 0.8);
  border: 2px solid black;
  border-radius: 24px;
  box-shadow: 0 6px 20px rgba(190, 190, 190, 0.8);
}
.TextBox_Background::after {
  width: 105px; height: 105px; right: 8px; bottom: -5px; opacity: 0.4;
  background-image: url('assets/textbox-meteor.svg');
}
.outer { color: transparent; background: #123456; background-clip: text; }
.inner { -webkit-text-stroke: 4px white; text-shadow: 0 0 12px rgba(0,0,0,.9); }
.TextBox_showName {
  left: 24px;
  top: -72px;
  min-width: 10em;
  padding-left: 1.5em;
  font-size: 100%;
}
.outerName { color: #FFFFFFCC; }
.TextBox_ShowName_Background {
  background: linear-gradient(180deg, #ff9ec4, #ff3b72);
  border-radius: 9999px;
}
.innerName { -webkit-text-stroke: 6px #ff3b72; }
`;

const FONT_BYTES = 'fake-truetype-payload';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** Lay out a WebGAL template directory the way WebGAL itself ships one. */
async function writeTemplate(
  templateRoot: string,
  options: { scss?: string; name?: string; font?: boolean } = {},
): Promise<void> {
  const { scss = SCSS, name = 'Fixture Theme', font = true } = options;
  await mkdir(path.join(templateRoot, 'Stage', 'TextBox'), { recursive: true });
  await mkdir(path.join(templateRoot, 'assets'), { recursive: true });
  await writeFile(path.join(templateRoot, 'Stage', 'TextBox', 'textbox.scss'), scss, 'utf8');
  await writeFile(
    path.join(templateRoot, 'assets', 'textbox-meteor.svg'),
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#f0f"/></svg>',
    'utf8',
  );
  await writeFile(
    path.join(templateRoot, 'template.json'),
    JSON.stringify({
      name,
      id: '1234-uuid',
      fonts: font
        ? [{ 'font-family': 'Fixture Sans', url: 'assets/FixtureSans.ttf', type: 'truetype' }]
        : [],
    }),
    'utf8',
  );
  if (font) {
    await writeFile(path.join(templateRoot, 'assets', 'FixtureSans.ttf'), FONT_BYTES, 'utf8');
  }
}

async function listPackageDirectories(templatesRoot: string): Promise<string[]> {
  const entries = await readdir(templatesRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
}

describe('WebGAL SCSS template import', () => {
  it('reports what would be installed before touching the library', async () => {
    const root = await makeRoot('aeonstagery-webgal-inspect-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });

    expect(inspection).toMatchObject({
      templateName: 'Fixture Theme',
      packageName: 'Fixture Theme',
      packageId: 'webgal-scss.Fixture-Theme',
      styleName: 'Fixture Theme',
      sourceName: 'textbox.scss',
    });
    expect(inspection.styleId).toBe(inspection.packageId);
    expect(inspection.conflicts).toEqual([]);
    expect(inspection.unverifiableCount).toBe(0);
    expect(inspection.notes.length).toBeGreaterThan(5);
    // Nothing was written yet.
    await expect(stat(templatesRoot)).rejects.toThrow();
  });

  it('writes a loadable package with artwork, the font and a source record', async () => {
    const root = await makeRoot('aeonstagery-webgal-install-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    const installed = await installWebGalTemplatePackage({ templateRoot, templatesRoot });

    expect(installed).toMatchObject({
      id: inspection.packageId,
      name: 'Fixture Theme',
      version: '1.0.0',
      replaced: false,
    });
    expect(await listPackageDirectories(templatesRoot)).toEqual([inspection.packageId]);

    const packageRoot = path.join(templatesRoot, inspection.packageId);
    const files = (await readdir(path.join(packageRoot, 'assets', 'ui', 'dialogue', 'webgal'))).sort();
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.startsWith('textbox-'))).toBe(true);
    expect(files.some((name) => name.startsWith('namebox-'))).toBe(true);

    // The font is copied verbatim so the editor can register it.
    expect(await readFile(path.join(packageRoot, 'assets', 'fonts', 'FixtureSans.ttf'), 'utf8'))
      .toBe(FONT_BYTES);

    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'manifest.v2.json'), 'utf8'));
    expect(manifest.template.id).toBe(inspection.packageId);
    const params = manifest.dialogueStyles[0].params;
    // Both panels point at files that exist, under the package's asset root.
    expect(files).toContain(params.textbox.image.split('/').pop());
    expect(files).toContain(params.namebox.image.split('/').pop());
    expect(params.text.strokeColor).toBe('#FFFFFF');
    expect(params.speaker.strokeColor).toBe('#FF3B72');

    const record = JSON.parse(await readFile(path.join(packageRoot, WEBGAL_IMPORT_RECORD_FILE), 'utf8'));
    expect(record).toMatchObject({
      sourceHash: inspection.sourceHash,
      sourceName: 'textbox.scss',
      styleIds: [inspection.styleId],
    });
    expect(record.importedAt).toBeTruthy();
  });

  it('recognises an identical re-import and can replace the installed package', async () => {
    const root = await makeRoot('aeonstagery-webgal-replace-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot });

    const secondInspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(secondInspection.conflicts).toHaveLength(1);
    expect(secondInspection.conflicts[0]).toMatchObject({
      packageId: first.id,
      packageName: first.name,
      contentMatch: true,
    });
    // A cosmetic edit must not defeat the check.
    await writeTemplate(templateRoot, { scss: `/* note */\n${SCSS.replace(/\n/g, '\n\n')}` });
    const reformatted = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(reformatted.conflicts).toHaveLength(1);
    expect(reformatted.conflicts[0].contentMatch).toBe(true);

    const replaced = await installWebGalTemplatePackage({
      templateRoot,
      templatesRoot,
      replacePackageId: first.id,
    });
    expect(replaced.replaced).toBe(true);
    // Replacing keeps the id, so scenes referencing the style keep working.
    expect(replaced.id).toBe(first.id);
    expect(await listPackageDirectories(templatesRoot)).toEqual([first.id]);
  });

  it('keeps the installed dialogue style id when replacing', async () => {
    const root = await makeRoot('aeonstagery-webgal-styleid-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const first = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, styleId: 'legacy-dialogue',
    });
    const styleIds = async () => {
      const manifest = JSON.parse(
        await readFile(path.join(templatesRoot, first.id, 'manifest.v2.json'), 'utf8'),
      ) as { dialogueStyles?: { id: string }[] };
      return (manifest.dialogueStyles ?? []).map((style) => style.id);
    };
    expect(await styleIds()).toEqual(['legacy-dialogue']);

    const replaced = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: first.id,
    });
    expect(replaced.replaced).toBe(true);
    // Replacing must not fold the style id back onto the package id: scenes
    // reference the style, not the package.
    expect(await styleIds()).toEqual(['legacy-dialogue']);
  });

  it('replaces the package in the directory it actually lives in', async () => {
    const root = await makeRoot('aeonstagery-webgal-dirname-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    // Package discovery reads the manifest, so a directory may be named freely.
    const customRoot = path.join(templatesRoot, 'custom-folder');
    await rename(path.join(templatesRoot, first.id), customRoot);

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(inspection.conflicts[0]).toMatchObject({ packageId: first.id });

    const replaced = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: first.id,
    });
    expect(replaced.replaced).toBe(true);
    expect(replaced.installPath).toBe(customRoot);
    expect(await listPackageDirectories(templatesRoot)).toEqual(['custom-folder']);
  });

  it('adds a separate package when the user keeps the import', async () => {
    const root = await makeRoot('aeonstagery-webgal-duplicate-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    const second = await installWebGalTemplatePackage({ templateRoot, templatesRoot });

    expect(second.id).not.toBe(first.id);
    expect(second.name).not.toBe(first.name);
    expect(second.name).toBe('Fixture Theme-2');
    expect((await listPackageDirectories(templatesRoot)).sort()).toEqual([first.id, second.id].sort());
  });

  it('treats an edited stylesheet as a new template', async () => {
    const root = await makeRoot('aeonstagery-webgal-edited-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    await installWebGalTemplatePackage({ templateRoot, templatesRoot });

    await writeTemplate(templateRoot, { scss: SCSS.replace('height: 300px', 'height: 320px') });
    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });

    expect(inspection.conflicts).toEqual([]);
  });

  it('installs without a font when the template declares none', async () => {
    const root = await makeRoot('aeonstagery-webgal-nofont-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot, { font: false });

    const installed = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    const packageRoot = path.join(templatesRoot, installed.id);

    await expect(stat(path.join(packageRoot, 'assets', 'fonts'))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'manifest.v2.json'), 'utf8'));
    expect(manifest.dialogueStyles[0].params.text.fontFile).toBeUndefined();
  });

  it('rejects a directory that is not a WebGAL template', async () => {
    const root = await makeRoot('aeonstagery-webgal-invalid-');
    const emptyRoot = path.join(root, 'not-a-template');
    await mkdir(emptyRoot, { recursive: true });

    await expect(inspectWebGalTemplateDirectory({
      templateRoot: emptyRoot,
      templatesRoot: path.join(root, 'library'),
    })).rejects.toThrow(/textbox\.scss/);
  });

  it('accepts the stylesheet path itself', async () => {
    const root = await makeRoot('aeonstagery-webgal-file-path-');
    const templateRoot = path.join(root, 'template');
    await writeTemplate(templateRoot);

    const inspection = await inspectWebGalTemplateDirectory({
      templateRoot: path.join(templateRoot, 'Stage', 'TextBox', 'textbox.scss'),
      templatesRoot: path.join(root, 'library'),
    });
    expect(inspection.templateRoot).toBe(templateRoot);
  });
});
