import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.AEON_TEST_USER_DATA || '' },
  ipcMain: { handle: vi.fn() },
}));

import { deletePreset, publishTemplateProfile, readLibrary, savePreset } from '../../electron/voice-authoring';

let userData = '';

beforeEach(async () => {
  userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aeon-voice-library-'));
  process.env.AEON_TEST_USER_DATA = userData;
});

afterEach(async () => {
  delete process.env.AEON_TEST_USER_DATA;
  await fs.promises.rm(userData, { recursive: true, force: true });
});

describe('managed voice library repository', () => {
  it('copies references, stores only managed relative paths, and never deletes the source', async () => {
    const source = path.join(userData, 'original.wav');
    await fs.promises.writeFile(source, 'reference audio');
    const result = await savePreset({
      mode: 'create',
      preset: {
        id: 'tomori', name: 'Tomori',
        gptModel: { absolutePath: 'D:/models/tomori.ckpt', fileName: 'tomori.ckpt' },
        sovitsModel: { absolutePath: 'D:/models/tomori.pth', fileName: 'tomori.pth' },
        references: [{ id: 'primary', label: 'Primary', managedPath: 'pending', role: 'primary', promptText: 'hello', promptLang: 'en' }],
        inferenceDefaults: { textLang: 'en', speed: 1 },
      },
      references: [{ referenceId: 'primary', sourcePath: source }],
    });

    expect(result.success).toBe(true);
    const library = await readLibrary();
    expect(library.schemaVersion).toBe(1);
    expect(library.presets[0].references[0].managedPath).toBe('references/tomori/primary.wav');
    expect(path.isAbsolute(library.presets[0].references[0].managedPath)).toBe(false);
    expect(await fs.promises.readFile(path.join(userData, 'voice-library', 'references', 'tomori', 'primary.wav'), 'utf8')).toBe('reference audio');

    const published = await publishTemplateProfile('tomori');
    expect(published.success).toBe(true);
    const manifest = JSON.parse(await fs.promises.readFile(path.join(userData, 'templates', 'aeonstagery.user-voices', 'manifest.json'), 'utf8'));
    expect(manifest.voiceProfiles[0]).toEqual(expect.objectContaining({
      id: 'tomori',
      gptModel: { fileName: 'tomori.ckpt' },
      references: [expect.objectContaining({ assetId: 'voice.tomori.primary' })],
    }));
    expect(JSON.stringify(manifest)).not.toContain('D:/models');
    expect(await fs.promises.readFile(path.join(userData, 'templates', 'aeonstagery.user-voices', 'assets', 'voice', 'tomori', 'primary.wav'), 'utf8')).toBe('reference audio');

    const deleted = await deletePreset('tomori');
    expect(deleted.success).toBe(true);
    expect(fs.existsSync(source)).toBe(true);
  });

  it('requires confirmed prompt text before persisting a preset', async () => {
    const source = path.join(userData, 'original.wav');
    await fs.promises.writeFile(source, 'reference audio');
    const result = await savePreset({
      mode: 'create',
      preset: {
        id: 'invalid', name: 'Invalid',
        gptModel: { absolutePath: 'D:/models/a.ckpt', fileName: 'a.ckpt' },
        sovitsModel: { absolutePath: 'D:/models/a.pth', fileName: 'a.pth' },
        references: [{ id: 'primary', label: 'Primary', managedPath: 'pending', role: 'primary', promptText: '', promptLang: 'en' }],
        inferenceDefaults: { textLang: 'en', speed: 1 },
      },
      references: [{ referenceId: 'primary', sourcePath: source }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('prompt');
    expect((await readLibrary()).presets).toEqual([]);
  });
});
