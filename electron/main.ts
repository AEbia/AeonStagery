import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  safeStorage,
  screen,
  shell,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { autoUpdater, NsisUpdater } from 'electron-updater';
import { registerFFmpegHandlers } from './ffmpeg-export';
import { toUpdateCheckOutcome } from './updaterCheckResult';
import {
  enforceDifferentialOnlyDownload,
  type DifferentialDownloadCapableUpdater,
} from './updaterDownloadPolicy';
import { enforceVerifiedInstallerCache, type VerifiedCacheCapableUpdater } from './updaterDownloadCache';
import { createUpdateFeedOptions } from './updaterFeed';
import { GitHubReleaseProvider } from './githubReleaseProvider';
import { UpdateCoordinator } from './updateCoordinator';
import type { UpdateSource } from '../src/api/types/updater';
import { registerGptSovitsHandlers, stopGptSovitsProcess } from './gpt-sovits';
import { clearAllVoiceSessionsSync, registerVoiceAuthoringHandlers } from './voice-authoring';
import type { CollaborationServerStatus } from '../server/collaboration/server';
import { isCollaborationOriginAllowed } from '../server/collaboration/security';
import { EmbeddedCollaborationServer } from './embeddedCollaborationServer';
import {
  listCollaborationSessions,
} from '../server/collaboration/sessionStore';
import type {
  WorkspaceRuntimeSnapshot,
  WorkspaceToolsCommand,
  WorkspaceToolsCommandResult,
  WorkspaceToolsSnapshot,
} from '../src/ui/workspace-tools/types';
import {
  AI_PROSE_STAGES,
  AI_PROSE_EFFORTS,
  type AiProseCapabilityProbeRequest,
  type AiProseCredentialStatus,
  type AiProseModelMetadata,
  type AiProseModelCapabilities,
  type AiProseModelListResult,
  type AiProseProviderConfig,
  type AiProseStage,
} from '../src/api/types/ai-prose-authoring';
import type {
  AiProseLlmProgress,
  AiProseLlmRequest,
  AiProseLlmResponse,
  AiProseLlmProgressError,
} from '../src/services/ai-authoring/AiProseContracts';
import {
  estimateAiProseTokenCount,
  parseAiProseModelListPayload,
} from '../src/services/ai-authoring/AiProseContracts';
import {
  extractAiProseModel,
  extractAiProseUsage,
  readAiProseStreamingResponse,
} from './aiProseStream';
import {
  AI_PROSE_REQUEST_START_TIMEOUT_MS,
  AI_PROSE_STREAM_IDLE_TIMEOUT_MS,
  AiProseStreamIdleTimeoutError,
  aiProseRequestMatchesConfiguredProvider,
  buildAiProseCapabilityProbeRequest,
  isAiProseStreamAbortFailure,
  listModelsMaySendCredential,
  normalizeAiProseProviderEndpoint,
  resolveAiProseCompletionEndpoint,
  resolveAiProseModelsEndpoints,
  validateAiProseProviderEndpoint,
} from './aiProseProviderSafety';
import { replaceFileWithPlatformCompatibility } from './file-replacement';
import {
  inspectTemplatePackageArchive,
  installTemplatePackageArchive,
  TemplatePackageAlreadyInstalledError,
} from './template-package-import';
import {
  AiConversationRequestCoordinator,
  type AiConversationRequestRegistration,
} from './aiConversationRequestCoordinator';
import {
  aiConversationRequestMatchesConfiguredProvider,
  completeAiConversationRequest,
  setAiConversationLogSink,
  validateAiConversationIpcRequest,
} from './aiConversationProvider';
import type { AiConversationIpcResult } from '../src/api/types/ai-conversation-ipc';
import type { AiConversationCancelResult } from '../src/services/ai-authoring/AiConversationTransport';
import { AiConversationTransportError } from '../src/services/ai-authoring/AiConversationTransport';
import type {
  ProjectAgentBeginTaskRequest,
  ProjectAgentProjectContext,
  ProjectAgentStartRequest,
  ProjectAgentTerminalCommandRequest,
  ProjectAgentTaskStatusPayload,
} from '../src/api/types/project-agent-ipc';
import {
  ProjectAgentTaskCoordinator,
  type ProjectAgentEditorRelayPort,
  type ProjectAgentWindowController,
} from '../src/services/project-agent-service/ProjectAgentTaskCoordinator';
import { FileSystemProjectAgentJournalPort } from '../src/services/project-agent-service/FileSystemProjectAgentJournalPort';
import type { ProjectAgentJournalRecord } from '../src/services/project-agent/ProjectAgentJournal';
import type { ProjectAgentPauseReason } from '../src/services/project-agent/ProjectAgentTask';
import { NodeProjectAgentTerminalExecutor } from './projectAgentTerminal';
import {
  ensureLive2DRuntimeFiles,
  inspectLive2DRuntimeStatus,
  syncLocalRuntimeToSeedRoot,
  type Live2DRuntimeAvailabilityReport,
  type Live2DRuntimeStatusDetail,
} from './live2dRuntimeSeed';
import { handleAssetProtocolRequest } from './assetProtocol';

interface AiProseCredentialMutationResult {
  success: boolean;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let workspaceToolsWindow: BrowserWindow | null = null;
let agentWindow: BrowserWindow | null = null;
let updateCoordinator: UpdateCoordinator | null = null;
const embeddedCollaborationServer = new EmbeddedCollaborationServer();
let projectAgentTaskCoordinator: ProjectAgentTaskCoordinator | null = null;
const projectAgentTerminalExecutor = new NodeProjectAgentTerminalExecutor();

const isDev = !app.isPackaged;
const isE2E = process.env.AEON_E2E === '1';
const loadFromDist = !isDev || process.env.AEON_E2E_LOAD_DIST === '1' || isE2E;
/**
 * Optional runtime override for the update feed. The packaged app normally resolves its
 * feed from `resources/app-update.yml`, which electron-builder emits from `build.publish`.
 */
const updateFeedUrlOverride = process.env.APP_UPDATE_URL?.trim();
const bundledUpdateConfigPath = path.join(process.resourcesPath, 'app-update.yml');

function hasBundledUpdateConfig(): boolean {
  if (isDev) return false;
  try {
    return fs.existsSync(bundledUpdateConfigPath);
  } catch {
    return false;
  }
}

function getUpdateFeedBaseUrl(): string | undefined {
  if (updateFeedUrlOverride) return updateFeedUrlOverride;
  try {
    const config = fs.readFileSync(bundledUpdateConfigPath, 'utf8');
    const provider = /^provider:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(config)?.[1]?.trim();
    const url = /^url:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(config)?.[1]?.trim();
    return provider === 'generic' && url ? url : undefined;
  } catch {
    return undefined;
  }
}

const isUpdateSourceConfigured = !isDev && (Boolean(updateFeedUrlOverride) || hasBundledUpdateConfig());

/**
 * User-owned Live2D runtime root under userData. Update safety (ADR-0035):
 * seeding into it is additive-only, and this directory name, the
 * `aeon-runtime://` scheme and `build.productName` must never change once
 * released — renaming any of them would orphan a runtime the user installed.
 */
const live2dRuntimeDirectoryName = 'live2d-runtime';
let live2DRuntimeAvailability: Live2DRuntimeAvailabilityReport | null = null;
const aiProseCredentialFileName = 'ai-prose-credential.json';
const aiProseCredentialSchemaVersion = 1;

let aiProseCredentialLoaded = false;
let aiProseCredential: string | undefined;
let aiProseCredentialLoadPromise: Promise<string | undefined> | undefined;
let aiProseProvider: AiProseProviderConfig | undefined;
const aiProseModelMetadataByEndpoint = new Map<string, Record<string, AiProseModelMetadata>>();
/** Deduplicates the one-time-per-endpoint model-metadata refresh attempts. */
const aiProseModelMetadataInFlight = new Map<string, Promise<void>>();
/** Abort controllers for in-flight AI prose completions keyed by requestId. */
const aiProseInFlightControllers = new Map<string, AbortController>();
const aiConversationCoordinator = new AiConversationRequestCoordinator();
const aiConversationFrameIdByWebContents = new Map<number, number>();

/**
 * Mirrors AI LLM debug logs (prose + conversation) to every renderer's
 * DevTools console via the `aiDebug:log` channel, so they are visible
 * without reading the main-process terminal.
 */
function broadcastAiLlmDebugLog(tag: string, payload: unknown): void {
  const entry = { tag, payload };
  for (const target of [mainWindow, agentWindow]) {
    if (target && !target.isDestroyed()) {
      target.webContents.send('aiDebug:log', entry);
    }
  }
}

function logAiProseDebug(tag: string, payload: unknown): void {
  console.info(`[AI prose] ${tag}`, payload);
  broadcastAiLlmDebugLog(tag, payload);
}

function getLive2DRuntimeSeedRoot(): string {
  return isDev
    ? path.join(app.getAppPath(), 'public')
    : path.join(process.resourcesPath, live2dRuntimeDirectoryName);
}

function getLive2DRuntimeRoot(): string {
  return path.join(app.getPath('userData'), live2dRuntimeDirectoryName);
}

function getLive2DLocalDir(): string {
  return path.join(app.getAppPath(), '.local', 'live2d');
}

/**
 * Runtime seeding is optional at app startup. Filesystem failures are scoped
 * to this feature so unrelated main-process failures retain Electron's normal
 * crash semantics.
 */
function ensureLive2DRuntime(): Live2DRuntimeAvailabilityReport {
  try {
    return ensureLive2DRuntimeFiles(getLive2DRuntimeSeedRoot(), getLive2DRuntimeRoot());
  } catch (error) {
    console.error('[Live2D] Failed to seed runtime files; continuing without them:', error);
    return { cubism2: false, cubism3Plus: false };
  }
}

function getDevRendererUrl(): URL {
  const configuredUrl =
    process.env.AEON_RENDERER_URL?.trim() ||
    process.env.VITE_DEV_SERVER_URL?.trim() ||
    'http://127.0.0.1:5173';
  return new URL(configuredUrl);
}

// Isolate e2e runs from the developer's real userData profile.
if (process.env.AEON_E2E_USER_DATA) {
  app.setPath('userData', process.env.AEON_E2E_USER_DATA);
}

// Enable hardware acceleration for WebCodecs
app.commandLine.appendSwitch('enable-webcodecs');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

function loadRenderer(window: BrowserWindow, query?: Record<string, string>): Promise<void> {
  if (!loadFromDist) {
    const rendererUrl = getDevRendererUrl();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        rendererUrl.searchParams.set(key, value);
      }
    }
    return window.loadURL(rendererUrl.toString());
  }
  const indexHtml = path.join(__dirname, '../dist/index.html');
  if (query) {
    return window.loadFile(indexHtml, { query });
  }
  return window.loadFile(indexHtml);
}

function getAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, '../build/icon.png'),
    path.join(__dirname, '../public/icon.png'),
    path.join(__dirname, '../dist/icon.png'),
    path.join(app.getAppPath(), 'build/icon.png'),
    path.join(app.getAppPath(), 'dist/icon.png'),
    path.join(app.getAppPath(), 'public/icon.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 960,
    minHeight: 540,
    title: 'AeonStagery',
    icon: getAppIconPath(),
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      experimentalFeatures: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Force secure context for file:// and custom schemes
  void loadRenderer(mainWindow);
  if (isDev && !isE2E && !loadFromDist) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    if (workspaceToolsWindow && !workspaceToolsWindow.isDestroyed()) {
      workspaceToolsWindow.close();
    }
    mainWindow = null;
  });

  // Editor renderer reload/close: main aborts its provider requests (below)
  // and pauses any running project Agent task at the main-side boundary —
  // releasing the lease and marking the journal paused without ever guessing
  // scene state or transferring mutation ownership (ADR0023).
  mainWindow.webContents.on('did-navigate', () => {
    void getProjectAgentTaskCoordinator().pauseTasksForRendererLoss('renderer_reloaded');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void getProjectAgentTaskCoordinator().pauseTasksForRendererLoss('renderer_reloaded');
    if (details.reason !== 'clean-exit') {
      const reportId = `crash-hard-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      const report = {
        reportId,
        timestamp: new Date().toISOString(),
        tier: 3,
        surface: 'editor',
        error: {
          name: 'RenderProcessGone',
          message: `Renderer process terminated unexpectedly (Reason: ${details.reason}, ExitCode: ${details.exitCode})`,
        },
        environment: {
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron,
          chromeVersion: process.versions.chrome,
          nodeVersion: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        breadcrumbs: [],
        redacted: true,
      };
      void writeCrashReportFiles(report);
      if (mainWindow && !mainWindow.isDestroyed()) {
        const distFallback = path.join(__dirname, '../dist/crash-fallback.html');
        const publicFallback = path.join(__dirname, '../public/crash-fallback.html');
        const fallbackPath = fs.existsSync(distFallback) ? distFallback : publicFallback;
        if (fs.existsSync(fallbackPath)) {
          void mainWindow.loadFile(fallbackPath, { query: { reportId, reason: details.reason } });
        }
      }
    }
  });
  mainWindow.on('closed', () => {
    void getProjectAgentTaskCoordinator().pauseTasksForRendererLoss('application_exit');
  });

  wireAiConversationWebContentsLifetime(mainWindow.webContents);
}

function getWorkspaceToolsBoundsPath(): string {
  return path.join(app.getPath('userData'), 'workspace-tools-window.json');
}

function clampWorkspaceToolsBounds(bounds: Rectangle): Rectangle {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = Math.max(480, Math.min(bounds.width, workArea.width));
  const height = Math.max(600, Math.min(bounds.height, workArea.height));
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

function loadWorkspaceToolsBounds(): Rectangle | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWorkspaceToolsBoundsPath(), 'utf8'));
    if (
      typeof parsed?.x === 'number'
      && typeof parsed?.y === 'number'
      && typeof parsed?.width === 'number'
      && typeof parsed?.height === 'number'
    ) {
      return clampWorkspaceToolsBounds(parsed);
    }
  } catch {
    // First launch or invalid state; use defaults.
  }
  return null;
}

function saveWorkspaceToolsBounds(bounds: Rectangle) {
  try {
    fs.writeFileSync(getWorkspaceToolsBoundsPath(), JSON.stringify(bounds), 'utf8');
  } catch (error) {
    console.warn('[WorkspaceTools] Failed to persist bounds:', error);
  }
}

function notifyWorkspaceToolsWindowState(open: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('workspaceTools:windowState', { open });
}

function isMainWindowSender(senderId: number): boolean {
  return !!mainWindow
    && !mainWindow.isDestroyed()
    && senderId === mainWindow.webContents.id;
}

function isMainWindowFrameSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): boolean {
  const window = mainWindow;
  return !!window
    && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
}

function isWorkspaceToolsWindowSender(senderId: number): boolean {
  return !!workspaceToolsWindow
    && !workspaceToolsWindow.isDestroyed()
    && senderId === workspaceToolsWindow.webContents.id;
}

function isAiConversationSenderFrame(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): boolean {
  const senderId = event.sender.id;
  const window = senderId === mainWindow?.webContents.id
    ? mainWindow
    : senderId === workspaceToolsWindow?.webContents.id
      ? workspaceToolsWindow
      : null;
  return !!window
    && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
}

function wireAiConversationWebContentsLifetime(webContents: WebContents): void {
  webContents.on('destroyed', () => {
    aiConversationCoordinator.abortWebContents(webContents.id);
    aiConversationFrameIdByWebContents.delete(webContents.id);
  });
  webContents.on('render-process-gone', () => {
    aiConversationCoordinator.abortWebContents(webContents.id);
  });
  webContents.on('did-navigate', () => {
    aiConversationCoordinator.abortWebContents(webContents.id);
  });
}

function createWorkspaceToolsWindow(): BrowserWindow {
  if (workspaceToolsWindow && !workspaceToolsWindow.isDestroyed()) {
    workspaceToolsWindow.show();
    workspaceToolsWindow.focus();
    return workspaceToolsWindow;
  }

  const savedBounds = loadWorkspaceToolsBounds();
  workspaceToolsWindow = new BrowserWindow({
    width: savedBounds?.width ?? 680,
    height: savedBounds?.height ?? 860,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 480,
    minHeight: 600,
    title: 'AeonStagery 工作区工具',
    icon: getAppIconPath(),
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  workspaceToolsWindow.setMenuBarVisibility(false);
  workspaceToolsWindow.removeMenu();

  void loadRenderer(workspaceToolsWindow, { surface: 'workspace-tools' });

  workspaceToolsWindow.once('ready-to-show', () => {
    workspaceToolsWindow?.show();
    workspaceToolsWindow?.focus();
  });

  workspaceToolsWindow.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.send('workspaceTools:requestSnapshot');
  });

  workspaceToolsWindow.on('close', () => {
    if (workspaceToolsWindow && !workspaceToolsWindow.isDestroyed()) {
      saveWorkspaceToolsBounds(workspaceToolsWindow.getBounds());
    }
  });

  workspaceToolsWindow.on('closed', () => {
    workspaceToolsWindow = null;
    notifyWorkspaceToolsWindowState(false);
  });

  wireAiConversationWebContentsLifetime(workspaceToolsWindow.webContents);

  notifyWorkspaceToolsWindowState(true);
  return workspaceToolsWindow;
}

function sendUpdateStatus(channel: string, payload: Record<string, unknown>) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

// ─── Project Agent window ─────────────────────────────────

function getAgentWindowBoundsPath(): string {
  return path.join(app.getPath('userData'), 'project-agent-window.json');
}

function loadAgentWindowBounds(): Rectangle | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAgentWindowBoundsPath(), 'utf8'));
    if (
      typeof parsed?.x === 'number'
      && typeof parsed?.y === 'number'
      && typeof parsed?.width === 'number'
      && typeof parsed?.height === 'number'
    ) {
      return clampWorkspaceToolsBounds(parsed);
    }
  } catch {
    // First launch or invalid state; use defaults.
  }
  return null;
}

function saveAgentWindowBounds(bounds: Rectangle) {
  try {
    fs.writeFileSync(getAgentWindowBoundsPath(), JSON.stringify(bounds), 'utf8');
  } catch (error) {
    console.warn('[ProjectAgent] Failed to persist window bounds:', error);
  }
}

function createAgentWindow(): BrowserWindow {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.show();
    agentWindow.focus();
    return agentWindow;
  }

  const savedBounds = loadAgentWindowBounds();
  agentWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 800,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 420,
    minHeight: 480,
    title: 'AeonStagery 项目 Agent',
    icon: getAppIconPath(),
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  agentWindow.setMenuBarVisibility(false);
  agentWindow.removeMenu();

  void loadRenderer(agentWindow, { surface: 'agent' });

  agentWindow.once('ready-to-show', () => {
    agentWindow?.show();
    agentWindow?.focus();
  });

  agentWindow.on('minimize', () => {
    // ADR0023: minimizing the Agent window never affects the running task.
    void getProjectAgentTaskCoordinator().onAgentWindowStateChange('minimized');
  });

  agentWindow.on('close', () => {
    if (agentWindow && !agentWindow.isDestroyed()) {
      saveAgentWindowBounds(agentWindow.getBounds());
    }
    // ADR0023: closing the window stops scheduling and pauses at the editor's
    // safe point (falling back to lease/journal pause when the editor renderer
    // is unavailable). Mutation ownership never moves to main.
    void getProjectAgentTaskCoordinator().onAgentWindowStateChange('closed');
  });

  agentWindow.on('closed', () => {
    agentWindow = null;
  });

  wireAiConversationWebContentsLifetime(agentWindow.webContents);
  return agentWindow;
}


function isAgentWindowFrameSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): boolean {
  const window = agentWindow;
  return !!window
    && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
}

function getProjectAgentTaskCoordinator(): ProjectAgentTaskCoordinator {
  if (projectAgentTaskCoordinator) return projectAgentTaskCoordinator;
  const windowController: ProjectAgentWindowController = {
    openAgentWindow: () => {
      createAgentWindow();
    },
    sendToAgentWindow: (status) => {
      if (!agentWindow || agentWindow.isDestroyed()) return;
      agentWindow.webContents.send('projectAgent:status', status);
    },
    sendContextToAgentWindow: (context) => {
      if (!agentWindow || agentWindow.isDestroyed()) return;
      agentWindow.webContents.send('projectAgent:context', context);
    },
    sendStartResultToAgentWindow: (payload) => {
      if (!agentWindow || agentWindow.isDestroyed()) return;
      agentWindow.webContents.send('projectAgent:startResult', payload);
    },
  };
  // The editor renderer is the sole task-lifecycle/mutation owner: main only
  // relays pause/cancel/continue commands and falls back to its own
  // lease/journal pause when the editor renderer is unavailable.
  const editorRelay: ProjectAgentEditorRelayPort = {
    sendCommand: (command) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return false;
      }
      mainWindow.webContents.send('projectAgent:command', command);
      return true;
    },
    sendModel: (model) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return false;
      }
      mainWindow.webContents.send('projectAgent:setModel', model);
      return true;
    },
    sendEffort: (effort) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return false;
      }
      mainWindow.webContents.send('projectAgent:setEffort', effort);
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

function setupAutoUpdater() {
  if (isDev) return;
  if (!isUpdateSourceConfigured) {
    console.log(
      '[Updater] No update source configured: APP_UPDATE_URL is unset and resources/app-update.yml is missing. Auto update is disabled.',
    );
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = console;
  if (updateFeedUrlOverride) {
    autoUpdater.setFeedURL(createUpdateFeedOptions(updateFeedUrlOverride, app.getVersion()));
  }

  const differentialGuardInstalled = enforceDifferentialOnlyDownload(
    autoUpdater as unknown as DifferentialDownloadCapableUpdater,
  );
  const cacheGuardInstalled = enforceVerifiedInstallerCache(
    autoUpdater as unknown as VerifiedCacheCapableUpdater,
  );
  const guardInstalled = differentialGuardInstalled && cacheGuardInstalled;
  if (!guardInstalled) {
    console.error('[Updater] Verified differential download hooks are unavailable; OSS downloads are disabled.');
  }

  // The custom provider reads GitHub releases instead of requiring beta.yml.
  // GitHub blockmaps are preferred; missing maps are borrowed from the same
  // version on the configured generic feed.
  const fallbackBlockMapBaseUrl = getUpdateFeedBaseUrl();
  const githubUpdater = process.platform === 'win32'
    ? new NsisUpdater({ provider: 'custom', updateProvider: GitHubReleaseProvider, fallbackBlockMapBaseUrl })
    : undefined;
  const githubDifferentialGuardInstalled = githubUpdater
    ? enforceDifferentialOnlyDownload(githubUpdater as unknown as DifferentialDownloadCapableUpdater)
    : false;
  const githubCacheGuardInstalled = githubUpdater
    ? enforceVerifiedInstallerCache(githubUpdater as unknown as VerifiedCacheCapableUpdater)
    : false;
  if (githubUpdater) {
    githubUpdater.autoDownload = false;
    githubUpdater.autoInstallOnAppQuit = false;
    githubUpdater.disableDifferentialDownload = false;
    githubUpdater.disableWebInstaller = true;
    githubUpdater.logger = console;
    if (!githubDifferentialGuardInstalled || !githubCacheGuardInstalled) {
      console.error('[Updater] Verified differential download hooks are unavailable; GitHub downloads are disabled.');
    }
  }
  updateCoordinator = new UpdateCoordinator(
    { oss: guardInstalled ? autoUpdater : undefined,
      github: githubDifferentialGuardInstalled && githubCacheGuardInstalled ? githubUpdater : undefined },
    (status) => sendUpdateStatus('updater:status', { ...status }),
  );
}

// ─── IPC Handlers ──────────────────────────────────────────────

function resolveFileSystemPath(filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('File path must be a non-empty string');
  }
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(app.getAppPath(), filePath);
}

function getAiProseCredentialPath(): string {
  return path.join(app.getPath('userData'), aiProseCredentialFileName);
}

function isAiProseCredentialAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function loadAiProseCredential(): Promise<string | undefined> {
  if (aiProseCredentialLoaded) return aiProseCredential;
  if (aiProseCredentialLoadPromise) return aiProseCredentialLoadPromise;

  aiProseCredentialLoadPromise = (async () => {
    if (!isAiProseCredentialAvailable()) return undefined;

    try {
      const serialized = await fs.promises.readFile(getAiProseCredentialPath(), 'utf8');
      const parsed = JSON.parse(serialized) as {
        schemaVersion?: unknown;
        ciphertext?: unknown;
      };
      if (parsed.schemaVersion !== aiProseCredentialSchemaVersion || typeof parsed.ciphertext !== 'string') {
        return undefined;
      }
      const decrypted = safeStorage.decryptString(Buffer.from(parsed.ciphertext, 'base64'));
      if (decrypted.trim().length > 0) aiProseCredential = decrypted;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.warn('[AI prose] Stored credential could not be loaded.');
      }
    }

    return aiProseCredential;
  })().finally(() => {
    aiProseCredentialLoaded = true;
    aiProseCredentialLoadPromise = undefined;
  });

  return aiProseCredentialLoadPromise;
}

async function setAiProseCredential(value: string): Promise<AiProseCredentialMutationResult> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { success: false, error: 'Credential must be a non-empty string.' };
  }
  if (!isAiProseCredentialAvailable()) {
    return { success: false, error: 'OS credential encryption is unavailable.' };
  }
  await loadAiProseCredential();

  const credentialPath = getAiProseCredentialPath();
  const temporaryPath = `${credentialPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const ciphertext = safeStorage.encryptString(value).toString('base64');
    await fs.promises.mkdir(path.dirname(credentialPath), { recursive: true });
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({ schemaVersion: aiProseCredentialSchemaVersion, ciphertext }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await replaceFileWithPlatformCompatibility(temporaryPath, credentialPath);
    aiProseCredential = value;
    aiProseCredentialLoaded = true;
    return { success: true };
  } catch (error: any) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    return { success: false, error: error?.message ?? String(error) };
  }
}

async function clearAiProseCredential(): Promise<AiProseCredentialMutationResult> {
  try {
    await loadAiProseCredential();
    await fs.promises.rm(getAiProseCredentialPath(), { force: true });
    aiProseCredential = undefined;
    aiProseCredentialLoaded = true;
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) };
  }
}

