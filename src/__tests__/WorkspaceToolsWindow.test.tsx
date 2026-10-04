/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceToolsCommand,
  WorkspaceToolsCommandResult,
  WorkspaceToolsSnapshot,
} from '../ui/workspace-tools/types';

vi.mock('../ui/monaco/monacoRuntime', async () => {
  const React = await import('react');
  const monacoApi = {
    KeyMod: { CtrlCmd: 1, Shift: 2 },
    KeyCode: { KeyS: 3, KeyF: 4 },
    editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
  };

  return {
    applyAeonStageryMonacoTheme: vi.fn(),
    MONACO_JSON_EDITOR_OPTIONS: {},
    loadMonacoRuntime: vi.fn(async () => ({
      Editor: ({
        value,
        onChange,
        onMount,
      }: {
        value: string;
        onChange: (value: string) => void;
        onMount: (editor: unknown, api: unknown) => void;
      }) => {
        const editor = React.useMemo(() => ({
          addCommand: vi.fn(),
          getAction: vi.fn(() => ({ run: vi.fn() })),
        }), []);
        React.useEffect(() => {
          onMount(editor, monacoApi);
        }, [editor, onMount]);
        return React.createElement('textarea', {
          'aria-label': 'JSON editor',
          value,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
        });
      },
    })),
  };
});

import { WorkspaceToolsWindow } from '../WorkspaceToolsWindow';

type SnapshotListener = (snapshot: WorkspaceToolsSnapshot) => void;
type ResultListener = (result: WorkspaceToolsCommandResult) => void;

function createSnapshot(
  sceneId: string,
  activeTab: WorkspaceToolsSnapshot['activeTab'],
  rawScript = `{"sceneId":"${sceneId}"}`,
): WorkspaceToolsSnapshot {
  const filePath = `D:/project/${sceneId}.scene.json`;
  return {
    sceneMeta: { title: sceneId, characters: [] },
    timelineActionTimesById: {},
    sceneIdentity: {
      sceneId,
      filePath,
      projectRoot: 'D:/project',
    },
    rawScript,
    filePath,
    projectName: 'Test Project',
    projectRoot: 'D:/project',
    selectedActionIds: [],
    issues: [],
    saveStatus: 'idle',
    theme: 'dark',
    activeTab,
  };
}

