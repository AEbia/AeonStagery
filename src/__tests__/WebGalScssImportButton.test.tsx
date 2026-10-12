/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebGalScssImportInspection } from '../api/types/template-package-import';
import { showToast } from '../ui/Toast';
import { WebGalScssImportButton } from '../ui/timeline/inspector/paramControls/WebGalScssImportButton';
import type { WebGalStyleImportActions } from '../ui/timeline/inspector/paramControls/context';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });

function makeInspection(overrides: Partial<WebGalScssImportInspection> = {}): WebGalScssImportInspection {
  return {
    templateRoot: 'D:/templates/仿番剧字幕',
    templateName: '仿番剧字幕',
    packageName: '仿番剧字幕',
    packageId: 'webgal-scss.仿番剧字幕',
    styleId: 'webgal-scss.仿番剧字幕',
    styleName: '仿番剧字幕',
    sourceName: 'textbox.scss',
    sourceHash: 'hash-a',
    paramsSignature: 'sig-a',
    conflicts: [],
    unverifiableCount: 0,
    takenPackageNames: [],
    notes: [],
    ...overrides,
  };
}

function makeImporter(overrides: Partial<WebGalStyleImportActions> = {}): WebGalStyleImportActions {
  return {
    inspect: vi.fn(async () => makeInspection()),
    install: vi.fn(async () => ({ ok: true, message: '已导入字幕样式：仿番剧字幕' })),
    ...overrides,
  };
}

describe('WebGalScssImportButton', () => {
  it('is a single labelled control next to the dropdown', () => {
    render(<WebGalScssImportButton importer={makeImporter()} />);

    expect(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' })).toBeTruthy();
    // The dialog only appears once a directory has been read.
    expect(screen.queryByText('导入 WebGAL 字幕样式')).toBeNull();
  });

  it('opens the dialog with what the host read', async () => {
    const importer = makeImporter();
    render(<WebGalScssImportButton importer={importer} />);

    fireEvent.click(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' }));

    await waitFor(() => expect(screen.getByText('导入 WebGAL 字幕样式')).toBeTruthy());
    expect(importer.inspect).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('仿番剧字幕')).toBeTruthy();
  });

  it('stays silent when the host reports a cancel', async () => {
    const importer = makeImporter({ inspect: vi.fn(async () => null) });
    render(<WebGalScssImportButton importer={importer} />);

    fireEvent.click(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' }));

    await waitFor(() => expect(importer.inspect).toHaveBeenCalled());
    expect(screen.queryByText('导入 WebGAL 字幕样式')).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('installs the inspected template and closes on success', async () => {
    const importer = makeImporter();
    render(<WebGalScssImportButton importer={importer} />);

    fireEvent.click(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' }));
    await waitFor(() => expect(screen.getByText('导入 WebGAL 字幕样式')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
    });

    expect(importer.install).toHaveBeenCalledWith({
      templateRoot: 'D:/templates/仿番剧字幕',
      packageName: '仿番剧字幕',
    });
    await waitFor(() => expect(screen.queryByText('导入 WebGAL 字幕样式')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('已导入字幕样式：仿番剧字幕', 'success');
  });

  it('passes the package to replace when overwriting', async () => {
    const importer = makeImporter({
      inspect: vi.fn(async () => makeInspection({
        conflicts: [{
          packageId: 'webgal-scss.仿番剧字幕',
          packageName: '仿番剧字幕',
          contentMatch: true,
          paramsMatch: false,
        }],
      })),
    });
    render(<WebGalScssImportButton importer={importer} />);

    fireEvent.click(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '覆盖已有' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '覆盖已有' }));
    });

    expect(importer.install).toHaveBeenCalledWith(expect.objectContaining({
      replacePackageId: 'webgal-scss.仿番剧字幕',
    }));
  });

  it('keeps the dialog open when the write fails, so the user can retry', async () => {
    const importer = makeImporter({
      install: vi.fn(async () => ({ ok: false, message: '导入失败：磁盘已满' })),
    });
    render(<WebGalScssImportButton importer={importer} />);

    fireEvent.click(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' }));
    await waitFor(() => expect(screen.getByText('导入 WebGAL 字幕样式')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '导入' }));
    });

    expect(showToast).toHaveBeenCalledWith('导入失败：磁盘已满', 'error');
    expect(screen.getByText('导入 WebGAL 字幕样式')).toBeTruthy();
  });

  it('discards the dialog on cancel without installing', async () => {
    const importer = makeImporter();
    render(<WebGalScssImportButton importer={importer} />);

    fireEvent.click(screen.getByRole('button', { name: '从 WebGAL 模板导入对话框样式' }));
    await waitFor(() => expect(screen.getByText('导入 WebGAL 字幕样式')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByText('导入 WebGAL 字幕样式')).toBeNull();
    expect(importer.install).not.toHaveBeenCalled();
  });
});
