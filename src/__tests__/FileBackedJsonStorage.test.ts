import { describe, expect, it, vi } from 'vitest';
import { FileBackedJsonStorage } from '../services/beta/FileBackedJsonStorage';

describe('FileBackedJsonStorage', () => {
  it('loads JSON and falls back when unreadable', async () => {
    const readFile = vi.fn(async () => '{"completed":true}');
    const storage = new FileBackedJsonStorage({ readFile, writeFile: vi.fn(), ensureDir: vi.fn(), dirname: () => '/user-data' }, '/user-data/tutorial.json');
    await expect(storage.load({ completed: false })).resolves.toEqual({ completed: true });
    readFile.mockRejectedValueOnce(new Error('missing'));
    await expect(storage.load({ completed: false })).resolves.toEqual({ completed: false });
  });

  it('creates the parent directory before writing', async () => {
    const calls: string[] = [];
    const storage = new FileBackedJsonStorage({ readFile: vi.fn(), writeFile: vi.fn(async (_p, v) => { calls.push(v); }), ensureDir: vi.fn(async p => { calls.push(`dir:${p}`); }), dirname: () => '/user-data' }, '/user-data/tutorial.json');
    await storage.save({ completed: true });
    expect(calls).toEqual(['dir:/user-data', '{"completed":true}']);
  });
});
