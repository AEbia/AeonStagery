import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { FFmpegStreamOptions } from '../src/api/types/export';

export const EXPORT_DISK_RESERVE_BYTES = 64 * 1024 * 1024;

/** Only bitrate-controlled output has a useful advance size estimate. */
export function estimateStreamBytes(options: FFmpegStreamOptions): number {
  const video = options.transcode ?? options;
  if (video.crf !== undefined || !video.bitrate || !options.totalFrames || !options.fps) return 0;
  const audioMbps = options.audioSources?.length ? 0.192 : 0;
  const estimate = (video.bitrate + audioMbps) * 125000 * options.totalFrames / options.fps;
  return Number.isFinite(estimate) && estimate > 0 ? Math.ceil(estimate * 1.2) : 0;
}

export async function assertExportDiskSpace(directory: string, estimatedBytes = 0): Promise<void> {
  const stats = await fs.statfs(directory, { bigint: true });
  const available = stats.bavail * stats.bsize;
  const required = BigInt(EXPORT_DISK_RESERVE_BYTES) + BigInt(Math.ceil(estimatedBytes));
  if (available < required) {
    throw new Error(`ENOSPC: 导出磁盘空间不足，目录 ${directory}，可用 ${Number(available / 1048576n)} MiB，需要至少 ${Number(required / 1048576n)} MiB（含安全余量）。`);
  }
}

interface OutputManifest {
  version: 1;
  ownerPid: number;
  childPid?: number;
  outputPath: string;
  partialPath: string;
  id: string;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
}

function isManifest(value: unknown): value is OutputManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<OutputManifest>;
  if (m.version !== 1 || !Number.isInteger(m.ownerPid) || (m.ownerPid ?? 0) <= 0
    || (m.childPid !== undefined && (!Number.isInteger(m.childPid) || m.childPid <= 0))
    || typeof m.id !== 'string' || !/^[\da-f-]{36}$/.test(m.id)
    || typeof m.outputPath !== 'string' || !path.isAbsolute(m.outputPath)
    || typeof m.partialPath !== 'string') return false;
  return m.partialPath === partialPathFor(m.outputPath, m.id);
}

function partialPathFor(outputPath: string, id: string): string {
  return path.join(path.dirname(outputPath), `.aeonstagery-export-${id}.partial${path.extname(outputPath)}`);
}

/** Main-process ownership records survive renderer crashes and application restarts. */
export class ExportOutputTasks {
  constructor(private readonly root = path.join(tmpdir(), 'aeonstagery-export', 'tasks')) {}

  async recover(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[\da-f-]{36}$/.test(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      try {
        const value: unknown = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (!isManifest(value) || value.id !== entry.name) continue;
        if (isProcessAlive(value.ownerPid) || (value.childPid && isProcessAlive(value.childPid))) continue;
        await fs.rm(value.partialPath, { force: true });
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        // Keep the ownership record if removal fails; retry on the next startup.
        console.error('[Export] Orphan cleanup failed:', directory, error);
      }
    }
  }

  async create(outputPath: string, options: FFmpegStreamOptions): Promise<ExportOutput> {
    const absoluteOutput = path.resolve(outputPath);
    await assertExportDiskSpace(path.dirname(absoluteOutput), estimateStreamBytes(options));
    await fs.mkdir(this.root, { recursive: true });
    await assertExportDiskSpace(this.root, 0);
    const id = randomUUID();
    const directory = path.join(this.root, id);
    await fs.mkdir(directory);
    const manifest: OutputManifest = {
      version: 1, id, ownerPid: process.pid, outputPath: absoluteOutput,
      partialPath: partialPathFor(absoluteOutput, id),
    };
    const output = new ExportOutput(directory, manifest);
    try { await output.recordChild(); }
    catch (error) { await output.cleanup(); throw error; }
    return output;
  }
}

export class ExportOutput {
  private committed = false;
  private cleanupPromise?: Promise<void>;
  constructor(private readonly directory: string, private readonly manifest: OutputManifest) {}

  get partialPath(): string { return this.manifest.partialPath; }

  async recordChild(pid?: number): Promise<void> {
    if (pid !== undefined) this.manifest.childPid = pid;
    const pending = path.join(this.directory, 'manifest.pending');
    await fs.writeFile(pending, JSON.stringify(this.manifest), { flag: 'w' });
    await fs.rename(pending, path.join(this.directory, 'manifest.json'));
  }

  async checkSpace(): Promise<void> {
    await assertExportDiskSpace(path.dirname(this.partialPath));
  }

  async commit(): Promise<void> {
    await fs.rename(this.partialPath, this.manifest.outputPath);
    this.committed = true;
  }

  cleanup(): Promise<void> {
    return this.cleanupPromise ??= this.removeFiles();
  }

  private async removeFiles(): Promise<void> {
    try {
      if (!this.committed) await fs.rm(this.partialPath, { force: true });
      await fs.rm(this.directory, { recursive: true, force: true });
    } catch (error) {
      console.error('[Export] Task cleanup failed:', this.directory, error);
    }
  }
}
