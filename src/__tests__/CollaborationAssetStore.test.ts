import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollaborationAssetStore } from '../../server/collaboration/assets';

describe('CollaborationAssetStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-assets-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes and reads project-relative assets under the asset root', async () => {
    const store = new CollaborationAssetStore(tempDir);
    await store.writeAsset('background/bg.png', new TextEncoder().encode('bg-bytes'));

    expect(new TextDecoder().decode(await store.readAsset('background/bg.png'))).toBe('bg-bytes');
    expect(await store.hasAsset('background/bg.png')).toBe(true);
  });

  it('rejects asset paths that escape the asset store', () => {
    const store = new CollaborationAssetStore(tempDir);

    expect(() => store.resolveAssetPath('../outside.png')).toThrow('Invalid project-relative asset path');
  });
});
