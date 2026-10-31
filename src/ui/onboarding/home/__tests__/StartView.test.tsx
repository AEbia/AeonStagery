/** @vitest-environment jsdom */
import { type ComponentProps, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StartView } from '../StartView';

type Props = ComponentProps<typeof StartView>;
function StartHarness(props: Props) {
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null);
  return <StartView {...props} openingRecentPath={openingRecentPath} onOpenRecentProject={async (path) => {
    setOpeningRecentPath(path);
    try { await props.onOpenRecentProject(path); }
    finally { setOpeningRecentPath(null); }
  }} />;
}
const projects = ['First', 'Second', 'Third'].map((name) => ({
  name,
  projectFilePath: `D:/projects/${name}/project.json`,
  rootPath: `D:/projects/${name}`,
  lastOpenedAt: '2026-10-01T00:00:00.000Z',
}));

function renderStart(overrides: Partial<Props> = {}) {
  const props: Props = {
    recentProjects: projects,
    openingRecentPath: null,
    onOpenRecentProject: vi.fn(),
    onRenameRecentProject: vi.fn(),
    onRemoveRecentProject: vi.fn(),
    onImportTemplatePackage: vi.fn(),
    onStartTutorial: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<StartHarness {...props} />) };
}

describe('project storyboard selection', () => {
  it('opens a central card on click, while a side card only selects, and allows retry after an unsuccessful open', async () => {
    const { props } = renderStart();
    const second = screen.getByRole('tab', { name: '选择项目：Second' });
    fireEvent.click(second);
    expect(props.onOpenRecentProject).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(props.onOpenRecentProject).toHaveBeenCalledExactlyOnceWith(projects[1].projectFilePath);
    await waitFor(() => expect(second.hasAttribute('disabled')).toBe(false));
    fireEvent.click(second);
    await waitFor(() => expect(props.onOpenRecentProject).toHaveBeenCalledTimes(2));
  });

  it('opens the selected project from body Enter and locks selection until opening completes', async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { props } = renderStart({ onOpenRecentProject: vi.fn(() => pending) });
    fireEvent.click(screen.getByRole('tab', { name: '选择项目：Second' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Second');
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onOpenRecentProject).toHaveBeenCalledExactlyOnceWith(projects[1].projectFilePath);
    expect(screen.getByRole('tab', { name: '选择项目：Third' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: '选择项目：Third' }));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onOpenRecentProject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Second');
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: '继续制作：Second' }).hasAttribute('disabled')).toBe(false));
  });

  it('retains selection by project path through rename and reorder, then falls back when removed', async () => {
    const { props, rerender } = renderStart();
    fireEvent.click(screen.getByRole('tab', { name: '选择项目：Second' }));
    rerender(<StartHarness {...props} recentProjects={[{ ...projects[1], name: 'Renamed' }, projects[2], projects[0]]} />);
    expect(screen.getByRole('tab', { name: '选择项目：Renamed' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed');
    rerender(<StartHarness {...props} recentProjects={[projects[2], projects[0]]} />);
    expect(screen.getByRole('tab', { name: '选择项目：Third' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '继续制作：Third' }));
    await waitFor(() => expect(props.onOpenRecentProject).toHaveBeenCalledExactlyOnceWith(projects[2].projectFilePath));
  });

  it('supports keyboard focus across the deck and creates from the final card without opening a recent project', () => {
    const { props } = renderStart();
    const first = screen.getByRole('tab', { name: '选择项目：First' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const second = screen.getByRole('tab', { name: '选择项目：Second' });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(second, { key: 'ArrowRight', ctrlKey: true });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'End' });
    const create = screen.getByRole('tab', { name: '选择新建项目' });
    expect(document.activeElement).toBe(create);
    expect(create.getAttribute('aria-selected')).toBe('true');
    create.blur();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(props.onOpenRecentProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '创建新项目' }));
    expect(props.onCreate).toHaveBeenCalledOnce();
    fireEvent.keyDown(create, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute('aria-selected')).toBe('true');
  });
});
