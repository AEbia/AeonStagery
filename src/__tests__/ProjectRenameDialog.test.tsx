/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectRenameDialog } from '../ui/ProjectRenameDialog';

describe('ProjectRenameDialog', () => {
  it('selects the existing name, rejects whitespace, and submits a trimmed name', async () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ProjectRenameDialog name="Demo" onSave={onSave} onClose={onClose} />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '项目名称' });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true);
    fireEvent.submit(input.closest('form')!);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '  新名称  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith('新名称');
  });

  it('keeps the draft and shows an error when saving fails, allowing a retry', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('磁盘只读')).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<ProjectRenameDialog name="Demo" onSave={onSave} onClose={onClose} />);
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('磁盘只读');
    expect(input.value).toBe('Renamed');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('blocks duplicate saves and closing while a write is pending', async () => {
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const onClose = vi.fn();
    render(<ProjectRenameDialog name="Demo" onSave={onSave} onClose={onClose} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.submit(input.closest('form')!);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true);
    resolveSave();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('cancels with Escape without saving', () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ProjectRenameDialog name="Demo" onSave={onSave} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });
});
