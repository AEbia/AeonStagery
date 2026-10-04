import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectTemplatePackageArchive,
  installTemplatePackageArchive,
  TemplatePackageAlreadyInstalledError,
  validateTemplateArchiveEntryPath,
} from '../../electron/template-package-import';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('template package ZIP import', () => {
  it('installs into the app-owned templates directory and requires confirmation before replacement', async () => {
    const root = await makeTemporaryRoot();
    const archivePath = path.join(root, 'template.zip');
    await writeStoredZip(archivePath, {
      'Aeonstagery-Test-Template/manifest.v2.json': JSON.stringify(makeManifest('1.0.0')),
      'Aeonstagery-Test-Template/assets/example.txt': 'first version',
    });

    const firstInspection = await inspectTemplatePackageArchive(archivePath);
    const installed = await installTemplatePackageArchive(firstInspection, root, false);

    expect(installed).toMatchObject({
      id: 'aeonstagery.test-template',
      name: 'Test Template',
      version: '1.0.0',
      replaced: false,
    });
    expect(await readFile(path.join(
      root,
      'templates',
      'aeonstagery.test-template',
      'assets',
      'example.txt',
    ), 'utf8')).toBe('first version');

    const conflictInspection = await inspectTemplatePackageArchive(archivePath);
    await expect(installTemplatePackageArchive(conflictInspection, root, false))
      .rejects.toBeInstanceOf(TemplatePackageAlreadyInstalledError);

    await writeStoredZip(archivePath, {
      'manifest.v2.json': JSON.stringify(makeManifest('1.1.0')),
      'assets/example.txt': 'replacement version',
    });
    const replacementInspection = await inspectTemplatePackageArchive(archivePath);
    const replaced = await installTemplatePackageArchive(replacementInspection, root, true);

    expect(replaced).toMatchObject({ version: '1.1.0', replaced: true });
    expect(await readFile(path.join(
      root,
      'templates',
      'aeonstagery.test-template',
      'assets',
      'example.txt',
    ), 'utf8')).toBe('replacement version');
  });

  it('rejects traversal, absolute, Windows, and NUL archive paths', () => {
    for (const unsafePath of ['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'folder\\file.txt', 'bad\0name']) {
      expect(() => validateTemplateArchiveEntryPath(unsafePath)).toThrow();
    }
    expect(validateTemplateArchiveEntryPath('Template/assets/file.txt')).toBe('Template/assets/file.txt');
  });

  it('rejects archives containing more than one template manifest', async () => {
    const root = await makeTemporaryRoot();
    const archivePath = path.join(root, 'multiple.zip');
    await writeStoredZip(archivePath, {
      'One/manifest.v2.json': JSON.stringify(makeManifest('1.0.0')),
      'Two/manifest.v2.json': JSON.stringify(makeManifest('1.0.0')),
    });

    await expect(inspectTemplatePackageArchive(archivePath)).rejects.toThrow('必须且只能包含一个');
  });

  it('rejects installation when the manifest references a missing model', async () => {
    const root = await makeTemporaryRoot();
    const archivePath = path.join(root, 'missing-model.zip');
    await writeStoredZip(archivePath, {
      'manifest.v2.json': JSON.stringify({
        ...makeManifest('1.0.0'),
        characterPresets: [{
          id: 'lead',
          name: 'Lead',
          model: 'assets/live2d/lead/model.json',
        }],
      }),
    });

    const inspection = await inspectTemplatePackageArchive(archivePath);
    await expect(installTemplatePackageArchive(inspection, root, false))
      .rejects.toThrow('引用的文件不存在');
  });
});

function makeManifest(version: string) {
  return {
    manifestSchemaVersion: 2,
    template: {
      id: 'aeonstagery.test-template',
      name: 'Test Template',
      version,
      compatibility: { sceneSchemaVersion: 4 },
    },
  };
}

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aeonstagery-template-import-'));
  temporaryRoots.push(root);
  return root;
}

async function writeStoredZip(archivePath: string, files: Record<string, string>): Promise<void> {
  const archive = new JSZip();
  for (const [fileName, content] of Object.entries(files)) {
    archive.file(fileName, content);
  }
  await writeFile(archivePath, await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
}
