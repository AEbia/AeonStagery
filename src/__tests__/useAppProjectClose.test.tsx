/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapContext } from '../engine/Bootstrapper';
import type { SaveResult } from '../services/io/SceneFileService';
import { DocumentStore } from '../ui/store/DocumentStore';
import { EditorStore } from '../ui/store/EditorStore';
import { PlaybackStore } from '../ui/store/PlaybackStore';
import { ValidationStore } from '../ui/store/ValidationStore';
import { TimelineAdapter } from '../api/adapters/TimelineAdapter';
import { useAppProjectClose } from '../ui/hooks/useAppProjectClose';
import { showToast } from '../ui/Toast';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

function setup(hasScene = true, waitForPendingProjectOperations = vi.fn(async () => {})) {
  const document = new DocumentStore();
  const editor = new EditorStore();
  const playback = new PlaybackStore();
  const validation = new ValidationStore();
  if (hasScene) {
    document._replaceCurrentSceneDocumentSnapshot({ schemaVersion: 5, sceneId: 'main', meta: { title: 'Main' }, statements: [] });
    document._setFilePath('/project/scenes/main.json');
  }
  editor.setSelectedIds({ old: true });
  playback.setDuration(12);
  const save = vi.fn<() => Promise<SaveResult>>(async () => ({ success: true, path: '/project/scenes/main.json' }));
  const disconnect = vi.fn(async () => {});
  const closeProject = vi.fn();
  const pause = vi.fn();
  const clearHistory = vi.fn();
  const closeActive = vi.fn(async () => {});
  const context = {
    stores: { document, editor, playback, validation },
    adapters: { playback: { pause }, timeline: new TimelineAdapter(editor) },
    services: {
      projectWorkspace: { getCurrentProject: () => ({ rootPath: '/project' }), closeProject },
      sceneFile: { save },
      semanticAuthoring: { clearHistory, waitForPendingEdits: vi.fn(async () => {}) },
      customMotionEditing: { closeActive },
      customMotionConversion: { cancel: vi.fn(async () => {}) },
    },
  } as unknown as BootstrapContext;
  return { ...renderHook(() => useAppProjectClose(context, disconnect, waitForPendingProjectOperations)), document, editor, playback, save, disconnect, closeProject, pause, clearHistory, closeActive };
}

describe('closing the project', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves before disconnecting, then clears the scene, path, selection and history', async () => {
    const workflow = setup();
    workflow.save.mockImplementation(async () => {
      expect(workflow.closeActive).toHaveBeenCalledOnce();
      expect(workflow.disconnect).not.toHaveBeenCalled();
      return { success: true, path: '/project/scenes/main.json' };
    });
    await act(async () => { expect(await workflow.result.current.handleCloseProject()).toBe(true); });
    expect(workflow.pause).toHaveBeenCalledOnce();
    expect(workflow.disconnect).toHaveBeenCalledOnce();
    expect(workflow.closeProject).toHaveBeenCalledOnce();
    expect(workflow.document.getCurrentSceneDocumentView()).toBeNull();
    expect(workflow.document.filePath).toBeNull();
    expect(workflow.editor.selectedCount).toBe(0);
    expect(workflow.playback.duration).toBe(0);
    expect(workflow.clearHistory).toHaveBeenCalledOnce();
    expect(workflow.result.current.isClosingProject).toBe(false);
  });

  it('waits for project workflows to finish before saving and closing', async () => {
    let finishPendingOperation: () => void = () => {};
    const pendingOperation = new Promise<void>((resolve) => { finishPendingOperation = resolve; });
    const waitForPendingProjectOperations = vi.fn(() => pendingOperation);
    const workflow = setup(true, waitForPendingProjectOperations);

    let closing: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      closing = workflow.result.current.handleCloseProject();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(waitForPendingProjectOperations).toHaveBeenCalledOnce();
    expect(workflow.save).not.toHaveBeenCalled();
    expect(workflow.closeProject).not.toHaveBeenCalled();

    await act(async () => {
      finishPendingOperation();
      expect(await closing).toBe(true);
    });
    expect(workflow.save).toHaveBeenCalledOnce();
    expect(workflow.closeProject).toHaveBeenCalledOnce();
  });

  it('keeps the project, scene and collaboration session when saving fails', async () => {
    const workflow = setup();
    workflow.save.mockResolvedValue({ success: false, error: '磁盘已满' });
    await act(async () => { expect(await workflow.result.current.handleCloseProject()).toBe(false); });
    expect(workflow.disconnect).not.toHaveBeenCalled();
    expect(workflow.closeProject).not.toHaveBeenCalled();
    expect(workflow.document.filePath).toBe('/project/scenes/main.json');
    expect(workflow.document.getCurrentSceneDocumentView()).not.toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('磁盘已满'), 'error');
  });

  it('keeps the project open when a save dialog is canceled', async () => {
    const workflow = setup();
    workflow.save.mockResolvedValue({ success: false, cancelled: true });
    await act(async () => { expect(await workflow.result.current.handleCloseProject()).toBe(false); });
    expect(workflow.closeProject).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('can close a project without a loaded scene', async () => {
    const workflow = setup(false);
    await act(async () => { expect(await workflow.result.current.handleCloseProject()).toBe(true); });
    expect(workflow.save).not.toHaveBeenCalled();
    expect(workflow.disconnect).toHaveBeenCalledOnce();
    expect(workflow.closeProject).toHaveBeenCalledOnce();
  });

  it('saves an edit that arrives during the first disk write before clearing the scene', async () => {
    const workflow = setup();
    workflow.save.mockImplementationOnce(async () => {
      workflow.document._replaceCurrentSceneDocumentSnapshot({ schemaVersion: 5, sceneId: 'main', meta: { title: 'Latest' }, statements: [] });
      return { success: true, path: '/project/scenes/main.json' };
    });
    await act(async () => { expect(await workflow.result.current.handleCloseProject()).toBe(true); });
    expect(workflow.save).toHaveBeenCalledTimes(2);
    expect(workflow.closeProject).toHaveBeenCalledOnce();
  });

  it('ignores a repeated close while saving is in progress', async () => {
    const workflow = setup();
    let finishSave: (result: SaveResult) => void = () => {};
    workflow.save.mockImplementation(() => new Promise<SaveResult>((resolve) => { finishSave = resolve; }));
    await act(async () => {
      const firstClose = workflow.result.current.handleCloseProject();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(await workflow.result.current.handleCloseProject()).toBe(false);
      finishSave({ success: true, path: '/project/scenes/main.json' });
      expect(await firstClose).toBe(true);
    });
    expect(workflow.save).toHaveBeenCalledOnce();
    expect(workflow.closeProject).toHaveBeenCalledOnce();
  });
});
