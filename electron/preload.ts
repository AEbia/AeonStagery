import { contextBridge, ipcRenderer } from 'electron';
import type { AeonStageryElectronAPI } from '../src/api/types/window';
import type { UpdateStatus } from '../src/api/types/updater';
import type {
  WorkspaceRuntimeSnapshot,
  WorkspaceToolsCommand,
  WorkspaceToolsCommandResult,
  WorkspaceToolsSnapshot,
  WorkspaceToolsWindowState,
} from '../src/ui/workspace-tools/types';
import type {
  AiProseCapabilityProbeRequest,
  AiProseProviderConfig,
} from '../src/api/types/ai-prose-authoring';
import type {
  AiProseLlmProgress,
  AiProseLlmRequest,
} from '../src/services/ai-authoring/AiProseContracts';
import type { AiConversationIpcRequest, AiConversationProgress } from '../src/api/types/ai-conversation-ipc';
import type {
  ProjectAgentAcknowledgeReportResult,
  ProjectAgentBeginTaskRequest,
  ProjectAgentDeleteConversationResult,
  ProjectAgentProjectContext,
  ProjectAgentRenameConversationResult,
  ProjectAgentStartRequest,
  ProjectAgentImageAttachment,
  ProjectAgentSupplementRequest,
  ProjectAgentStartResultPayload,
  ProjectAgentTerminalCommandRequest,
  ProjectAgentTaskStatusPayload,
} from '../src/api/types/project-agent-ipc';
import type { ProjectAgentJournalRecord } from '../src/services/project-agent/ProjectAgentJournal';
import type {
  ProjectAgentEditorCommand,
  ProjectAgentTaskCommandResult,
} from '../src/services/project-agent-service/ProjectAgentTaskCoordinator';
import type { CrashReport, CrashEnvironmentInfo } from '../src/api/types/crash';
import type { WebGalScssImportInstallRequest } from '../src/api/types/template-package-import';

/**
 * AeonStagery Preload Bridge
 * Exposes safe IPC methods to the renderer process.
 */
