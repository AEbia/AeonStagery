import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installWebGalTemplatePackage,
  inspectWebGalTemplateDirectory,
} from '../../electron/webgal-scss-import';
import { WEBGAL_IMPORT_RECORD_FILE } from '../services/import/webgal/WebGalScssPackageNaming';
import { parseTemplatePackageManifest } from '../services/template-package/TemplatePackageManifest';

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

/**
 * A hand-made package publishing two dialogue styles, as a third-party or
 * hand-authored template does. It has no import record, so it can only be
 * recognised by its parameters.
 */
async function writeMultiStylePackage(templatesRoot: string): Promise<{ packageId: string; dir: string }> {
  const packageId = 'user.multi-style';
  const dir = path.join(templatesRoot, packageId);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  const params = (x: number) => ({ renderer: 'image-dialogue-v1', textbox: { x, width: 100 } });
  await writeFile(
    path.join(dir, 'manifest.v2.json'),
    JSON.stringify({
      template: { id: packageId, name: 'Multi Style Pack', version: '1.0.0' },
      dialogueStyles: [
        { id: 'multi-a', name: 'A', params: params(90) },
        { id: 'multi-b', name: 'B', params: params(120) },
      ],
    }),
    'utf8',
  );
  await writeFile(path.join(dir, 'assets', 'extra.svg'), '<svg viewBox="0 0 1 1"/>', 'utf8');
  return { packageId, dir };
}

