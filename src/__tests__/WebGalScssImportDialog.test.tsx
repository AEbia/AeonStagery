/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WebGalScssImportInspection } from '../api/types/template-package-import';
import { WebGalScssImportDialog } from '../ui/WebGalScssImportDialog';

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
    notes: ['折算了 transform: scale(0.5)'],
    ...overrides,
  };
}

const DUPLICATE = {
  packageId: 'webgal-scss.仿番剧字幕',
  packageName: '仿番剧字幕',
  contentMatch: true,
  paramsMatch: false,
  importedAt: '2026-10-12T09:20:00.000Z',
};

describe('WebGalScssImportDialog', () => {
  it('shows where the style came from and offers the automatic name', () => {
    render(
      <WebGalScssImportDialog
        inspection={makeInspection()}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText('导入 WebGAL 字幕样式')).toBeTruthy();
    // The suggested name is offered as the placeholder, so it is never typed twice.
    expect(screen.getByPlaceholderText('仿番剧字幕')).toBeTruthy();
    expect(screen.getByText(/Stage\/TextBox\/textbox\.scss/)).toBeTruthy();
    expect(screen.getByText(/留空 = 自动命名为/)).toBeTruthy();
    // A clean import only needs the one action.
    expect(screen.getByRole('button', { name: '导入' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '覆盖已有' })).toBeNull();
  });

  it('confirms a new package with the automatic name when the field is left empty', () => {
    const onConfirm = vi.fn();
    render(
      <WebGalScssImportDialog inspection={makeInspection()} onCancel={() => {}} onConfirm={onConfirm} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    expect(onConfirm).toHaveBeenCalledWith({ mode: 'new', packageName: '仿番剧字幕' });
  });

  it('uses a typed name verbatim', () => {
    const onConfirm = vi.fn();
    render(
      <WebGalScssImportDialog inspection={makeInspection()} onCancel={() => {}} onConfirm={onConfirm} />,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '番剧字幕（正式版）' } });
    fireEvent.click(screen.getByRole('button', { name: '导入' }));

    expect(onConfirm).toHaveBeenCalledWith({ mode: 'new', packageName: '番剧字幕（正式版）' });
  });

  it('warns when the typed name is taken and shows the name it will use instead', () => {
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({ takenPackageNames: ['仿番剧字幕'] })}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/已被占用，将保存为 “仿番剧字幕-2”/)).toBeTruthy();
  });

  it('flags a duplicate import and explains why it matched', () => {
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({ conflicts: [DUPLICATE] })}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/这份字幕看起来已经导入过/)).toBeTruthy();
    expect(screen.getByText(/样式表内容与已导入的一致/)).toBeTruthy();
    expect(screen.getByText(/导入于 2026-10-12/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '覆盖已有' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '另存为新的一份' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导入' })).toBeNull();
  });

  it('confirms an overwrite against the matched package', () => {
    const onConfirm = vi.fn();
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({ conflicts: [DUPLICATE] })}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '覆盖已有' }));

    expect(onConfirm).toHaveBeenCalledWith({
      mode: 'overwrite',
      packageName: '仿番剧字幕',
      replacePackageId: 'webgal-scss.仿番剧字幕',
    });
  });

  it('can still add a second copy instead of overwriting', () => {
    const onConfirm = vi.fn();
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({ conflicts: [DUPLICATE] })}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '另存为新的一份' }));

    expect(onConfirm).toHaveBeenCalledWith({ mode: 'new', packageName: '仿番剧字幕' });
    expect(onConfirm.mock.calls[0][0].replacePackageId).toBeUndefined();
  });

  it('lets the user pick which package to replace when several match', () => {
    const onConfirm = vi.fn();
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({
          conflicts: [
            DUPLICATE,
            { ...DUPLICATE, packageId: 'webgal-scss.仿番剧字幕-2', packageName: '仿番剧字幕-2', contentMatch: false, paramsMatch: true },
          ],
        })}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'webgal-scss.仿番剧字幕-2' } });
    fireEvent.click(screen.getByRole('button', { name: '覆盖已有' }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'overwrite',
      replacePackageId: 'webgal-scss.仿番剧字幕-2',
    }));
  });

  it('admits when older imports could not be compared', () => {
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({ unverifiableCount: 2 })}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByText(/另有 2 个较早导入的模板没有来源记录/)).toBeTruthy();
  });

  it('cancels from the footer and the close button', () => {
    const onCancel = vi.fn();
    const { unmount } = render(
      <WebGalScssImportDialog inspection={makeInspection()} onCancel={onCancel} onConfirm={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    const second = vi.fn();
    render(
      <WebGalScssImportDialog inspection={makeInspection()} onCancel={second} onConfirm={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('disables the actions while the import is running', () => {
    render(
      <WebGalScssImportDialog
        inspection={makeInspection({ conflicts: [DUPLICATE] })}
        busy
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: '正在导入…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '另存为新的一份' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);
  });
});