const electronAPI = {
  // ─── File System ───────────────────────────────────────
  fs: {
    readFile: (filePath: string) =>
      ipcRenderer.invoke('fs:readFile', filePath),
    readTextFile: (filePath: string) =>
      ipcRenderer.invoke('fs:readTextFile', filePath),
    readDir: (dirPath: string) =>
      ipcRenderer.invoke('fs:readDir', dirPath),
    exists: (filePath: string) =>
      ipcRenderer.invoke('fs:exists', filePath),
    stat: (filePath: string) =>
      ipcRenderer.invoke('fs:stat', filePath),
    realpath: (filePath: string) =>
      ipcRenderer.invoke('fs:realpath', filePath),
    writeFile: (filePath: string, data: ArrayBuffer) =>
      ipcRenderer.invoke('fs:writeFile', filePath, data),
    writeTextFile: (filePath: string, data: string) =>
      ipcRenderer.invoke('fs:writeTextFile', filePath, data),
    replaceFile: (temporaryPath: string, destinationPath: string) =>
      ipcRenderer.invoke('fs:replaceFile', temporaryPath, destinationPath),
    ensureDir: (dirPath: string) =>
      ipcRenderer.invoke('fs:ensureDir', dirPath),
    copyFile: (sourcePath: string, destPath: string) =>
      ipcRenderer.invoke('fs:copyFile', sourcePath, destPath),
    removeFile: (filePath: string) => ipcRenderer.invoke('fs:removeFile', filePath),
  },

  // ─── Dialogs ───────────────────────────────────────────
  dialog: {
    showSave: (options: Parameters<AeonStageryElectronAPI['dialog']['showSave']>[0]) =>
      ipcRenderer.invoke('dialog:showSave', options),
    showOpen: (options: Parameters<AeonStageryElectronAPI['dialog']['showOpen']>[0]) =>
      ipcRenderer.invoke('dialog:showOpen', options),
  },
  templates: {
    importZip: () => ipcRenderer.invoke('templates:importZip'),
    // WebGAL dialogue template: inspect picks the directory and reports what
    // would be installed (including duplicates), install performs the write.
    inspectWebgalScss: () => ipcRenderer.invoke('templates:inspectWebGalScss'),
    installWebgalScss: (request: WebGalScssImportInstallRequest) =>
      ipcRenderer.invoke('templates:installWebGalScss', request),
    deletePackage: (request: import('../src/api/types/template-package-import').TemplatePackageDeleteRequest) => ipcRenderer.invoke('templates:deletePackage', request),
  },

  // ─── Live2D Runtime Availability ───────────────────────
  live2dRuntime: {
    getAvailability: (): Promise<{ cubism2: boolean; cubism3Plus: boolean } | null> =>
      ipcRenderer.invoke('runtime:getLive2DAvailability'),
    getStatus: () =>
      ipcRenderer.invoke('runtime:getLive2DStatus'),
    refreshStatus: () =>
      ipcRenderer.invoke('runtime:refreshLive2DStatus'),
    openDirectory: (type?: 'local' | 'runtime') =>
      ipcRenderer.invoke('runtime:openLive2DDirectory', type),
  },

  // ─── App ───────────────────────────────────────────────
  app: {
    getPath: () => ipcRenderer.invoke('app:getPath'),
    getProjectPath: () => ipcRenderer.invoke('app:getProjectPath'),
    getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),
    getDefaultProjectsPath: () => ipcRenderer.invoke('app:getDefaultProjectsPath'),
    restart: () => ipcRenderer.invoke('app:restart'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  },
  crash: {
    record: (report: CrashReport) => ipcRenderer.invoke('crash:record', report),
    openReportDir: () => ipcRenderer.invoke('crash:openReportDir'),
    getLatestReport: () => ipcRenderer.invoke('crash:getLatestReport'),
    getEnvironment: (): Promise<Partial<CrashEnvironmentInfo>> =>
      ipcRenderer.invoke('crash:getEnvironment'),
  },
  aiProse: {
    complete: (request: AiProseLlmRequest) => ipcRenderer.invoke('aiProse:complete', request),
    onProgress: (callback: (progress: AiProseLlmProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: AiProseLlmProgress) => callback(progress);
      ipcRenderer.on('aiProse:progress', listener);
      return () => ipcRenderer.removeListener('aiProse:progress', listener);
    },
    cancel: (requestId: string) => ipcRenderer.send('aiProse:cancel', requestId),
    probeCapabilities: (request: AiProseCapabilityProbeRequest) =>
      ipcRenderer.invoke('aiProse:probeCapabilities', request),
    listModels: (baseUrl: string) => ipcRenderer.invoke('aiProse:listModels', baseUrl),
    configureProvider: (provider: AiProseProviderConfig) =>
      ipcRenderer.invoke('aiProse:configureProvider', provider),
    getCredentialStatus: () => ipcRenderer.invoke('aiProse:getCredentialStatus'),
    setCredential: (value: string) => ipcRenderer.invoke('aiProse:setCredential', value),
    clearCredential: () => ipcRenderer.invoke('aiProse:clearCredential'),
  },
  conversation: {
    complete: (request: AiConversationIpcRequest) =>
      ipcRenderer.invoke('aiConversation:complete', request),
    cancel: (requestId: string) =>
      ipcRenderer.invoke('aiConversation:cancel', requestId),
    onProgress: (callback: (progress: AiConversationProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: AiConversationProgress) => callback(progress);
      ipcRenderer.on('aiConversation:progress', listener);
      return () => ipcRenderer.removeListener('aiConversation:progress', listener);
    },
    onDebugLog: (callback: (entry: { tag: string; payload: unknown }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, entry: { tag: string; payload: unknown }) => callback(entry);
      ipcRenderer.on('aiDebug:log', listener);
      return () => ipcRenderer.removeListener('aiDebug:log', listener);
    },
  },

  // ─── Project Agent ───────────────────────────────────────
  projectAgent: {
    beginTask: (request: ProjectAgentBeginTaskRequest) =>
      ipcRenderer.invoke('projectAgent:beginTask', request),
    acquireLease: (projectId: string, taskId: string) =>
      ipcRenderer.invoke('projectAgent:acquireLease', projectId, taskId),
    releaseLease: (leaseToken: string) =>
      ipcRenderer.invoke('projectAgent:releaseLease', leaseToken),
    getLeaseHolder: () =>
      ipcRenderer.invoke('projectAgent:getLeaseHolder'),
    journalLoad: (projectId: string, taskId: string) =>
      ipcRenderer.invoke('projectAgent:journalLoad', projectId, taskId),
    journalSave: (record: ProjectAgentJournalRecord) =>
      ipcRenderer.invoke('projectAgent:journalSave', record),
    journalListByProject: (projectId: string) =>
      ipcRenderer.invoke('projectAgent:journalListByProject', projectId),
    publishTaskStatus: (status: ProjectAgentTaskStatusPayload) =>
      ipcRenderer.invoke('projectAgent:publishStatus', status),
    getTaskStatus: (taskId: string) =>
      ipcRenderer.invoke('projectAgent:getTaskStatus', taskId),
    sendSupplement: (taskId: string, text: string, image?: ProjectAgentImageAttachment) =>
      ipcRenderer.invoke('projectAgent:sendSupplement', taskId, text, image),
    publishSupplementResult: (payload: ProjectAgentStartResultPayload) =>
      ipcRenderer.invoke('projectAgent:supplementResult', payload),
    requestStart: (payload: ProjectAgentStartRequest) =>
      ipcRenderer.invoke('projectAgent:requestStart', payload),
    runTerminalCommand: (request: ProjectAgentTerminalCommandRequest) =>
      ipcRenderer.invoke('projectAgent:runTerminalCommand', request),
    cancelTerminalCommand: (requestId: string) =>
      ipcRenderer.invoke('projectAgent:cancelTerminalCommand', requestId),
    requestPause: (taskId: string, reason: string): Promise<ProjectAgentTaskCommandResult> =>
      ipcRenderer.invoke('projectAgent:requestPause', taskId, reason),
    requestCancel: (taskId: string): Promise<ProjectAgentTaskCommandResult> =>
      ipcRenderer.invoke('projectAgent:requestCancel', taskId),
    requestContinue: (taskId: string): Promise<ProjectAgentTaskCommandResult> =>
      ipcRenderer.invoke('projectAgent:requestContinue', taskId),
    requestDiscard: (taskId: string): Promise<ProjectAgentTaskCommandResult> =>
      ipcRenderer.invoke('projectAgent:discardTask', taskId),
    publishRestoredProject: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('projectAgent:publishRestoredProject', projectId),
    acknowledgeReport: (taskId: string): Promise<ProjectAgentAcknowledgeReportResult> =>
      ipcRenderer.invoke('projectAgent:acknowledgeReport', taskId),
    deleteConversation: (projectId: string, conversationId: string): Promise<ProjectAgentDeleteConversationResult> =>
      ipcRenderer.invoke('projectAgent:deleteConversation', projectId, conversationId),
    renameConversation: (projectId: string, conversationId: string, name: string): Promise<ProjectAgentRenameConversationResult> =>
      ipcRenderer.invoke('projectAgent:renameConversation', projectId, conversationId, name),
    switchConversation: (projectId: string, conversationId: string): Promise<ProjectAgentTaskCommandResult> =>
      ipcRenderer.invoke('projectAgent:switchConversation', projectId, conversationId),
    setAgentModel: (model: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('projectAgent:setModel', model),
    setEffort: (effort: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('projectAgent:setEffort', effort),
    requestOpenSettings: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('projectAgent:openSettings'),
    publishProjectContext: (context: ProjectAgentProjectContext): Promise<void> =>
      ipcRenderer.invoke('projectAgent:publishContext', context),
    getProjectContext: (): Promise<ProjectAgentProjectContext | null> =>
      ipcRenderer.invoke('projectAgent:getContext'),
    publishStartResult: (payload: ProjectAgentStartResultPayload): Promise<void> =>
      ipcRenderer.invoke('projectAgent:publishStartResult', payload),
    openWindow: () => ipcRenderer.invoke('projectAgent:openWindow'),
    onContext: (callback: (context: ProjectAgentProjectContext) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, context: ProjectAgentProjectContext) => callback(context);
      ipcRenderer.on('projectAgent:context', listener);
      return () => ipcRenderer.removeListener('projectAgent:context', listener);
    },
    onStartResult: (callback: (payload: ProjectAgentStartResultPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProjectAgentStartResultPayload) => callback(payload);
      ipcRenderer.on('projectAgent:startResult', listener);
      return () => ipcRenderer.removeListener('projectAgent:startResult', listener);
    },
    onStatus: (callback: (status: ProjectAgentTaskStatusPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ProjectAgentTaskStatusPayload) => callback(status);
      ipcRenderer.on('projectAgent:status', listener);
      return () => ipcRenderer.removeListener('projectAgent:status', listener);
    },
    onStartRequest: (callback: (payload: ProjectAgentStartRequest) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProjectAgentStartRequest) => callback(payload);
      ipcRenderer.on('projectAgent:startRequest', listener);
      return () => ipcRenderer.removeListener('projectAgent:startRequest', listener);
    },
    onSetModel: (callback: (model: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, model: string) => callback(model);
      ipcRenderer.on('projectAgent:setModel', listener);
      return () => ipcRenderer.removeListener('projectAgent:setModel', listener);
    },
    onSetEffort: (callback: (effort: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, effort: string) => callback(effort);
      ipcRenderer.on('projectAgent:setEffort', listener);
      return () => ipcRenderer.removeListener('projectAgent:setEffort', listener);
    },
    onSupplement: (callback: (payload: ProjectAgentSupplementRequest) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProjectAgentSupplementRequest) => callback(payload);
      ipcRenderer.on('projectAgent:supplement', listener);
      return () => ipcRenderer.removeListener('projectAgent:supplement', listener);
    },
    onCommand: (callback: (command: ProjectAgentEditorCommand) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: ProjectAgentEditorCommand) => callback(command);
      ipcRenderer.on('projectAgent:command', listener);
      return () => ipcRenderer.removeListener('projectAgent:command', listener);
    },
  },
  betaState: {
    load: (kind: 'experimental-features' | 'first-lesson') => ipcRenderer.invoke('betaState:load', kind),
    save: (kind: 'experimental-features' | 'first-lesson', value: unknown) => ipcRenderer.invoke('betaState:save', kind, value),
  },

  // ─── Collaboration Server ─────────────────────────────
  collaborationServer: {
    start: (options: { host?: string; port?: number; dataDir?: string }) =>
      ipcRenderer.invoke('collaborationServer:start', options),
    stop: () => ipcRenderer.invoke('collaborationServer:stop'),
    getStatus: () => ipcRenderer.invoke('collaborationServer:getStatus'),
    listSessions: () => ipcRenderer.invoke('collaborationServer:listSessions'),
    clearPreviousSessions: () => ipcRenderer.invoke('collaborationServer:clearPreviousSessions'),
  },

  // ─── Video Export ──────────────────────────────────────
  export: {
    saveVideo: (videoBuffer: ArrayBuffer, outputPath: string) =>
      ipcRenderer.invoke('export:saveVideo', videoBuffer, outputPath),
    convert: (inputPath: string, outputPath: string, options?: Parameters<AeonStageryElectronAPI['export']['convert']>[2]) =>
      ipcRenderer.invoke('ffmpeg:convert', inputPath, outputPath, options),
    getTempDir: () => ipcRenderer.invoke('ffmpeg:getTempDir'),
    startStreamExport: (outputPath: string, options?: Parameters<AeonStageryElectronAPI['export']['startStreamExport']>[1]) =>
      ipcRenderer.invoke('ffmpeg:startStreamExport', outputPath, options),
    pushFrame: (frameData: Uint8Array | Uint8ClampedArray) =>
      ipcRenderer.invoke('ffmpeg:pushFrame', frameData),
    pushEncodedChunk: (chunkData: Uint8Array) =>
      ipcRenderer.invoke('ffmpeg:pushEncodedChunk', chunkData),
    endStreamExport: () =>
      ipcRenderer.invoke('ffmpeg:endStreamExport'),
    cancelExport: () => ipcRenderer.invoke('ffmpeg:cancelExport'),
    onLog: (callback: (msg: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, msg: string) => callback(msg);
      ipcRenderer.on('ffmpeg:log', listener);
      return () => ipcRenderer.removeListener('ffmpeg:log', listener);
    }
  },
  
  // ─── Path Utils ────────────────────────────────────────
  path: {
    join: (...args: string[]) => ipcRenderer.invoke('path:join', args),
    dirname: (targetPath: string) => ipcRenderer.invoke('path:dirname', targetPath),
    basename: (targetPath: string) => ipcRenderer.invoke('path:basename', targetPath),
    extname: (targetPath: string) => ipcRenderer.invoke('path:extname', targetPath),
    relative: (fromPath: string, toPath: string) => ipcRenderer.invoke('path:relative', fromPath, toPath),
    normalize: (targetPath: string) => ipcRenderer.invoke('path:normalize', targetPath),
    isAbsolute: (targetPath: string) => ipcRenderer.invoke('path:isAbsolute', targetPath),
  },

  // ─── Updates ──────────────────────────────────────────
  updater: {
    getState: () => ipcRenderer.invoke('updater:getState'),
    checkForUpdates: (source?: 'oss' | 'github') => ipcRenderer.invoke('updater:checkForUpdates', source),
    downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('updater:installUpdate'),
    onStatus: (callback: (status: UpdateStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
  },

  // ─── GPT-SoVITS ───────────────────────────────────────
  gptSovits: {
    status: (config: Parameters<AeonStageryElectronAPI['gptSovits']['status']>[0]) =>
      ipcRenderer.invoke('gptSovits:status', config),
    start: (config: Parameters<AeonStageryElectronAPI['gptSovits']['start']>[0]) =>
      ipcRenderer.invoke('gptSovits:start', config),
    stop: () =>
      ipcRenderer.invoke('gptSovits:stop'),
    generateDialogueVoice: (input: Parameters<AeonStageryElectronAPI['gptSovits']['generateDialogueVoice']>[0]) =>
      ipcRenderer.invoke('gptSovits:generateDialogueVoice', input),
  },

  voiceAuthoring: {
    scanCatalog: (request: Parameters<AeonStageryElectronAPI['voiceAuthoring']['scanCatalog']>[0]) => ipcRenderer.invoke('voiceAuthoring:scanCatalog', request),
    pickReferenceAudio: (multiple: boolean) => ipcRenderer.invoke('voiceAuthoring:pickReferenceAudio', multiple),
    listPresets: () => ipcRenderer.invoke('voiceAuthoring:listPresets'),
    resolveReference: (presetId: string, referenceId: string) => ipcRenderer.invoke('voiceAuthoring:resolveReference', presetId, referenceId),
    savePreset: (request: Parameters<AeonStageryElectronAPI['voiceAuthoring']['savePreset']>[0]) => ipcRenderer.invoke('voiceAuthoring:savePreset', request),
    renamePreset: (presetId: string, name: string) => ipcRenderer.invoke('voiceAuthoring:renamePreset', presetId, name),
    duplicatePreset: (presetId: string, name?: string) => ipcRenderer.invoke('voiceAuthoring:duplicatePreset', presetId, name),
    deletePreset: (presetId: string) => ipcRenderer.invoke('voiceAuthoring:deletePreset', presetId),
    publishTemplateProfile: (presetId: string) => ipcRenderer.invoke('voiceAuthoring:publishTemplateProfile', presetId),
    generateCandidate: (request: Parameters<AeonStageryElectronAPI['voiceAuthoring']['generateCandidate']>[0]) => ipcRenderer.invoke('voiceAuthoring:generateCandidate', request),
    clearSession: (sessionId: string) => ipcRenderer.invoke('voiceAuthoring:clearSession', sessionId),
  },

  workspaceTools: {
    open: () => ipcRenderer.invoke('workspaceTools:open'),
    close: () => ipcRenderer.invoke('workspaceTools:close'),
    getWindowState: () => ipcRenderer.invoke('workspaceTools:getWindowState'),
    requestSnapshot: () => ipcRenderer.invoke('workspaceTools:requestSnapshot'),
    publishSnapshot: (snapshot: WorkspaceToolsSnapshot) => {
      ipcRenderer.send('workspaceTools:publishSnapshot', snapshot);
    },
    publishRuntime: (snapshot: WorkspaceRuntimeSnapshot) => {
      ipcRenderer.send('workspaceTools:publishRuntime', snapshot);
    },
    publishCommandResult: (result: WorkspaceToolsCommandResult) => {
      ipcRenderer.send('workspaceTools:commandResult', result);
    },
    sendCommand: (command: WorkspaceToolsCommand) => {
      ipcRenderer.send('workspaceTools:command', command);
    },
    onSnapshot: (callback: (snapshot: WorkspaceToolsSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: WorkspaceToolsSnapshot) => callback(snapshot);
      ipcRenderer.on('workspaceTools:snapshot', listener);
      return () => ipcRenderer.removeListener('workspaceTools:snapshot', listener);
    },
    onRuntime: (callback: (snapshot: WorkspaceRuntimeSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: WorkspaceRuntimeSnapshot) => callback(snapshot);
      ipcRenderer.on('workspaceTools:runtime', listener);
      return () => ipcRenderer.removeListener('workspaceTools:runtime', listener);
    },
    onCommand: (callback: (command: WorkspaceToolsCommand) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: WorkspaceToolsCommand) => callback(command);
      ipcRenderer.on('workspaceTools:command', listener);
      return () => ipcRenderer.removeListener('workspaceTools:command', listener);
    },
    onCommandResult: (callback: (result: WorkspaceToolsCommandResult) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: WorkspaceToolsCommandResult) => callback(result);
      ipcRenderer.on('workspaceTools:commandResult', listener);
      return () => ipcRenderer.removeListener('workspaceTools:commandResult', listener);
    },
    onSnapshotRequest: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('workspaceTools:requestSnapshot', listener);
      return () => ipcRenderer.removeListener('workspaceTools:requestSnapshot', listener);
    },
    onWindowState: (callback: (state: WorkspaceToolsWindowState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: WorkspaceToolsWindowState) => callback(state);
      ipcRenderer.on('workspaceTools:windowState', listener);
      return () => ipcRenderer.removeListener('workspaceTools:windowState', listener);
    },
  },
} satisfies AeonStageryElectronAPI;

contextBridge.exposeInMainWorld('aeonStageryAPI', electronAPI);
