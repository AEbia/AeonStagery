import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanVoiceCatalog } from '../../electron/voice-authoring';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('voice catalog discovery', () => {
  it('only auto-discovers standard GPT root weights and never scans presets metadata', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aeon-voice-catalog-'));
    roots.push(root);
    await fs.promises.mkdir(path.join(root, 'GPT_weights_v2'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'SoVITS_weights'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'presets', 'plugin'), { recursive: true });
    await fs.promises.mkdir(path.join(root, 'pretrained_models'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'GPT_weights_v2', 'voice.ckpt'), 'gpt');
    await fs.promises.writeFile(path.join(root, 'SoVITS_weights', 'voice.pth'), 'sovits');
    await fs.promises.writeFile(path.join(root, 'presets', 'metadata.json'), '{ invalid third party metadata');
    await fs.promises.writeFile(path.join(root, 'presets', 'plugin', 'hidden.wav'), 'audio');
    await fs.promises.writeFile(path.join(root, 'pretrained_models', 'base.ckpt'), 'base');

    const result = await scanVoiceCatalog({ gptRoot: root });

    expect(result.models.map((model) => model.fileName)).toEqual(['voice.ckpt', 'voice.pth']);
    expect(result.references).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('treats an explicitly configured third-party preset folder as raw audio without transcript metadata', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aeon-voice-reference-'));
    roots.push(root);
    await fs.promises.mkdir(path.join(root, 'character-a'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'metadata.json'), JSON.stringify({ transcript: 'must not be read' }));
    await fs.promises.writeFile(path.join(root, 'character-a', 'reference.wav'), 'audio');

    const result = await scanVoiceCatalog({ gptRoot: '', referenceRoots: [root] });

    expect(result.references).toEqual([expect.objectContaining({
      fileName: 'reference.wav', transcriptTrusted: false, pathTags: ['character-a'],
    })]);
  });
});
