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
  it.each(['/etc/passwd', 'C:/outside.txt', 'background/file:stream', 'background/../outside.txt', 'NUL.png', 'background/file.'])('rejects unsafe path %s', (input) => {
    const store = new CollaborationAssetStore(tempDir);
    expect(() => store.resolveAssetPath(input)).toThrow('Invalid project-relative asset path');
  });

  it('blocks directory symlinks for reads, existence checks, and writes', async () => {
    const store = new CollaborationAssetStore(tempDir);
    await store.ensure();
    const outside = path.join(tempDir, 'private');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    await fs.symlink(outside, path.join(store.rootDir, 'redirect'), 'junction');
    expect(await store.hasAsset('redirect/secret.txt')).toBe(false);
    await expect(store.readAsset('redirect/secret.txt')).rejects.toThrow();
    await expect(store.writeAsset('redirect/secret.txt', new Uint8Array([1]))).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('private');
  });

  it('rejects file symlink reads and replaces the link without modifying its target', async () => {
    const store = new CollaborationAssetStore(tempDir);
    await store.ensure();
    const outside = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outside, 'private');
    await fs.symlink(outside, path.join(store.rootDir, 'redirect.txt'));
    await expect(store.readAsset('redirect.txt')).rejects.toThrow();
    expect(await store.hasAsset('redirect.txt')).toBe(false);
    await store.writeAsset('redirect.txt', new TextEncoder().encode('shared'));
    expect(await fs.readFile(outside, 'utf8')).toBe('private');
    expect(await store.readAsset('redirect.txt')).toEqual(Buffer.from('shared'));
  });

  it('rejects a symlink asset root', async () => {
    const outside = path.join(tempDir, 'private');
    await fs.mkdir(outside);
    const store = new CollaborationAssetStore(tempDir);
    await fs.symlink(outside, store.rootDir, 'junction');
    await expect(store.ensure()).rejects.toThrow();
  });

  it('does not expose hardlinked local files', async () => {
    const store = new CollaborationAssetStore(tempDir);
    await store.ensure();
    const outside = path.join(tempDir, 'secret.txt');
    await fs.writeFile(outside, 'private');
    await fs.link(outside, path.join(store.rootDir, 'redirect.txt'));
    expect(await store.hasAsset('redirect.txt')).toBe(false);
    await expect(store.readAsset('redirect.txt')).rejects.toThrow();
  });

});