function validateAiProseProvider(value: unknown): AiProseProviderConfig {
  if (!isRecord(value)) throw new Error('Invalid AI prose provider configuration.');
  if (typeof value.defaultModel !== 'string' || value.defaultModel.trim().length === 0) {
    throw new Error('AI prose provider defaultModel must be a non-empty string.');
  }
  if (value.projectAgentModel !== undefined
    && (typeof value.projectAgentModel !== 'string' || value.projectAgentModel.trim().length === 0)) {
    throw new Error('AI prose provider projectAgentModel must be a non-empty string.');
  }
  const projectAgentModel = typeof value.projectAgentModel === 'string'
    && value.projectAgentModel.trim().length > 0
    ? value.projectAgentModel.trim()
    : undefined;
  const modelOverrides: Partial<Record<AiProseStage, string>> = {};
  if (value.modelOverrides !== undefined) {
    if (!isRecord(value.modelOverrides)) throw new Error('AI prose provider modelOverrides must be an object.');
    for (const [stage, model] of Object.entries(value.modelOverrides)) {
      if (!AI_PROSE_STAGES.includes(stage as AiProseStage)) {
        throw new Error(`AI prose provider modelOverrides contains invalid stage: ${stage}`);
      }
      if (typeof model !== 'string' || model.trim().length === 0) {
        throw new Error(`AI prose provider modelOverrides.${stage} must be a non-empty string.`);
      }
      modelOverrides[stage as AiProseStage] = model.trim();
    }
  }
  if (value.jsonOutputSupported !== undefined && typeof value.jsonOutputSupported !== 'boolean') {
    throw new Error('AI prose provider jsonOutputSupported must be a boolean.');
  }
  return {
    endpoint: validateAiProseProviderEndpoint(value.endpoint),
    defaultModel: value.defaultModel.trim(),
    ...(projectAgentModel !== undefined ? { projectAgentModel } : {}),
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
    jsonOutputSupported: value.jsonOutputSupported === true,
  };
}

