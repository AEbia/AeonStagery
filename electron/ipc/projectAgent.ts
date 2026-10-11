import { app, ipcMain } from 'electron';
import * as path from 'path';
import type {
  ProjectAgentBeginTaskRequest,
  ProjectAgentProjectContext,
  ProjectAgentStartRequest,
  ProjectAgentTaskStatusPayload,
  ProjectAgentTerminalCommandRequest,
} from '../../src/api/types/project-agent-ipc';
import { FileSystemProjectAgentJournalPort } from '../../src/services/project-agent-service/FileSystemProjectAgentJournalPort';
import { ProjectAgentTaskCoordinator, type ProjectAgentEditorRelayPort, type ProjectAgentWindowController } from '../../src/services/project-agent-service/ProjectAgentTaskCoordinator';
import type { ProjectAgentJournalRecord } from '../../src/services/project-agent/ProjectAgentJournal';
import type { ProjectAgentPauseReason } from '../../src/services/project-agent/ProjectAgentTask';
import { NodeProjectAgentTerminalExecutor } from '../projectAgentTerminal';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerProjectAgentHandlers(windows: IpcWindowContext) {
  const { isMainWindowFrameSender, isAgentWindowFrameSender } = createWindowSenderGuards(windows);
  let projectAgentTaskCoordinator: ProjectAgentTaskCoordinator | null = null;
  const projectAgentTerminalExecutor = new NodeProjectAgentTerminalExecutor();

  function getProjectAgentTaskCoordinator(): ProjectAgentTaskCoordinator {
    if (projectAgentTaskCoordinator) return projectAgentTaskCoordinator;
    const windowController: ProjectAgentWindowController = {
      openAgentWindow: () => {
        windows.createAgentWindow();
      },
      sendToAgentWindow: (status) => {
        if (!windows.agentWindow || windows.agentWindow.isDestroyed()) return;
        windows.agentWindow.webContents.send('projectAgent:status', status);
      },
      sendContextToAgentWindow: (context) => {
        if (!windows.agentWindow || windows.agentWindow.isDestroyed()) return;
        windows.agentWindow.webContents.send('projectAgent:context', context);
      },
      sendStartResultToAgentWindow: (payload) => {
        if (!windows.agentWindow || windows.agentWindow.isDestroyed()) return;
        windows.agentWindow.webContents.send('projectAgent:startResult', payload);
      },
    };
    // The editor renderer is the sole task-lifecycle/mutation owner: main only
    // relays pause/cancel/continue commands and falls back to its own
    // lease/journal pause when the editor renderer is unavailable.
    const editorRelay: ProjectAgentEditorRelayPort = {
      sendCommand: (command) => {
        if (!windows.mainWindow || windows.mainWindow.isDestroyed() || windows.mainWindow.webContents.isDestroyed()) {
          return false;
        }
        windows.mainWindow.webContents.send('projectAgent:command', command);
        return true;
      },
      sendModel: (model) => {
        if (!windows.mainWindow || windows.mainWindow.isDestroyed() || windows.mainWindow.webContents.isDestroyed()) {
          return false;
        }
        windows.mainWindow.webContents.send('projectAgent:setModel', model);
        return true;
      },
      sendEffort: (effort) => {
        if (!windows.mainWindow || windows.mainWindow.isDestroyed() || windows.mainWindow.webContents.isDestroyed()) {
          return false;
        }
        windows.mainWindow.webContents.send('projectAgent:setEffort', effort);
        return true;
      },
    };
    projectAgentTaskCoordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(
        path.join(app.getPath('userData'), 'project-agent-journal'),
      ),
      window: windowController,
      editor: editorRelay,
    });
    return projectAgentTaskCoordinator;
  }

  function isProjectAgentStatusPayload(value: unknown): value is ProjectAgentTaskStatusPayload {
    return !!value
      && typeof value === 'object'
      && typeof (value as ProjectAgentTaskStatusPayload).taskId === 'string'
      && typeof (value as ProjectAgentTaskStatusPayload).projectId === 'string'
      && typeof (value as ProjectAgentTaskStatusPayload).lifecycle === 'string'
      && typeof (value as ProjectAgentTaskStatusPayload).phase === 'string';
  }

  function isProjectAgentProjectContext(value: unknown): value is ProjectAgentProjectContext {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as ProjectAgentProjectContext;
    if (typeof candidate.projectId !== 'string' || candidate.projectId.length === 0) return false;
    if (typeof candidate.projectName !== 'string' || candidate.projectName.trim().length === 0) {
      return false;
    }
    if (candidate.sceneName !== undefined && typeof candidate.sceneName !== 'string') return false;
    if (candidate.projectRoot !== undefined && typeof candidate.projectRoot !== 'string') return false;
    if (
      candidate.imageInputSupported !== undefined
      && typeof candidate.imageInputSupported !== 'boolean'
    ) {
      return false;
    }
    return true;
  }

  function isProjectAgentJournalRecord(value: unknown): value is ProjectAgentJournalRecord {
    if (!value || typeof value !== 'object') return false;
    const kind = (value as { kind?: unknown }).kind;
    return kind === 'running' || kind === 'suspended' || kind === 'idle';
  }

  ipcMain.handle('projectAgent:beginTask', async (event, request: unknown) => {
    if (!isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', message: 'Unauthorized project Agent sender.' };
    }
    const payload = request as ProjectAgentBeginTaskRequest;
    if (!payload || typeof payload !== 'object'
      || typeof payload.projectId !== 'string'
      || typeof payload.sceneEntryId !== 'string'
      || typeof payload.sceneDocumentId !== 'string'
      || typeof payload.taskText !== 'string'
      || typeof payload.taskId !== 'string') {
      return { ok: false, code: 'invalid_arguments', message: 'Invalid beginTask request.' };
    }
    return getProjectAgentTaskCoordinator().beginTask(payload);
  });

  ipcMain.handle('projectAgent:acquireLease', async (event, projectId: unknown, taskId: unknown) => {
    if (!isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_owner', message: 'Unauthorized lease request.' };
    }
    if (typeof projectId !== 'string' || typeof taskId !== 'string') {
      return { ok: false, code: 'invalid_owner', message: 'Invalid lease request.' };
    }
    return getProjectAgentTaskCoordinator().acquireLease(projectId, taskId);
  });

  ipcMain.handle('projectAgent:releaseLease', async (event, leaseToken: unknown) => {
    if (!isMainWindowFrameSender(event)) {
      return { ok: false, code: 'not_holder', message: 'Unauthorized lease release.' };
    }
    if (typeof leaseToken !== 'string' || leaseToken.length === 0) {
      return { ok: false, code: 'not_holder', message: 'Invalid lease token.' };
    }
    return getProjectAgentTaskCoordinator().releaseLease(leaseToken);
  });

  ipcMain.handle('projectAgent:getLeaseHolder', async () => {
    return getProjectAgentTaskCoordinator().getLeaseHolder();
  });

  ipcMain.handle('projectAgent:journalLoad', async (event, projectId: unknown, taskId: unknown) => {
    if (!isMainWindowFrameSender(event)) return null;
    if (typeof projectId !== 'string' || typeof taskId !== 'string') return null;
    return getProjectAgentTaskCoordinator().journalLoad(projectId, taskId);
  });

  ipcMain.handle('projectAgent:journalSave', async (event, record: unknown) => {
    if (!isMainWindowFrameSender(event)) {
      throw new Error('Unauthorized project Agent journal sender.');
    }
    if (!isProjectAgentJournalRecord(record)) {
      throw new Error('Invalid project Agent journal record.');
    }
    await getProjectAgentTaskCoordinator().journalSave(record);
  });

  ipcMain.handle('projectAgent:journalListByProject', async (event, projectId: unknown) => {
    if (!isMainWindowFrameSender(event) && !isAgentWindowFrameSender(event)) return [];
    if (typeof projectId !== 'string') return [];
    return getProjectAgentTaskCoordinator().journalListByProject(projectId);
  });

  ipcMain.handle('projectAgent:publishStatus', async (event, status: unknown) => {
    if (!isMainWindowFrameSender(event)) return false;
    if (!isProjectAgentStatusPayload(status)) return false;
    return getProjectAgentTaskCoordinator().publishTaskStatus(status);
  });

  ipcMain.handle('projectAgent:getTaskStatus', async (event, taskId: unknown) => {
    if (!isMainWindowFrameSender(event) && !isAgentWindowFrameSender(event)) return null;
    return getProjectAgentTaskCoordinator().getTaskStatus(
      typeof taskId === 'string' ? taskId : undefined,
    );
  });

  ipcMain.handle('projectAgent:sendSupplement', async (event, taskId: unknown, text: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent supplement sender.' };
    }
    if (typeof taskId !== 'string' || typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'Invalid project Agent supplement.' };
    }
    if (windows.mainWindow && !windows.mainWindow.isDestroyed()) {
      windows.mainWindow.webContents.send('projectAgent:supplement', { taskId, text });
    }
    return { ok: true };
  });

  // Agent-window task start (ADR0023): the window requests a start with task
  // text (and optionally a user-attached image); main relays it to the editor
  // renderer, the sole task-lifecycle owner, which validates targets/admission
  // and begins the task. The window never holds project/scene state, so it
  // never guesses a target identity. Image bytes are transient — they never
  // enter the main-process journal.
  const MAX_AGENT_IMAGE_BYTES = 6 * 1024 * 1024;
  const ALLOWED_AGENT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  function isProjectAgentStartRequest(value: unknown): value is ProjectAgentStartRequest {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as ProjectAgentStartRequest;
    if (typeof candidate.taskText !== 'string' || candidate.taskText.trim().length === 0) {
      return false;
    }
    if (candidate.requestId !== undefined && typeof candidate.requestId !== 'string') return false;
    if (candidate.accessMode !== undefined
      && candidate.accessMode !== 'standard'
      && candidate.accessMode !== 'full_access') return false;
    if (candidate.image === undefined) return true;
    const image = candidate.image;
    if (!image || typeof image !== 'object') return false;
    if (typeof image.name !== 'string' || typeof image.mimeType !== 'string') return false;
    if (!ALLOWED_AGENT_IMAGE_MIME.has(image.mimeType)) return false;
    if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength === 0) return false;
    if (image.bytes.byteLength > MAX_AGENT_IMAGE_BYTES) return false;
    if (image.detail !== 'auto' && image.detail !== 'low' && image.detail !== 'high') return false;
    return true;
  }

  ipcMain.handle('projectAgent:requestStart', async (event, payload: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent start sender.' };
    }
    if (!isProjectAgentStartRequest(payload)) {
      return { ok: false, error: 'Invalid project Agent task payload.' };
    }
    if (windows.mainWindow && !windows.mainWindow.isDestroyed()) {
      windows.mainWindow.webContents.send('projectAgent:startRequest', payload);
    }
    return { ok: true };
  });

  function isProjectAgentTerminalCommandRequest(value: unknown): value is ProjectAgentTerminalCommandRequest {
    if (!value || typeof value !== 'object') return false;
    const request = value as ProjectAgentTerminalCommandRequest;
    if (typeof request.projectId !== 'string' || request.projectId.length === 0
      || typeof request.taskId !== 'string' || request.taskId.length === 0
      || typeof request.requestId !== 'string' || request.requestId.length === 0
      || typeof request.command !== 'string' || request.command.length === 0) return false;
    if (request.shell !== undefined && request.shell !== 'default' && request.shell !== 'powershell') return false;
    if (request.cwd !== undefined && typeof request.cwd !== 'string') return false;
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1)) return false;
    if (request.maxOutputChars !== undefined && (!Number.isInteger(request.maxOutputChars) || request.maxOutputChars < 1)) return false;
    return true;
  }

  ipcMain.handle('projectAgent:runTerminalCommand', async (event, payload: unknown) => {
    if (!isMainWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent terminal sender.' };
    }
    if (!isProjectAgentTerminalCommandRequest(payload)) {
      return { ok: false, error: 'Invalid terminal command request.' };
    }
    const record = await getProjectAgentTaskCoordinator().journalLoad(payload.projectId, payload.taskId);
    if (!record || record.identity.accessMode !== 'full_access') {
      return { ok: false, error: 'Terminal execution is not authorized for this Conversation.' };
    }
    return {
      ok: true,
      result: await projectAgentTerminalExecutor.run(payload.requestId, payload),
    };
  });

  ipcMain.handle('projectAgent:cancelTerminalCommand', async (event, requestId: unknown) => {
    if (!isMainWindowFrameSender(event) || typeof requestId !== 'string' || requestId.length === 0) return;
    projectAgentTerminalExecutor.cancel(requestId);
  });

  // Agent-window model switch (window → main → editor): the editor updates the
  // shared settings store so the live provider hot-update path applies it.
  ipcMain.handle('projectAgent:setModel', async (event, model: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent model sender.' };
    }
    if (typeof model !== 'string' || model.trim().length === 0) {
      return { ok: false, error: 'Invalid model identifier.' };
    }
    return getProjectAgentTaskCoordinator().setAgentModel(model);
  });

  // Agent-window effort switch (window → main → editor): the editor updates the
  // shared aiProse effort setting through the same hot-update path as the model.
  ipcMain.handle('projectAgent:setEffort', async (event, effort: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent effort sender.' };
    }
    if (typeof effort !== 'string' || effort.trim().length === 0) {
      return { ok: false, error: 'Invalid effort value.' };
    }
    return getProjectAgentTaskCoordinator().setAgentEffort(effort);
  });

  // Agent-window settings entry: relay an open-settings command to the editor.
  ipcMain.handle('projectAgent:openSettings', async (event) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent settings sender.' };
    }
    return getProjectAgentTaskCoordinator().openSettings();
  });

  // Editor-published project presentation context → Agent window (cached).
  ipcMain.handle('projectAgent:publishContext', async (event, context: unknown) => {
    if (!isMainWindowFrameSender(event)) return;
    if (!isProjectAgentProjectContext(context)) return;
    await getProjectAgentTaskCoordinator().publishProjectContext(context);
  });

  ipcMain.handle('projectAgent:getContext', async (event) => {
    if (!isMainWindowFrameSender(event) && !isAgentWindowFrameSender(event)) return null;
    return getProjectAgentTaskCoordinator().getProjectContext();
  });

  // Editor-side task-start result → Agent window (correlated by requestId).
  ipcMain.handle('projectAgent:publishStartResult', async (event, payload: unknown) => {
    if (!isMainWindowFrameSender(event)) return;
    if (!payload || typeof payload !== 'object') return;
    const candidate = payload as { requestId?: unknown; ok?: unknown; error?: unknown };
    if (typeof candidate.requestId !== 'string' || typeof candidate.ok !== 'boolean') return;
    await getProjectAgentTaskCoordinator().publishStartResult({
      requestId: candidate.requestId,
      ok: candidate.ok,
      ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
    });
  });

  ipcMain.handle('projectAgent:requestPause', async (event, taskId: unknown, reason: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent pause sender.' };
    }
    if (typeof taskId !== 'string' || typeof reason !== 'string') {
      return { ok: false, code: 'invalid_arguments', error: 'Invalid pause request.' };
    }
    return getProjectAgentTaskCoordinator().requestPause(taskId, reason as ProjectAgentPauseReason);
  });

  ipcMain.handle('projectAgent:requestCancel', async (event, taskId: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent cancel sender.' };
    }
    if (typeof taskId !== 'string') {
      return { ok: false, code: 'invalid_arguments', error: 'Invalid cancel request.' };
    }
    return getProjectAgentTaskCoordinator().requestCancel(taskId);
  });

  ipcMain.handle('projectAgent:requestContinue', async (event, taskId: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent continue sender.' };
    }
    if (typeof taskId !== 'string') {
      return { ok: false, code: 'invalid_arguments', error: 'Invalid continue request.' };
    }
    return getProjectAgentTaskCoordinator().requestContinue(taskId);
  });

  ipcMain.handle('projectAgent:acknowledgeReport', async (event, taskId: unknown) => {
    if (!isAgentWindowFrameSender(event)) {
      return { ok: false, error: 'Unauthorized project Agent report acknowledgement.' };
    }
    if (typeof taskId !== 'string') {
      return { ok: false, error: 'Invalid task id.' };
    }
    return getProjectAgentTaskCoordinator().acknowledgeReport(taskId);
  });

  ipcMain.handle('projectAgent:deleteConversation', async (event, projectId: unknown, conversationId: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent delete sender.' };
    }
    if (typeof projectId !== 'string' || projectId.length === 0
      || typeof conversationId !== 'string' || conversationId.length === 0) {
      return { ok: false, code: 'invalid_arguments', error: 'projectId and conversationId are required.' };
    }
    return getProjectAgentTaskCoordinator().deleteConversation(projectId, conversationId);
  });

  ipcMain.handle('projectAgent:renameConversation', async (event, projectId: unknown, conversationId: unknown, name: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent rename sender.' };
    }
    if (typeof projectId !== 'string' || projectId.length === 0
      || typeof conversationId !== 'string' || conversationId.length === 0
      || typeof name !== 'string') {
      return { ok: false, code: 'invalid_arguments', error: 'projectId, conversationId and name are required.' };
    }
    return getProjectAgentTaskCoordinator().renameConversation(projectId, conversationId, name);
  });

  ipcMain.handle('projectAgent:switchConversation', async (event, projectId: unknown, conversationId: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent switch sender.' };
    }
    if (typeof projectId !== 'string' || projectId.length === 0
      || typeof conversationId !== 'string' || conversationId.length === 0) {
      return { ok: false, code: 'invalid_arguments', error: 'projectId and conversationId are required.' };
    }
    return getProjectAgentTaskCoordinator().requestSwitchConversation(projectId, conversationId);
  });

  ipcMain.handle('projectAgent:publishRestoredProject', async (event, projectId: unknown) => {
    if (!isMainWindowFrameSender(event)) return;
    if (typeof projectId !== 'string') return;
    await getProjectAgentTaskCoordinator().publishRestoredProject(projectId);
  });

  ipcMain.handle('projectAgent:discardTask', async (event, taskId: unknown) => {
    if (!isAgentWindowFrameSender(event) && !isMainWindowFrameSender(event)) {
      return { ok: false, code: 'invalid_arguments', error: 'Unauthorized project Agent discard sender.' };
    }
    if (typeof taskId !== 'string') {
      return { ok: false, code: 'invalid_arguments', error: 'Invalid discard request.' };
    }
    return getProjectAgentTaskCoordinator().requestDiscard(taskId);
  });

  ipcMain.handle('projectAgent:openWindow', async (event) => {
    if (!isMainWindowFrameSender(event)) return { success: false };
    windows.createAgentWindow();
    return { success: true };
  });

  return {
    pauseTasksForRendererLoss: (reason: 'renderer_reloaded' | 'application_exit') => (
      getProjectAgentTaskCoordinator().pauseTasksForRendererLoss(reason)
    ),
    onAgentWindowStateChange: (state: 'minimized' | 'closed') => (
      getProjectAgentTaskCoordinator().onAgentWindowStateChange(state)
    ),
  };
}
