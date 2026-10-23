import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportOutputTasks, assertExportDiskSpace, estimateStreamBytes } from '../../electron/export-output';

describe('export output ownership and disk space', () => {
  let directory: string;
  let root: string;
  let outputPath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'aeon-output-test-'));
    root = join(directory, 'tasks');
    outputPath = join(directory, 'final.mp4');
    await fs.writeFile(outputPath, 'original');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps the existing output until successful commit, then cleans only the task', async () => {
    const output = await new ExportOutputTasks(root).create(outputPath, {});
    await fs.writeFile(output.partialPath, 'new video');
    expect(await fs.readFile(outputPath, 'utf8')).toBe('original');
    await output.commit();
    await output.cleanup();
    expect(await fs.readFile(outputPath, 'utf8')).toBe('new video');
    expect(await fs.readdir(root)).toEqual([]);
    await expect(fs.stat(output.partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes cancelled output without touching an existing destination', async () => {
    const output = await new ExportOutputTasks(root).create(outputPath, {});
    await fs.writeFile(output.partialPath, 'incomplete');
    await output.cleanup();
    expect(await fs.readFile(outputPath, 'utf8')).toBe('original');
    expect(await fs.readdir(root)).toEqual([]);
  });

  async function markOrphan(childPid?: number) {
    const id = (await fs.readdir(root))[0];
    const manifestPath = join(root, id, 'manifest.json');
    const manifest: Record<string, unknown> = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.ownerPid = 2147483647; // A confirmed absent PID, never the test process.
    manifest.childPid = childPid;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
  }

  it('recovers dead tasks while preserving live owners and FFmpeg processes', async () => {
    const tasks = new ExportOutputTasks(root);
    const output = await tasks.create(outputPath, {});
    await fs.writeFile(output.partialPath, 'incomplete');
    await tasks.recover();
    expect(await fs.readFile(output.partialPath, 'utf8')).toBe('incomplete');
    await markOrphan(process.pid);
    await tasks.recover();
    expect(await fs.readFile(output.partialPath, 'utf8')).toBe('incomplete');
    await markOrphan();
    await tasks.recover();
    await expect(fs.stat(output.partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(outputPath, 'utf8')).toBe('original');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('retains a failed cleanup record so startup can retry', async () => {
    const tasks = new ExportOutputTasks(root);
    const output = await tasks.create(outputPath, {});
    await fs.writeFile(output.partialPath, 'incomplete');
    const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('EPERM: locked'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await output.cleanup();
    expect(log).toHaveBeenCalled();
    expect(await fs.readdir(root)).toHaveLength(1);
    remove.mockRestore();
    await markOrphan();
    await tasks.recover();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('checks available bytes before allocating a task and again during output', async () => {
    const stats = await fs.statfs(directory, { bigint: true });
    const output = await new ExportOutputTasks(root).create(outputPath, {});
    vi.spyOn(fs, 'statfs').mockResolvedValue({ ...stats, bavail: 0n });
    await expect(output.checkSpace()).rejects.toThrow('ENOSPC');
    await expect(new ExportOutputTasks(root).create(outputPath, {})).rejects.toThrow('ENOSPC');
    expect(await fs.readdir(root)).toHaveLength(1);
    await output.cleanup();
    expect(await fs.readFile(outputPath, 'utf8')).toBe('original');
  });

  it('uses the final bitrate for transcodes and does not treat CRF as a known size', async () => {
    const options = { bitrate: 112, fps: 60, totalFrames: 3600, transcode: { bitrate: 8 } };
    expect(estimateStreamBytes(options)).toBe(72000000);
    expect(estimateStreamBytes({ ...options, transcode: { crf: 24, bitrate: 8 } })).toBe(0);
    const stats = await fs.statfs(directory, { bigint: true });
    vi.spyOn(fs, 'statfs').mockResolvedValue({ ...stats, bsize: 1n, bavail: 100000000n });
    await expect(assertExportDiskSpace(directory)).resolves.toBeUndefined();
    await expect(assertExportDiskSpace(directory, estimateStreamBytes(options))).rejects.toThrow('ENOSPC');
  });
});