function getAiProseModelContextWindow(endpoint: string, model: string): number | undefined {
  const metadata = aiProseModelMetadataByEndpoint.get(normalizeAiProseProviderEndpoint(endpoint));
  const contextWindow = metadata?.[model]?.contextWindow;
  return typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
}

function rememberAiProseModelMetadata(
  endpoint: string,
  metadata: Record<string, AiProseModelMetadata> | undefined,
): void {
  aiProseModelMetadataByEndpoint.set(
    normalizeAiProseProviderEndpoint(endpoint),
    metadata ?? {},
  );
}

/** Bound for the lazy one-time /models metadata refresh attempt. */
const AI_PROSE_MODEL_METADATA_REFRESH_TIMEOUT_MS = 8_000;

/**
 * Best-effort one-time-per-endpoint provider /models metadata refresh. The
 * capability probe and request context-window lookup consume this metadata,
 * so it must be populated even when the user never opened the settings model
 * list. The caller waits at most `AI_PROSE_MODEL_METADATA_REFRESH_TIMEOUT_MS`;
 * a fetch that settles later still records metadata for later requests, and
 * a timed-out or failed attempt is remembered as empty so a provider without
 * a responsive /models is not re-fetched on every request. The interactive
 * "获取模型" button remains the on-demand refresh path.
 */
async function ensureAiProseModelMetadata(endpoint: string): Promise<void> {
  const provider = aiProseProvider;
  if (!provider) return;
  const key = normalizeAiProseProviderEndpoint(endpoint);
  if (aiProseModelMetadataByEndpoint.has(key)) return;
  const inFlight = aiProseModelMetadataInFlight.get(key);
  if (inFlight) return inFlight;
  const attempt = (async () => {
    const fetchAttempt = listAiProseModels(endpoint)
      .then((result) => {
        rememberAiProseModelMetadata(key, result.success ? result.modelMetadata : undefined);
        return result;
      })
      .catch(() => {
        rememberAiProseModelMetadata(key, undefined);
      });
    await Promise.race([
      fetchAttempt,
      new Promise<'metadata_refresh_timeout'>((resolve) => {
        setTimeout(() => resolve('metadata_refresh_timeout'), AI_PROSE_MODEL_METADATA_REFRESH_TIMEOUT_MS);
      }),
    ]);
    if (!aiProseModelMetadataByEndpoint.has(key)) {
      // The caller timed out before the fetch settled: remember empty so this
      // session never re-attempts the unresponsive /models endpoint.
      rememberAiProseModelMetadata(key, undefined);
    }
  })();
  aiProseModelMetadataInFlight.set(key, attempt);
  try {
    return await attempt;
  } finally {
    aiProseModelMetadataInFlight.delete(key);
  }
}

