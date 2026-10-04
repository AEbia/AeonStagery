import { describe, expect, it, vi } from 'vitest';
import type { FileReplacementOperations } from '../../electron/file-replacement';
import { replaceFileWithPlatformCompatibility } from '../../electron/file-replacement';

describe('replaceFileWithPlatformCompatibility', () => {
  it('uses rename directly on platforms where replacement rename is supported', async () => {
    const operations = createOperations();

    await replaceFileWithPlatformCompatibility('draft.tmp', 'draft.json', {
      platform: 'linux',
      operations,
    });

    expect(operations.rename).toHaveBeenCalledWith('draft.tmp', 'draft.json');
    expect(operations.copyFile).not.toHaveBeenCalled();
    expect(operations.rm).not.toHaveBeenCalled();
  });

  it('overwrites an existing destination when Windows rejects rename with EPERM', async () => {
    const operations = createOperations();
    operations.rename.mockRejectedValueOnce(Object.assign(new Error('destination exists'), { code: 'EPERM' }));

    await replaceFileWithPlatformCompatibility('draft.tmp', 'draft.json', {
      platform: 'win32',
      operations,
    });

    expect(operations.copyFile).toHaveBeenCalledWith('draft.tmp', 'draft.json');
    expect(operations.rm).toHaveBeenCalledWith('draft.tmp', { force: true });
  });

  it('overwrites an existing destination when Windows rejects rename with EBUSY, EACCES, or EEXIST', async () => {
    for (const code of ['EBUSY', 'EACCES', 'EEXIST']) {
      const operations = createOperations();
      operations.rename.mockRejectedValueOnce(Object.assign(new Error('file locked'), { code }));

      await replaceFileWithPlatformCompatibility('draft.tmp', 'draft.json', {
        platform: 'win32',
        operations,
      });

      expect(operations.copyFile).toHaveBeenCalledWith('draft.tmp', 'draft.json');
      expect(operations.rm).toHaveBeenCalledWith('draft.tmp', { force: true });
    }
  });

  it('does not mask unrelated rename failures', async () => {
    const operations = createOperations();
    const failure = Object.assign(new Error('source missing'), { code: 'ENOENT' });
    operations.rename.mockRejectedValueOnce(failure);

    await expect(replaceFileWithPlatformCompatibility('draft.tmp', 'draft.json', {
      platform: 'win32',
      operations,
    })).rejects.toBe(failure);
    expect(operations.copyFile).not.toHaveBeenCalled();
  });
});

function createOperations() {
  return {
    rename: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  } as unknown as FileReplacementOperations & {
    rename: ReturnType<typeof vi.fn>;
    copyFile: ReturnType<typeof vi.fn>;
    rm: ReturnType<typeof vi.fn>;
  };
}