async function listPackageDirectories(templatesRoot: string): Promise<string[]> {
  const entries = await readdir(templatesRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
}

describe('WebGAL SCSS template import', () => {
  it('replaces the old recorded artwork after only the decoration changes', async () => {
    const root = await makeRoot('aeonstagery-webgal-artwork-replace-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    const artworkRoot = path.join(first.installPath, 'assets', 'ui', 'dialogue', 'webgal');
    const oldFiles = await readdir(artworkRoot);

    await writeFile(path.join(templateRoot, 'assets', 'textbox-meteor.svg'),
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#0ff"/></svg>');
    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(inspection.conflicts[0]).toMatchObject({ packageId: first.id, replaceable: true });
    const replaced = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: first.id,
    });
    expect(replaced.replaced).toBe(true);
    const newFiles = await readdir(artworkRoot);
    expect(newFiles).toHaveLength(oldFiles.length);
    expect(newFiles).not.toEqual(oldFiles);
    expect(await readFile(path.join(artworkRoot, newFiles.find((file) => file.startsWith('textbox-'))!), 'utf8'))
      .toContain('#0ff');
    for (const obsolete of oldFiles.filter((file) => !newFiles.includes(file))) {
      await expect(stat(path.join(artworkRoot, obsolete))).rejects.toThrow();
    }
  });

  it.each(['inspection', 'installation'])('rejects font symlinks outside the template during %s', async (operation) => {
    const root = await makeRoot('aeonstagery-webgal-font-symlink-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const fontPath = path.join(templateRoot, 'assets', 'FixtureSans.ttf');
    const outside = path.join(root, 'private.ttf');
    await writeFile(outside, 'outside-template-content');
    await rm(fontPath);
    await symlink(outside, fontPath);

    const importTemplate = operation === 'inspection'
      ? inspectWebGalTemplateDirectory : installWebGalTemplatePackage;
    await expect(importTemplate({ templateRoot, templatesRoot }))
      .rejects.toThrow(/目录/);
    await expect(stat(templatesRoot)).rejects.toThrow();
  });

  it('replaces an old recorded font when the newly imported font has another file name', async () => {
    const root = await makeRoot('aeonstagery-webgal-font-replace-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    await rename(path.join(templateRoot, 'assets', 'FixtureSans.ttf'), path.join(templateRoot, 'assets', 'NewSans.ttf'));
    await writeFile(path.join(templateRoot, 'template.json'), JSON.stringify({
      name: 'Fixture Theme',
      fonts: [{ 'font-family': 'Fixture Sans', url: 'assets/NewSans.ttf' }],
    }));
    const replaced = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: first.id,
    });
    expect(replaced.replaced).toBe(true);
    expect(await readdir(path.join(replaced.installPath, 'assets', 'fonts'))).toEqual(['NewSans.ttf']);
    expect(await readFile(path.join(replaced.installPath, 'assets', 'fonts', 'NewSans.ttf'), 'utf8'))
      .toBe(FONT_BYTES);
  });

  it('allows font symlinks inside a template reached through a symlink', async () => {
    const root = await makeRoot('aeonstagery-webgal-font-internal-symlink-');
    const templateRoot = path.join(root, 'template');
    await writeTemplate(templateRoot);
    const fontPath = path.join(templateRoot, 'assets', 'FixtureSans.ttf');
    await rename(fontPath, path.join(templateRoot, 'assets', 'actual.ttf'));
    await symlink('actual.ttf', fontPath);
    const alias = path.join(root, 'template-alias');
    await symlink(templateRoot, alias, 'dir');
    const installed = await installWebGalTemplatePackage({
      templateRoot: alias, templatesRoot: path.join(root, 'library'),
    });
    expect(await readFile(path.join(installed.installPath, 'assets', 'fonts', 'FixtureSans.ttf'), 'utf8'))
      .toBe(FONT_BYTES);
  });

  it('isolates malformed existing manifests while inspecting and installing a valid template', async () => {
    const root = await makeRoot('aeonstagery-webgal-malformed-manifest-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    const invalidManifests: unknown[] = [
      { template: { id: 'broken' }, dialogueStyles: {} },
      { template: { id: 'broken' }, dialogueStyles: [null] },
      null, [], 'invalid',
    ];
    for (const [index, manifest] of invalidManifests.entries()) {
      const dir = path.join(templatesRoot, `broken-${index}`);
      await mkdir(dir);
      await writeFile(path.join(dir, 'manifest.v2.json'), JSON.stringify(manifest));
    }

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(inspection.conflicts).toHaveLength(1);
    expect(inspection.conflicts[0].packageId).toBe(first.id);
    const installed = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    expect(installed.id).toBe(`${first.id}-2`);
    const replaced = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: first.id,
    });
    expect(replaced.replaced).toBe(true);
    expect(JSON.parse(await readFile(path.join(templatesRoot, 'broken-0', 'manifest.v2.json'), 'utf8')))
      .toEqual(invalidManifests[0]);
  });

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

  it('does not count bundled dialogue styles as old imports without a source record', async () => {
    const root = await makeRoot('aeonstagery-webgal-builtin-unverifiable-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    const bundledManifest = JSON.parse(await readFile(
      path.join(process.cwd(), 'src', 'templates', 'default', 'manifest.v2.json'),
      'utf8',
    )) as { dialogueStyles: Array<{ id: string; renderer: string }> };
    expect(bundledManifest.dialogueStyles
      .filter((style) => style.renderer === 'image-dialogue-v1')
      .map((style) => style.id)).toEqual(['pink-nameplate', 'immersive-subtitle', 'blue-line-subtitle']);
    const bundledPackageRoot = path.join(templatesRoot, 'aeonstagery.default');
    await mkdir(bundledPackageRoot, { recursive: true });
    await writeFile(
      path.join(bundledPackageRoot, 'manifest.v2.json'),
      JSON.stringify(bundledManifest),
      'utf8',
    );

    // First import: the bundled styles are the only installed package.
    const firstInspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(firstInspection.unverifiableCount).toBe(0);
    expect(firstInspection.conflicts).toEqual([]);
    expect(await listPackageDirectories(templatesRoot)).toEqual(['aeonstagery.default']);

    const legacyImport = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    await rm(path.join(legacyImport.installPath, WEBGAL_IMPORT_RECORD_FILE));

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });

    expect(inspection.unverifiableCount).toBe(1);
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

  it('refuses to replace a package that publishes more than one style', async () => {
    const root = await makeRoot('aeonstagery-webgal-multistyle-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);

    // Learn what this template converts to, then hand-build a package whose
    // *first* style matches it — the only signal available for a package that
    // predates source recording — while a second style depends on its own asset.
    const imported = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    const source = JSON.parse(
      await readFile(path.join(templatesRoot, imported.id, 'manifest.v2.json'), 'utf8'),
    ) as { dialogueStyles: { id: string; params: unknown }[] };
    await rm(path.join(templatesRoot, imported.id), { recursive: true, force: true });
    const multi = await writeMultiStylePackage(templatesRoot);
    await writeFile(
      path.join(multi.dir, 'manifest.v2.json'),
      JSON.stringify({
        template: { id: multi.packageId, name: 'Multi Style Pack', version: '1.0.0' },
        dialogueStyles: [
          { id: 'multi-a', name: 'A', params: source.dialogueStyles[0].params },
          { id: 'multi-b', name: 'B', params: { renderer: 'image-dialogue-v1', textbox: { x: 120, width: 100 } } },
        ],
      }),
      'utf8',
    );

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(inspection.conflicts).toHaveLength(1);
    expect(inspection.conflicts[0]).toMatchObject({ packageId: multi.packageId, replaceable: false });

    // Replacing would rewrite the manifest with this import's single style and
    // drop the second one plus the asset only it uses.
    await expect(installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: multi.packageId,
    })).rejects.toThrow(/个对话框样式，覆盖只会写入/);

    const manifest = JSON.parse(
      await readFile(path.join(multi.dir, 'manifest.v2.json'), 'utf8'),
    ) as { dialogueStyles: { id: string }[] };
    expect(manifest.dialogueStyles.map((style) => style.id)).toEqual(['multi-a', 'multi-b']);
    await expect(stat(path.join(multi.dir, 'assets', 'extra.svg'))).resolves.toBeTruthy();
  });

  it('refuses to replace a package that declares other capabilities', async () => {
    const root = await makeRoot('aeonstagery-webgal-capabilities-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const imported = await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    const source = JSON.parse(
      await readFile(path.join(templatesRoot, imported.id, 'manifest.v2.json'), 'utf8'),
    ) as { dialogueStyles: { params: unknown }[] };
    await rm(path.join(templatesRoot, imported.id), { recursive: true, force: true });

    // One dialogue style — which the style-count check accepts — plus a camera
    // preset the import cannot reproduce.
    const dir = path.join(templatesRoot, 'user.capabilities');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'manifest.v2.json'), JSON.stringify({
      template: { id: 'user.capabilities', name: 'Capability Pack', version: '1.0.0' },
      dialogueStyles: [{ id: 'cap-a', name: 'A', params: source.dialogueStyles[0].params }],
      cameraPresets: [{ id: 'cam-1', name: 'Wide' }],
    }), 'utf8');
    await writeFile(path.join(dir, 'assets', 'extra.svg'), '<svg viewBox="0 0 1 1"/>', 'utf8');

    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });
    expect(inspection.conflicts.find((item) => item.packageId === 'user.capabilities')?.replaceable)
      .toBe(false);

    await expect(installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: 'user.capabilities',
    })).rejects.toThrow(/样式|文件|预设/);

    // The whole point: nothing was lost.
    const after = JSON.parse(
      await readFile(path.join(dir, 'manifest.v2.json'), 'utf8'),
    ) as { dialogueStyles: { id: string }[]; cameraPresets: unknown[] };
    expect(after.dialogueStyles.map((style) => style.id)).toEqual(['cap-a']);
    expect(after.cameraPresets).toHaveLength(1);
    await expect(stat(path.join(dir, 'assets', 'extra.svg'))).resolves.toBeTruthy();
  });

  it('refuses to replace a package that holds files the import cannot rebuild', async () => {
    const root = await makeRoot('aeonstagery-webgal-stray-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const imported = await installWebGalTemplatePackage({ templateRoot, templatesRoot });

    // The manifest declares nothing extra, so the capability check passes; the
    // file on disk is what makes the replace destructive.
    await writeFile(path.join(templatesRoot, imported.id, 'assets', 'hand-made.svg'), '<svg/>', 'utf8');

    await expect(installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: imported.id,
    })).rejects.toThrow(/无法重建/);
    await expect(stat(path.join(templatesRoot, imported.id, 'assets', 'hand-made.svg')))
      .resolves.toBeTruthy();
  });

  it('de-duplicates the default style id against ids other packages chose', async () => {
    const root = await makeRoot('aeonstagery-webgal-defaultstyleid-');
    const templatesRoot = path.join(root, 'library');
    const first = path.join(root, 'a');
    await writeTemplate(first, { name: 'Second' });
    const second = path.join(root, 'b');
    await writeTemplate(second, { name: 'Second' });

    // An explicit style id takes the id a later default import would use.
    const a = await installWebGalTemplatePackage({
      templateRoot: first, templatesRoot, styleId: 'webgal-scss.Second',
    });
    const b = await installWebGalTemplatePackage({ templateRoot: second, templatesRoot });

    const ids = async (id: string) => (JSON.parse(
      await readFile(path.join(templatesRoot, id, 'manifest.v2.json'), 'utf8'),
    ) as { dialogueStyles: { id: string }[] }).dialogueStyles.map((style) => style.id);

    expect(await ids(a.id)).toEqual(['webgal-scss.Second']);
    expect(await ids(b.id)).toEqual(['webgal-scss.Second-2']);
  });

  it('keeps a requested style id unique across packages', async () => {
    const root = await makeRoot('aeonstagery-webgal-styleid-dup-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot, { name: 'First' });
    const first = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, styleId: 'shared-style',
    });

    // The style list de-duplicates by style id across packages, keeping the
    // first it sees — so a second package reusing the id would install cleanly
    // and then be invisible in the dropdown.
    await writeTemplate(path.join(root, 'template2'), { name: 'Second' });
    const second = await installWebGalTemplatePackage({
      templateRoot: path.join(root, 'template2'), templatesRoot, styleId: 'shared-style',
    });
    expect(second.id).not.toBe(first.id);

    const styleIds = async (id: string) => {
      const manifest = JSON.parse(
        await readFile(path.join(templatesRoot, id, 'manifest.v2.json'), 'utf8'),
      ) as { dialogueStyles: { id: string }[] };
      return manifest.dialogueStyles.map((style) => style.id);
    };
    expect(await styleIds(first.id)).toEqual(['shared-style']);
    expect(await styleIds(second.id)).toEqual(['shared-style-2']);
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

  it('offers an edited source for replacement and keeps its package and style ids', async () => {
    const root = await makeRoot('aeonstagery-webgal-edited-');
    const templateRoot = path.join(root, 'template');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    const first = await installWebGalTemplatePackage({ templateRoot, templatesRoot, styleId: 'existing-style' });

    await writeTemplate(templateRoot, { scss: SCSS.replace('height: 300px', 'height: 320px') });
    const inspection = await inspectWebGalTemplateDirectory({ templateRoot, templatesRoot });

    expect(inspection.conflicts).toEqual([expect.objectContaining({
      packageId: first.id, sourceMatch: true, contentMatch: false, paramsMatch: false, replaceable: true,
    })]);
    const replaced = await installWebGalTemplatePackage({
      templateRoot, templatesRoot, replacePackageId: inspection.conflicts[0].packageId,
    });
    expect(replaced).toMatchObject({ id: first.id, replaced: true });
    expect(await listPackageDirectories(templatesRoot)).toEqual([first.id]);
    const manifest = parseTemplatePackageManifest(
      JSON.parse(await readFile(path.join(replaced.installPath, 'manifest.v2.json'), 'utf8')),
    );
    expect(manifest.dialogueStyles?.[0]).toMatchObject({
      id: 'existing-style', params: { textbox: { height: 123 } },
    });
  });

  it('keeps a different source with the same template name separate', async () => {
    const root = await makeRoot('aeonstagery-webgal-unrelated-');
    const templateRoot = path.join(root, 'template');
    const otherRoot = path.join(root, 'other');
    const templatesRoot = path.join(root, 'library');
    await writeTemplate(templateRoot);
    await installWebGalTemplatePackage({ templateRoot, templatesRoot });
    await writeTemplate(otherRoot, { scss: SCSS.replace('height: 300px', 'height: 320px') });
    const inspection = await inspectWebGalTemplateDirectory({ templateRoot: otherRoot, templatesRoot });
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