function resolveConfiguredAiProseRequest(request: AiProseLlmRequest): {
  endpoint: string;
  model: string;
  contextWindow?: number;
} {
  if (!aiProseProvider) {
    throw new Error('AI prose provider is not configured in the main process.');
  }
  if (!aiProseRequestMatchesConfiguredProvider(aiProseProvider, request)) {
    throw new Error('AI prose request does not match the configured provider.');
  }
  const configuredModel = aiProseProvider.modelOverrides?.[request.stage] ?? aiProseProvider.defaultModel;
  const contextWindow = getAiProseModelContextWindow(aiProseProvider.endpoint, configuredModel);
  return {
    endpoint: aiProseProvider.endpoint,
    model: configuredModel,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

class AiProseHttpError extends Error {
  constructor(readonly status: number, readonly detail?: string) {
    super(`AI prose provider request failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'AiProseHttpError';
  }
}

async function readAiProseErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (!text) return undefined;

    let detail = text;
    try {
      const payload: unknown = JSON.parse(text);
      if (isRecord(payload)) {
        const error = payload.error;
        if (isRecord(error) && typeof error.message === 'string') detail = error.message;
        else if (typeof error === 'string') detail = error;
        else if (typeof payload.message === 'string') detail = payload.message;
        else if (typeof payload.detail === 'string') detail = payload.detail;
      }
    } catch {
      // Keep the plain-text response when the provider did not return JSON.
    }

    const normalized = detail.replace(/\s+/gu, ' ').trim();
    return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateAiProseRequest(request: AiProseLlmRequest): AiProseLlmRequest {
  if (!isRecord(request)
    || typeof request.endpoint !== 'string'
    || typeof request.model !== 'string'
    || typeof request.systemPrompt !== 'string'
    || typeof request.userPrompt !== 'string'
    || typeof request.jsonOutput !== 'boolean'
    || typeof request.stage !== 'string') {
    throw new Error('Invalid AI prose completion request.');
  }
  if (!AI_PROSE_STAGES.includes(request.stage as AiProseStage)) {
    throw new Error(`Invalid AI prose stage: ${request.stage}`);
  }
  if (request.effort !== undefined && !AI_PROSE_EFFORTS.includes(request.effort)) {
    throw new Error('Invalid AI prose effort.');
  }
  if (request.requestId !== undefined
    && (typeof request.requestId !== 'string' || request.requestId.trim().length === 0 || request.requestId.length > 160)) {
    throw new Error('Invalid AI prose requestId.');
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw new Error('Invalid AI prose stream flag.');
  }
  if ('apiKey' in request || 'credential' in request) {
    throw new Error('AI prose credentials must be stored by the main process.');
  }
  const allowedFields = new Set([
    'stage',
    'endpoint',
    'model',
    'systemPrompt',
    'userPrompt',
    'jsonOutput',
    'effort',
    'requestId',
    'stream',
  ]);
  const unexpectedFields = Object.keys(request).filter((key) => !allowedFields.has(key));
  if (unexpectedFields.length > 0) {
    throw new Error(`Invalid AI prose request fields: ${unexpectedFields.join(', ')}`);
  }
  return request;
}

function extractAiProseContent(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
  const content = firstChoice.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isRecord)
    .map((part) => part.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text.length > 0 ? text : undefined;
}

function emitAiProseProgress(
  request: AiProseLlmRequest,
  callback: ((progress: AiProseLlmProgress) => void) | undefined,
  progress: Omit<AiProseLlmProgress, 'requestId' | 'stage'>,
): void {
  if (!callback || !request.requestId) return;
  callback({ ...progress, requestId: request.requestId, stage: request.stage });
}

async function completeAiProseRequest(
  request: AiProseLlmRequest,
  onProgress?: (progress: AiProseLlmProgress) => void,
  signal?: AbortSignal,
): Promise<AiProseLlmResponse> {
  const validated = validateAiProseRequest(request);
  const startedAt = Date.now();
  const estimatedInputTokens = estimateAiProseTokenCount(`${validated.systemPrompt}\n${validated.userPrompt}`);
  let configured: ReturnType<typeof resolveConfiguredAiProseRequest> | undefined;

  try {
    if (aiProseProvider) await ensureAiProseModelMetadata(aiProseProvider.endpoint);
    configured = resolveConfiguredAiProseRequest(validated);
    const credential = await loadAiProseCredential();
    const requestContext = {
      requestId: validated.requestId ?? 'untracked',
      stage: validated.stage,
      model: configured.model,
      endpoint: configured.endpoint,
    };
    console.info('[AI prose] provider request started', requestContext);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (credential) headers.Authorization = `Bearer ${credential}`;

    const body: Record<string, unknown> = {
      model: configured.model,
      messages: [
        { role: 'system', content: validated.systemPrompt },
        { role: 'user', content: validated.userPrompt },
      ],
      ...(validated.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
      ...(validated.effort ? { reasoning_effort: validated.effort } : {}),
      ...(validated.stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    };
    logAiProseDebug('provider request payload', { ...requestContext, body });

    const response = await fetch(resolveAiProseCompletionEndpoint(configured.endpoint), {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    console.info('[AI prose] provider response received', {
      ...requestContext,
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - startedAt,
    });

    if (!response.ok) {
      const detail = await readAiProseErrorDetail(response);
      console.error('[AI prose] provider request failed', {
        ...requestContext,
        status: response.status,
        detail,
        elapsedMs: Date.now() - startedAt,
      });
      throw new AiProseHttpError(response.status, detail);
    }
    if (validated.stream && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      const result = await readAiProseStreamingResponse(
        response,
        validated,
        onProgress,
        startedAt,
        configured.contextWindow,
      );
      logAiProseDebug('provider request completed', {
        ...requestContext,
        elapsedMs: Date.now() - startedAt,
        usage: result.usage ?? null,
        content: result.content,
        raw: result.raw ?? null,
      });
      return { ...result, status: response.status };
    }
    const payload: unknown = await response.json();
    const content = extractAiProseContent(payload);
    if (content === undefined) {
      throw new Error('AI prose provider returned no message content.');
    }
    const usage = extractAiProseUsage(payload);
    const model = extractAiProseModel(payload);
    logAiProseDebug('provider request completed', {
      ...requestContext,
      elapsedMs: Date.now() - startedAt,
      usage: usage ?? null,
      content,
      raw: payload,
    });
    return {
      content,
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      status: response.status,
      ...(configured.contextWindow !== undefined ? { contextWindow: configured.contextWindow } : {}),
      raw: payload,
    };
  } catch (error) {
    const abortFailure = isAiProseStreamAbortFailure(error);
    const streamAlreadyReportedAbort = validated.stream && abortFailure;
    if (validated.requestId && !streamAlreadyReportedAbort) {
      const progressError: AiProseLlmProgressError = {
        message: error instanceof Error ? error.message : String(error),
        ...(abortFailure
          ? {
            code: error instanceof AiProseStreamIdleTimeoutError
              ? 'request_timeout'
              : 'request_cancelled',
          }
          : {}),
        details: {
          requestId: validated.requestId,
          stage: validated.stage,
          ...(configured?.endpoint ? { endpoint: configured.endpoint } : { endpoint: validated.endpoint }),
          ...(configured?.model ? { model: configured.model } : { model: validated.model }),
          ...(error instanceof AiProseHttpError
            ? {
              status: error.status,
              ...(error.detail ? { detail: error.detail } : {}),
            }
            : {}),
        },
      };
      emitAiProseProgress(validated, onProgress, {
        phase: 'failed',
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        inputTokensSource: 'estimate',
        outputTokensSource: 'estimate',
        model: configured?.model ?? validated.model,
        ...(validated.effort ? { effort: validated.effort } : {}),
        ...(error instanceof AiProseHttpError ? { status: error.status } : {}),
        ...(configured?.contextWindow !== undefined
          ? { contextWindow: configured.contextWindow }
          : {}),
        error: progressError,
        elapsedMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
}

async function probeAiProseCapabilities(
  request: AiProseCapabilityProbeRequest,
): Promise<AiProseModelCapabilities> {
  const probeRequest = buildAiProseCapabilityProbeRequest(request);
  try {
    await completeAiProseRequest(probeRequest);
    return { jsonOutputSupported: true };
  } catch (error) {
    if (!(error instanceof AiProseHttpError) || ![400, 404, 405, 415, 422].includes(error.status)) throw error;

    // A bad model or endpoint also returns 4xx. Confirm the normal chat route
    // first so those configuration errors are not reported as JSON incompatibility.
    await completeAiProseRequest({ ...probeRequest, jsonOutput: false });
    return { jsonOutputSupported: false };
  }
}

async function listAiProseModels(baseUrl: string): Promise<AiProseModelListResult> {
  try {
    const maySendCredential = listModelsMaySendCredential(aiProseProvider?.endpoint, baseUrl);
    const credential = maySendCredential ? await loadAiProseCredential() : undefined;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    let lastError = '获取模型列表失败';
    for (const endpoint of resolveAiProseModelsEndpoints(baseUrl)) {
      const response = await fetch(endpoint, {
        method: 'GET',
        redirect: 'error',
        headers,
      });
      if (response.ok) {
        const parsed = parseAiProseModelListPayload(await response.json());
        rememberAiProseModelMetadata(baseUrl, parsed.modelMetadata);
        return { success: true, ...parsed };
      }

      const detail = await readAiProseErrorDetail(response);
      lastError = `获取模型列表失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`;
      if (![404, 405].includes(response.status)) {
        return { success: false, models: [], error: lastError };
      }
    }
    return { success: false, models: [], error: lastError };
  } catch (error) {
    return {
      success: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

ipcMain.handle('aiProse:configureProvider', async (event, provider: AiProseProviderConfig) => {
  if (!isMainWindowFrameSender(event)) {
    return { success: false, error: 'Unauthorized AI prose sender.' };
  }
  try {
    const nextProvider = validateAiProseProvider(provider);
    if (aiProseProvider
      && normalizeAiProseProviderEndpoint(aiProseProvider.endpoint)
        !== normalizeAiProseProviderEndpoint(nextProvider.endpoint)) {
      aiProseModelMetadataByEndpoint.clear();
    }
    aiProseProvider = nextProvider;
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('aiProse:complete', async (event, request: AiProseLlmRequest) => {
  if (!isMainWindowFrameSender(event)) throw new Error('Unauthorized AI prose sender.');
  const requestId = typeof request?.requestId === 'string' && request.requestId.trim().length > 0
    ? request.requestId
    : undefined;
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimeout = (timeoutMs: number, phase: 'start' | 'stream') => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (requestId) aiProseInFlightControllers.delete(requestId);
      console.warn('[AI prose] request timed out', { requestId, phase, idleMs: timeoutMs });
      controller.abort(new AiProseStreamIdleTimeoutError(timeoutMs));
    }, timeoutMs);
  };
  if (requestId) {
    aiProseInFlightControllers.set(requestId, controller);
    armIdleTimeout(AI_PROSE_REQUEST_START_TIMEOUT_MS, 'start');
  }
  try {
    return await completeAiProseRequest(request, (progress) => {
      if (requestId
        && progress.phase === 'chunk'
        && progress.streamActivity === true) {
        armIdleTimeout(AI_PROSE_STREAM_IDLE_TIMEOUT_MS, 'stream');
      }
      event.sender.send('aiProse:progress', progress);
    }, controller.signal);
  } catch (error) {
    console.error('[AI prose] completion handler failed', {
      requestId: request?.requestId ?? 'untracked',
      stage: request?.stage ?? 'unknown',
      model: request?.model ?? 'unknown',
      endpoint: request?.endpoint ?? 'unknown',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (requestId) aiProseInFlightControllers.delete(requestId);
  }
});

ipcMain.on('aiProse:cancel', (event, requestId: string) => {
  if (!isMainWindowFrameSender(event)) return;
  if (typeof requestId !== 'string' || requestId.trim().length === 0) return;
  const controller = aiProseInFlightControllers.get(requestId);
  if (!controller) return;
  aiProseInFlightControllers.delete(requestId);
  controller.abort();
});

ipcMain.handle('aiProse:probeCapabilities', async (event, request: AiProseCapabilityProbeRequest) => {
  if (!isMainWindowFrameSender(event)) throw new Error('Unauthorized AI prose sender.');
  return probeAiProseCapabilities(request);
});

ipcMain.handle('aiProse:listModels', async (event, baseUrl: string): Promise<AiProseModelListResult> => {
  if (!isMainWindowFrameSender(event) && !isAgentWindowFrameSender(event)) {
    return { success: false, models: [], error: 'Unauthorized AI prose sender.' };
  }
  return listAiProseModels(baseUrl);
});

ipcMain.handle('aiProse:getCredentialStatus', async (event): Promise<AiProseCredentialStatus> => {
  if (!isMainWindowFrameSender(event)) return { configured: false };
  return { configured: (await loadAiProseCredential()) !== undefined };
});

ipcMain.handle('aiProse:setCredential', async (event, value: string) => {
  if (!isMainWindowFrameSender(event)) {
    return { success: false, error: 'Unauthorized AI prose sender.' };
  }
  return setAiProseCredential(value);
});

ipcMain.handle('aiProse:clearCredential', async (event) => {
  if (!isMainWindowFrameSender(event)) {
    return { success: false, error: 'Unauthorized AI prose sender.' };
  }
  return clearAiProseCredential();
});

ipcMain.handle('aiConversation:complete', async (event, payload: unknown): Promise<AiConversationIpcResult> => {
  const senderFrame = event.senderFrame;
  if (!isAiConversationSenderFrame(event) || !senderFrame) {
    return {
      status: 'error',
      code: 'configuration',
      message: 'Unauthorized AI conversation sender.',
      retryable: false,
    };
  }
  const frameId = senderFrame.frameTreeNodeId;
  const webContentsId = event.sender.id;
  const previousFrameId = aiConversationFrameIdByWebContents.get(webContentsId);
  if (previousFrameId !== undefined && previousFrameId !== frameId) {
    aiConversationCoordinator.abortFrame(previousFrameId);
  }
  aiConversationFrameIdByWebContents.set(webContentsId, frameId);
  aiConversationCoordinator.pruneSettled();

  let requestId: string;
  let request: ReturnType<typeof validateAiConversationIpcRequest>['request'];
  try {
    const validated = validateAiConversationIpcRequest(payload);
    requestId = validated.requestId;
    request = validated.request;
  } catch (error) {
    return {
      status: 'error',
      code: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  let registration: AiConversationRequestRegistration;
  try {
    registration = aiConversationCoordinator.register({
      frameId,
      webContentsId,
      requestId,
    });
  } catch (error) {
    return {
      status: 'error',
      code: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }

  const startedAt = Date.now();
  try {
    if (!aiProseProvider) {
      return {
        status: 'error',
        code: 'configuration',
        message: 'AI prose provider is not configured in the main process.',
        retryable: false,
      };
    }
    if (!aiConversationRequestMatchesConfiguredProvider(aiProseProvider, request)) {
      return {
        status: 'error',
        code: 'configuration',
        message: 'AI conversation request does not match the configured provider.',
        retryable: false,
      };
    }
    const credential = await loadAiProseCredential();
    // Populate provider/model metadata (context window) for this endpoint so
    // the probe and model turns carry the provider-reported context window
    // even when the user never fetched the interactive model list.
    await ensureAiProseModelMetadata(aiProseProvider.endpoint);
    if (!event.sender.isDestroyed()) {
      event.sender.send('aiConversation:progress', { requestId, kind: 'connected' });
    }
    const response = await completeAiConversationRequest(request, {
      requestId,
      credential,
      signal: registration.signal,
      contextWindow: getAiProseModelContextWindow(aiProseProvider.endpoint, request.model),
      onProgress: (progress) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send('aiConversation:progress', {
          requestId,
          kind: progress.kind,
          ...(progress.delta !== undefined ? { delta: progress.delta } : {}),
          ...(progress.reasoningDelta !== undefined ? { reasoningDelta: progress.reasoningDelta } : {}),
        });
      },
    });
    console.info('[AI conversation] provider request completed', {
      model: request.model,
      endpoint: aiProseProvider.endpoint,
      elapsedMs: Date.now() - startedAt,
    });
    return { status: 'ok', response };
  } catch (error) {
    console.error('[AI conversation] provider request failed', {
      model: request.model,
      endpoint: aiProseProvider?.endpoint ?? 'unknown',
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    if (error instanceof AiConversationTransportError) {
      return {
        status: 'error',
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      };
    }
    return {
      status: 'error',
      code: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  } finally {
    registration.settle();
  }
});

ipcMain.handle('aiConversation:cancel', async (event, requestId: unknown): Promise<AiConversationCancelResult> => {
  const senderFrame = event.senderFrame;
  if (!isAiConversationSenderFrame(event) || !senderFrame) return 'notFound';
  if (typeof requestId !== 'string' || requestId.trim().length === 0 || requestId.length > 160) {
    return 'notFound';
  }
  return aiConversationCoordinator.cancel(senderFrame.frameTreeNodeId, requestId);
});

// Read file as buffer (for Live2D assets, audio, etc.)
ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    const buffer = fs.readFileSync(absolutePath);
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Read file as text
ipcMain.handle('fs:readTextFile', async (_event, filePath: string) => {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    const text = fs.readFileSync(absolutePath, 'utf-8');
    return { success: true, data: text };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// List directory contents
ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
  try {
    const absolutePath = path.isAbsolute(dirPath)
      ? dirPath
      : path.resolve(app.getAppPath(), dirPath);
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    return {
      success: true,
      data: entries.map(e => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isSymbolicLink: e.isSymbolicLink(),
        path: path.join(absolutePath, e.name),
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// lstat-style metadata for the bounded project read ports (symlinks reported, never followed)
ipcMain.handle('fs:stat', async (_event, filePath: string) => {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    const lstat = fs.lstatSync(absolutePath);
    return {
      success: true,
      data: {
        isFile: lstat.isFile(),
        isDirectory: lstat.isDirectory(),
        isSymbolicLink: lstat.isSymbolicLink(),
        sizeBytes: lstat.size,
        mtimeMs: lstat.mtimeMs,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Canonical resolved path for project-root containment checks
ipcMain.handle('fs:realpath', async (_event, filePath: string) => {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    return { success: true, data: fs.realpathSync(absolutePath) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Check file exists
ipcMain.handle('fs:exists', async (_event, filePath: string) => {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(app.getAppPath(), filePath);
  return fs.existsSync(absolutePath);
});

// Write file (for exports, project saves)
ipcMain.handle('fs:writeFile', async (_event, filePath: string, data: ArrayBuffer) => {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    // Ensure directory exists
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.from(data));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Write text file (for project saves)
ipcMain.handle('fs:writeTextFile', async (_event, filePath: string, data: string) => {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    // Ensure directory exists
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, data, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:ensureDir', async (_event, dirPath: string) => {
  try {
    const absolutePath = path.isAbsolute(dirPath)
      ? dirPath
      : path.resolve(app.getAppPath(), dirPath);
    fs.mkdirSync(absolutePath, { recursive: true });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:copyFile', async (_event, sourcePath: string, destPath: string) => {
  try {
    const absoluteSource = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.resolve(app.getAppPath(), sourcePath);
    const absoluteDest = path.isAbsolute(destPath)
      ? destPath
      : path.resolve(app.getAppPath(), destPath);
    fs.mkdirSync(path.dirname(absoluteDest), { recursive: true });
    fs.copyFileSync(absoluteSource, absoluteDest);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:replaceFile', async (_event, temporaryPath: string, destinationPath: string) => {
  try {
    const absoluteSource = resolveFileSystemPath(temporaryPath);
    const absoluteDestination = resolveFileSystemPath(destinationPath);
    await replaceFileWithPlatformCompatibility(absoluteSource, absoluteDestination);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('fs:removeFile', async (_event, filePath: string) => {
  try {
    await fs.promises.rm(filePath, { force: true });
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
});

// Show save dialog
ipcMain.handle('dialog:showSave', async (event, options: any) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!ownerWindow) return { canceled: true };
  return dialog.showSaveDialog(ownerWindow, options);
});

// Show open dialog
ipcMain.handle('dialog:showOpen', async (event, options: any) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!ownerWindow) return { canceled: true };
  return dialog.showOpenDialog(ownerWindow, options);
});

ipcMain.handle('templates:importZip', async (event) => {
  if (!isMainWindowFrameSender(event)) {
    return { success: false, error: '模板包只能从主窗口导入' };
  }
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!ownerWindow) return { success: false, canceled: true };

  const selection = await dialog.showOpenDialog(ownerWindow, {
    title: '导入 Aeonstagery 模板包',
    properties: ['openFile'],
    filters: [{ name: 'Aeonstagery 模板包', extensions: ['zip'] }],
  });
  if (selection.canceled || !selection.filePaths[0]) {
    return { success: false, canceled: true };
  }

  try {
    const inspection = await inspectTemplatePackageArchive(selection.filePaths[0]);
    try {
      const installed = await installTemplatePackageArchive(inspection, app.getPath('userData'), false);
      return { success: true, package: installed };
    } catch (error) {
      if (!(error instanceof TemplatePackageAlreadyInstalledError)) throw error;
      const confirmation = await dialog.showMessageBox(ownerWindow, {
        type: 'warning',
        title: '替换已安装模板？',
        message: `${error.templateName} 已安装`,
        detail: `导入版本：${error.templateVersion}\n模板 ID：${error.templateId}\n\n替换时会先保留旧目录，只有新版本安装成功后才删除旧目录。`,
        buttons: ['替换', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return { success: false, canceled: true };
      const installed = await installTemplatePackageArchive(inspection, app.getPath('userData'), true);
      return { success: true, package: installed };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// Get app path for resolving relative paths
ipcMain.handle('app:getPath', async () => {
  return isDev ? process.cwd() : process.resourcesPath;
});

ipcMain.handle('app:getProjectPath', async () => {
  return path.join(isDev ? process.cwd() : process.resourcesPath, 'projects');
});

ipcMain.handle('app:getUserDataPath', async () => {
  return app.getPath('userData');
});

ipcMain.handle('app:getDefaultProjectsPath', async () => {
  return path.join(app.getPath('documents'), 'AeonStagery Projects');
});

const betaStateFiles = {
  'experimental-features': 'experimental-features.json',
  'first-lesson': 'first-lesson.json',
} as const;

ipcMain.handle('betaState:load', async (event, kind: keyof typeof betaStateFiles) => {
  if (!isMainWindowSender(event.sender.id)) return null;
  const fileName = betaStateFiles[kind];
  if (!fileName) return null;
  try {
    return JSON.parse(await fs.promises.readFile(path.join(app.getPath('userData'), 'beta', fileName), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('betaState:save', async (event, kind: keyof typeof betaStateFiles, value: unknown) => {
  if (!isMainWindowSender(event.sender.id)) {
    return { success: false, error: 'Unauthorized beta state sender.' };
  }
  const fileName = betaStateFiles[kind];
  if (!fileName) return { success: false, error: 'Unknown beta state kind.' };
  try {
    const directory = path.join(app.getPath('userData'), 'beta');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, fileName), JSON.stringify(value), 'utf8');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle('app:restart', async () => {
  if (!loadFromDist) {
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      await loadRenderer(window);
      if (!window.isDestroyed()) {
        window.webContents.reloadIgnoringCache();
      }
    }
    return { success: true };
  }
  app.relaunch();
  app.quit();
  return { success: true };
});

function getCrashReportsDir(): string {
  return path.join(app.getPath('userData'), 'crash-reports');
}

async function writeCrashReportFiles(report: any): Promise<string> {
  const dir = getCrashReportsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const sanitizedTimestamp = (report.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const baseName = `crash-${sanitizedTimestamp}-${report.reportId || 'unknown'}`;
  const jsonPath = path.join(dir, `${baseName}.json`);

  await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Rotate old crash reports: keep max 20
  try {
    const files = await fs.promises.readdir(dir);
    const reportFiles = files
      .filter((f) => f.startsWith('crash-') && (f.endsWith('.json') || f.endsWith('.md')));
    
    const baseNames = Array.from(new Set(reportFiles.map((f) => f.replace(/\.(json|md)$/, ''))));
    if (baseNames.length > 20) {
      baseNames.sort();
      const toDelete = baseNames.slice(0, baseNames.length - 20);
      for (const base of toDelete) {
        await fs.promises.unlink(path.join(dir, `${base}.json`)).catch(() => {});
        await fs.promises.unlink(path.join(dir, `${base}.md`)).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[AeonStagery] Failed to rotate crash reports:', err);
  }

  return jsonPath;
}

ipcMain.handle('crash:record', async (_event, report) => {
  try {
    const filePath = await writeCrashReportFiles(report);
    return { success: true, reportId: report.reportId, filePath };
  } catch (error: any) {
    console.error('[AeonStagery] Failed to record crash report:', error);
    return { success: false, error: error?.message ?? String(error) };
  }
});

// Real environment metadata (process.versions / app version) for crash reports.
// The renderer process cannot read these, so it asks the main process.
ipcMain.handle('crash:getEnvironment', async () => {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron || 'unknown',
    chromeVersion: process.versions.chrome || 'unknown',
    nodeVersion: process.versions.node || 'unknown',
    platform: process.platform,
    arch: process.arch,
  };
});

ipcMain.handle('crash:openReportDir', async () => {
  const dir = getCrashReportsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return { success: true };
});

ipcMain.handle('crash:getLatestReport', async () => {
  try {
    const dir = getCrashReportsDir();
    if (!fs.existsSync(dir)) return null;
    const files = await fs.promises.readdir(dir);
    const jsonFiles = files.filter((f) => f.startsWith('crash-') && f.endsWith('.json')).sort();
    if (jsonFiles.length === 0) return null;
    const latest = jsonFiles[jsonFiles.length - 1];
    const content = await fs.promises.readFile(path.join(dir, latest), 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('[AeonStagery] Failed to get latest crash report:', error);
    return null;
  }
});

ipcMain.handle('workspaceTools:open', async (event) => {
  if (!isMainWindowSender(event.sender.id)) return { success: false };
  createWorkspaceToolsWindow();
  return { success: true };
});

ipcMain.handle('workspaceTools:close', async (event) => {
  if (
    !isMainWindowSender(event.sender.id)
    && !isWorkspaceToolsWindowSender(event.sender.id)
  ) {
    return { success: false };
  }
  workspaceToolsWindow?.close();
  return { success: true };
});

ipcMain.handle('workspaceTools:getWindowState', async (event) => {
  if (!isMainWindowSender(event.sender.id)) return { open: false };
  return {
    open: !!workspaceToolsWindow && !workspaceToolsWindow.isDestroyed(),
  };
});

ipcMain.handle('workspaceTools:requestSnapshot', async (event) => {
  if (!isWorkspaceToolsWindowSender(event.sender.id)) return { success: false };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('workspaceTools:requestSnapshot');
  }
  return { success: true };
});

ipcMain.on('workspaceTools:publishSnapshot', (event, snapshot: WorkspaceToolsSnapshot) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
  if (!workspaceToolsWindow || workspaceToolsWindow.isDestroyed()) return;
  workspaceToolsWindow.webContents.send('workspaceTools:snapshot', snapshot);
});

ipcMain.on('workspaceTools:publishRuntime', (event, snapshot: WorkspaceRuntimeSnapshot) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
  if (!workspaceToolsWindow || workspaceToolsWindow.isDestroyed()) return;
  workspaceToolsWindow.webContents.send('workspaceTools:runtime', snapshot);
});

ipcMain.on('workspaceTools:command', (event, command: WorkspaceToolsCommand) => {
  if (!isWorkspaceToolsWindowSender(event.sender.id)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('workspaceTools:command', command);
});

ipcMain.on('workspaceTools:commandResult', (event, result: WorkspaceToolsCommandResult) => {
  if (!isMainWindowSender(event.sender.id)) return;
  if (!workspaceToolsWindow || workspaceToolsWindow.isDestroyed()) return;
  workspaceToolsWindow.webContents.send('workspaceTools:commandResult', result);
});

// ─── Project Agent IPC ────────────────────────────────────

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projectAgent:supplement', { taskId, text });
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projectAgent:startRequest', payload);
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
  createAgentWindow();
  return { success: true };
});

ipcMain.handle('collaborationServer:start', async (event, input: { projectId: string; host?: string; port?: number; password?: string }) => {
  if (!isMainWindowFrameSender(event)) return { success: false, error: 'Unauthorized collaboration server sender.' };
  try {
    if (!input?.projectId || typeof input.projectId !== 'string') {
      throw new Error('A project ID is required to host collaboration');
    }
    const rendererUrl = mainWindow?.webContents.getURL() ?? '';
    const rendererOrigin = /^https?:/.test(rendererUrl) ? new URL(rendererUrl).origin : 'null';
    const result = await embeddedCollaborationServer.start({
      userDataPath: app.getPath('userData'),
      projectId: input.projectId,
      host: input.host || '0.0.0.0',
      password: input.password,
      allowedOrigins: isCollaborationOriginAllowed(rendererOrigin) ? undefined : ['null', 'file://', rendererOrigin],
      port: Number(input.port ?? 12345),
    });
    return { success: true, ...result };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle('collaborationServer:stop', async (event) => {
  if (!isMainWindowFrameSender(event)) return { success: false, error: 'Unauthorized collaboration server sender.' };
  try {
    await embeddedCollaborationServer.stop();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle('collaborationServer:getStatus', async (event): Promise<{ success: boolean; status: CollaborationServerStatus | null; error?: string }> => {
  if (!isMainWindowFrameSender(event)) return { success: false, status: null, error: 'Unauthorized collaboration server sender.' };
  return { success: true, status: embeddedCollaborationServer.getStatus() };
});

ipcMain.handle('collaborationServer:listSessions', async (event) => {
  if (!isMainWindowFrameSender(event)) return { success: false, error: 'Unauthorized collaboration server sender.' };
  try {
    const sessions = await listCollaborationSessions(
      app.getPath('userData'),
      embeddedCollaborationServer.getStatus()?.dataDir,
    );
    return { success: true, sessions };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle('collaborationServer:clearPreviousSessions', async (event) => {
  if (!isMainWindowFrameSender(event)) return { success: false, error: 'Unauthorized collaboration server sender.' };
  try {
    const result = await embeddedCollaborationServer.clearPreviousSessions(app.getPath('userData'));
    return {
      success: true,
      clearedCount: result.cleared.length,
      skippedActiveCount: result.skippedActive.length,
    };
  } catch (error: any) {
    return { success: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle('path:join', async (_event, args: string[]) => {
  return path.join(...args);
});
ipcMain.handle('path:dirname', async (_event, targetPath: string) => {
  return path.dirname(targetPath);
});
ipcMain.handle('path:basename', async (_event, targetPath: string) => {
  return path.basename(targetPath);
});
ipcMain.handle('path:extname', async (_event, targetPath: string) => {
  return path.extname(targetPath);
});
ipcMain.handle('path:relative', async (_event, fromPath: string, toPath: string) => {
  return path.relative(fromPath, toPath);
});
ipcMain.handle('path:normalize', async (_event, targetPath: string) => {
  return path.normalize(targetPath);
});
ipcMain.handle('path:isAbsolute', async (_event, targetPath: string) => {
  return path.isAbsolute(targetPath);
});

ipcMain.handle('updater:getState', async () => {
  return {
    enabled: Boolean(updateCoordinator?.sources.length),
    feedUrlConfigured: isUpdateSourceConfigured,
    appVersion: app.getVersion(),
    currentVersion: app.getVersion(),
    sources: updateCoordinator?.sources ?? [],
    ...(updateCoordinator?.snapshot ?? { state: 'idle', source: 'oss' }),
  };
});

ipcMain.handle('updater:checkForUpdates', async (_event, source: unknown = 'oss') => {
  if (!updateCoordinator) return { success: false, error: '当前环境不支持自动更新。' };
  if (source !== 'oss' && source !== 'github') return { success: false, error: '未知更新渠道。' };
  try {
    const outcome = await updateCoordinator.checkForUpdates(source as UpdateSource);
    return { ...toUpdateCheckOutcome(outcome.result), source: outcome.source };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('updater:downloadUpdate', async () => {
  if (!updateCoordinator) return { success: false, error: '当前环境不支持自动更新。' };
  try {
    return { success: true, ...await updateCoordinator.downloadUpdate() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('updater:installUpdate', async () => {
  if (!updateCoordinator) return { success: false, error: '当前环境不支持自动更新。' };
  try {
    updateCoordinator.installUpdate();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// ─── Video Export (FFmpeg) ─────────────────────────────────────

ipcMain.handle('export:saveVideo', async (_event, videoBuffer: ArrayBuffer, outputPath: string) => {
  try {
    fs.writeFileSync(outputPath, Buffer.from(videoBuffer));
    return { success: true, path: outputPath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ─── App Lifecycle ─────────────────────────────────────────────

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
  {
    scheme: 'asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'aeon-runtime',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);
app.whenReady().then(() => {
  setAiConversationLogSink(({ tag, payload }) => broadcastAiLlmDebugLog(tag, payload));
  live2DRuntimeAvailability = ensureLive2DRuntime();
  setupAutoUpdater();
  // The aeon-runtime protocol only serves files under the userData target
  // root, so ensureLive2DRuntime()'s resolved report is exactly what the
  // renderer can load. Missing families must not block startup.
  ipcMain.handle('runtime:getLive2DAvailability', (): Live2DRuntimeAvailabilityReport => (
    live2DRuntimeAvailability ?? { cubism2: false, cubism3Plus: false }
  ));
  ipcMain.handle('runtime:getLive2DStatus', (): Live2DRuntimeStatusDetail => {
    return inspectLive2DRuntimeStatus(
      getLive2DRuntimeSeedRoot(),
      getLive2DRuntimeRoot(),
      getLive2DLocalDir(),
      isDev,
    );
  });
  ipcMain.handle('runtime:refreshLive2DStatus', (): Live2DRuntimeStatusDetail => {
    if (isDev) {
      syncLocalRuntimeToSeedRoot(getLive2DLocalDir(), getLive2DRuntimeSeedRoot());
    }
    live2DRuntimeAvailability = ensureLive2DRuntime();
    return inspectLive2DRuntimeStatus(
      getLive2DRuntimeSeedRoot(),
      getLive2DRuntimeRoot(),
      getLive2DLocalDir(),
      isDev,
    );
  });
  ipcMain.handle('runtime:openLive2DDirectory', async (_event, type: 'runtime' | 'local' = 'runtime') => {
    const dir = (type === 'local' && isDev)
      ? getLive2DLocalDir()
      : getLive2DRuntimeRoot();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const error = await shell.openPath(dir);
    return { success: error === '', path: dir };
  });
  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false };
  });
  protocol.handle('aeon-runtime', async (request) => {
    const requestPath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const runtimeRoot = path.resolve(getLive2DRuntimeRoot());
    const resolvedPath = path.resolve(runtimeRoot, requestPath);
    if (resolvedPath !== runtimeRoot && !resolvedPath.startsWith(`${runtimeRoot}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(resolvedPath);
      const extension = path.extname(resolvedPath).toLowerCase();
      const contentType = extension === '.js' ? 'application/javascript' : 'application/octet-stream';
      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(data.length),
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
  protocol.handle('asset', handleAssetProtocolRequest);

  // Register FFmpeg export handlers
  registerFFmpegHandlers();
  registerGptSovitsHandlers();
  registerVoiceAuthoringHandlers();

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  stopGptSovitsProcess('Stopping GPT-SoVITS API before app quit.');
  clearAllVoiceSessionsSync();
  void embeddedCollaborationServer.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