describe('WorkspaceToolsWindow script draft', () => {
  let snapshotListener: SnapshotListener;
  let resultListener: ResultListener;
  let sendCommand: ReturnType<typeof vi.fn<(command: WorkspaceToolsCommand) => void>>;

  beforeEach(() => {
    sendCommand = vi.fn();
    (window as any).aeonStageryAPI = {
      workspaceTools: {
        requestSnapshot: vi.fn(async () => ({ success: true })),
        sendCommand,
        onSnapshot: vi.fn((callback: SnapshotListener) => {
          snapshotListener = callback;
          return vi.fn();
        }),
        onRuntime: vi.fn(() => vi.fn()),
        onCommandResult: vi.fn((callback: ResultListener) => {
          resultListener = callback;
          return vi.fn();
        }),
      },
    };
  });

  afterEach(() => {
    delete (window as any).aeonStageryAPI;
  });

  async function showSnapshot(snapshot: WorkspaceToolsSnapshot) {
    await act(async () => {
      snapshotListener(snapshot);
    });
  }

  it('keeps an unapplied draft when switching away from and back to the JSON tab', async () => {
    render(<WorkspaceToolsWindow />);
    const snapshot = createSnapshot('scene-a', 'script');
    await showSnapshot(snapshot);

    const editor = await screen.findByLabelText('JSON editor');
    fireEvent.change(editor, { target: { value: '{"sceneId":"scene-a","edited":true}' } });
    expect(screen.getByText('未应用')).toBeTruthy();

    await showSnapshot({ ...snapshot, activeTab: 'characters' });
    expect(screen.queryByLabelText('JSON editor')).toBeNull();

    await showSnapshot({ ...snapshot, activeTab: 'script' });
    expect((await screen.findByLabelText('JSON editor') as HTMLTextAreaElement).value)
      .toBe('{"sceneId":"scene-a","edited":true}');
    expect(screen.getByText('未应用')).toBeTruthy();
  });

  it('uses roving focus and arrow keys for workspace tool tabs', async () => {
    render(<WorkspaceToolsWindow />);
    await showSnapshot(createSnapshot('scene-a', 'characters'));

    const characterTab = screen.getByRole('tab', { name: '角色' });
    const diagnosticsTab = screen.getByRole('tab', { name: '问题' });
    const snapshotTab = screen.getByRole('tab', { name: '快照' });
    expect(characterTab.getAttribute('tabindex')).toBe('0');
    expect(diagnosticsTab.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(characterTab.id);

    characterTab.focus();
    fireEvent.keyDown(characterTab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(diagnosticsTab);
    expect(sendCommand).toHaveBeenLastCalledWith({ type: 'set-tab', tab: 'diagnostics' });

    fireEvent.keyDown(diagnosticsTab, { key: 'End' });
    expect(document.activeElement).toBe(snapshotTab);
    expect(sendCommand).toHaveBeenLastCalledWith({ type: 'set-tab', tab: 'snapshot' });
  });

  it('can discard a conflicting draft and switch to the current scene', async () => {
    render(<WorkspaceToolsWindow />);
    const firstSnapshot = createSnapshot('scene-a', 'script');
    await showSnapshot(firstSnapshot);

    fireEvent.change(await screen.findByLabelText('JSON editor'), {
      target: { value: '{"sceneId":"scene-a","edited":true}' },
    });

    const nextSnapshot = createSnapshot('scene-b', 'script', '{"sceneId":"scene-b","current":true}');
    await showSnapshot(nextSnapshot);

    expect(screen.getByText('场景冲突')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '放弃旧草稿并切换到当前场景' }));

    expect((screen.getByLabelText('JSON editor') as HTMLTextAreaElement).value)
      .toBe(nextSnapshot.rawScript);
    expect(screen.queryByText('场景冲突')).toBeNull();
    expect(screen.getByText('已同步')).toBeTruthy();
  });

  it('waits for the main-window result and preserves the draft when apply fails', async () => {
    render(<WorkspaceToolsWindow />);
    const snapshot = createSnapshot('scene-a', 'script');
    await showSnapshot(snapshot);

    const editor = await screen.findByLabelText('JSON editor');
    const editedSource = '{"sceneId":"scene-a","edited":true}';
    fireEvent.change(editor, { target: { value: editedSource } });
    fireEvent.click(screen.getByRole('button', { name: '应用 JSON' }));

    const command = sendCommand.mock.calls
      .map(([value]) => value)
      .find((value) => value.type === 'apply-raw-script');
    expect(command?.type).toBe('apply-raw-script');
    if (!command || command.type !== 'apply-raw-script') throw new Error('apply command was not sent');
    expect(screen.getByText('应用中')).toBeTruthy();
    expect(screen.queryByText('已同步')).toBeNull();

    await showSnapshot(snapshot);
    expect((screen.getByLabelText('JSON editor') as HTMLTextAreaElement).value).toBe(editedSource);

    await act(async () => {
      resultListener({
        type: 'apply-raw-script-result',
        requestId: command.requestId,
        sceneIdentity: command.sceneIdentity,
        success: false,
        error: 'schema validation failed',
      });
    });

    expect(screen.getByText('schema validation failed')).toBeTruthy();
    expect(screen.getByText('未应用')).toBeTruthy();
    expect((screen.getByLabelText('JSON editor') as HTMLTextAreaElement).value).toBe(editedSource);
    expect(screen.getByRole('button', { name: '应用 JSON' }).hasAttribute('disabled')).toBe(false);
  });

  it('clears dirty only after a successful result for the submitted source', async () => {
    render(<WorkspaceToolsWindow />);
    const snapshot = createSnapshot('scene-a', 'script');
    await showSnapshot(snapshot);

    const editedSource = '{"sceneId":"scene-a","edited":true}';
    fireEvent.change(await screen.findByLabelText('JSON editor'), {
      target: { value: editedSource },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用 JSON' }));

    const command = sendCommand.mock.calls
      .map(([value]) => value)
      .find((value) => value.type === 'apply-raw-script');
    if (!command || command.type !== 'apply-raw-script') throw new Error('apply command was not sent');
    expect(screen.getByText('应用中')).toBeTruthy();

    await act(async () => {
      resultListener({
        type: 'apply-raw-script-result',
        requestId: command.requestId,
        sceneIdentity: command.sceneIdentity,
        success: true,
      });
    });

    await waitFor(() => expect(screen.getByText('已同步')).toBeTruthy());
    expect((screen.getByLabelText('JSON editor') as HTMLTextAreaElement).value).toBe(editedSource);
  });

  it('does not clear newer edits when an earlier apply request succeeds', async () => {
    render(<WorkspaceToolsWindow />);
    const snapshot = createSnapshot('scene-a', 'script');
    await showSnapshot(snapshot);

    const editor = await screen.findByLabelText('JSON editor');
    fireEvent.change(editor, {
      target: { value: '{"sceneId":"scene-a","edited":true}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用 JSON' }));

    const command = sendCommand.mock.calls
      .map(([value]) => value)
      .find((value) => value.type === 'apply-raw-script');
    if (!command || command.type !== 'apply-raw-script') throw new Error('apply command was not sent');

    const newerSource = '{"sceneId":"scene-a","edited":"again"}';
    fireEvent.change(editor, { target: { value: newerSource } });
    await act(async () => {
      resultListener({
        type: 'apply-raw-script-result',
        requestId: command.requestId,
        sceneIdentity: command.sceneIdentity,
        success: true,
      });
    });

    expect(screen.getByText('未应用')).toBeTruthy();
    expect((screen.getByLabelText('JSON editor') as HTMLTextAreaElement).value).toBe(newerSource);
  });

  it('blocks a duplicate character id in the detached character panel', async () => {
    render(<WorkspaceToolsWindow />);
    await showSnapshot({
      ...createSnapshot('scene-a', 'characters'),
      sceneMeta: {
        title: '多角色',
        characters: [
          { id: '1', name: '甲' },
          { id: '2', name: '乙' },
        ],
      },
    });

    const input = screen.getByLabelText('角色 ID') as HTMLInputElement;
    expect(input.value).toBe('1');

    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);

    expect(screen.getByRole('alert').textContent).toContain('已被其他角色占用');
    expect(input.value).toBe('1');
    expect(sendCommand.mock.calls.some(([command]) => (
      command.type === 'character-command' && command.command.kind === 'update-character-id'
    ))).toBe(false);
  });

  it('sends a character id rename from the detached character panel', async () => {
    render(<WorkspaceToolsWindow />);
    await showSnapshot({
      ...createSnapshot('scene-a', 'characters'),
      sceneMeta: {
        title: '多角色',
        characters: [
          { id: '1', name: '甲' },
          { id: '2', name: '乙' },
        ],
      },
    });

    const input = screen.getByLabelText('角色 ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' hero ' } });
    fireEvent.blur(input);

    expect(sendCommand).toHaveBeenCalledWith({
      type: 'character-command',
      command: { kind: 'update-character-id', currentCharId: '1', nextCharId: 'hero' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a draft bound to its original scene and blocks applying it to another scene', async () => {
    render(<WorkspaceToolsWindow />);
    const sceneA = createSnapshot('scene-a', 'script');
    await showSnapshot(sceneA);

    const editedSource = '{"sceneId":"scene-a","edited":true}';
    fireEvent.change(await screen.findByLabelText('JSON editor'), {
      target: { value: editedSource },
    });

    await showSnapshot(createSnapshot('scene-b', 'script'));
    expect(screen.getByText('场景冲突')).toBeTruthy();
    expect((screen.getByLabelText('JSON editor') as HTMLTextAreaElement).value).toBe(editedSource);
    expect(screen.getByRole('button', { name: '应用 JSON' }).hasAttribute('disabled')).toBe(true);
    expect(sendCommand.mock.calls.some(([command]) => command.type === 'apply-raw-script')).toBe(false);

    await showSnapshot(sceneA);
    expect(screen.getByText('未应用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '应用 JSON' }).hasAttribute('disabled')).toBe(false);
  });
});
