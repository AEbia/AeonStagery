import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AiConversationResponse } from '../api/types/ai-conversation';
import type { IpcWindowContext } from '../../electron/ipc/windows';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => void>(),
  protocols: new Map<string, (...args: any[]) => any>(),
  userData: '',
  quit: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => electron.userData,
    getVersion: () => '0.8.2-beta',
    quit: electron.quit,
    relaunch: electron.relaunch,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => {
      if (electron.handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
      electron.handlers.set(channel, handler);
    },
    on: (channel: string, handler: (...args: any[]) => void) => {
      if (electron.listeners.has(channel)) throw new Error(`Duplicate IPC listener: ${channel}`);
      electron.listeners.set(channel, handler);
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
  protocol: {
    handle: (scheme: string, handler: (...args: any[]) => any) => electron.protocols.set(scheme, handler),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
}));
vi.mock('electron-updater', () => ({ autoUpdater: {}, NsisUpdater: vi.fn() }));
vi.mock('../../electron/githubReleaseProvider', () => ({ GitHubReleaseProvider: class {} }));

import { registerIpcHandlers } from '../../electron/ipc';
import * as aiProvider from '../../electron/aiConversationProvider';
import * as gptSovits from '../../electron/gpt-sovits';
import * as voiceAuthoring from '../../electron/voice-authoring';
import { EmbeddedCollaborationServer } from '../../electron/embeddedCollaborationServer';

function createWindow(id: number) {
  const webContents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { frameTreeNodeId: id * 10 },
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  });
  const window = {
    webContents,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
  };
  return { window: window as unknown as BrowserWindow, webContents, destroyed: window.isDestroyed };
}

function eventFor(window: BrowserWindow, senderFrame = window.webContents.mainFrame): IpcMainInvokeEvent {
  return { sender: window.webContents, senderFrame } as IpcMainInvokeEvent;
}

function invoke(channel: string, event?: IpcMainInvokeEvent, ...args: unknown[]) {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler(event, ...args);
}

function publish(channel: string, event: IpcMainInvokeEvent, payload: unknown) {
  const listener = electron.listeners.get(channel);
  if (!listener) throw new Error(`Missing IPC listener: ${channel}`);
  listener(event, payload);
}

const response: AiConversationResponse = {
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
};
const endpoint = 'https://ai.example.test/v1';
function conversationRequest(requestId: string, targetEndpoint = endpoint) {
  return {
    requestId,
    request: {
      endpoint: targetEndpoint,
      model: 'model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    },
  };
}

let windows: IpcWindowContext;
let editor: ReturnType<typeof createWindow>;
let tools: ReturnType<typeof createWindow>;
let agent: ReturnType<typeof createWindow>;
let ipc: ReturnType<typeof registerIpcHandlers>;
let loadRenderer: Mock<(window: BrowserWindow) => Promise<void>>;

beforeEach(async () => {
  electron.handlers.clear();
  electron.listeners.clear();
  electron.protocols.clear();
  electron.userData = await mkdtemp(join(tmpdir(), 'aeon-ipc-domains-'));
  vi.stubGlobal('process', { ...process, resourcesPath: electron.userData });
  editor = createWindow(1);
  tools = createWindow(2);
  agent = createWindow(3);
  windows = {
    get mainWindow() { return editor.window; },
    get workspaceToolsWindow() { return tools.window; },
    get agentWindow() { return agent.window; },
    createWorkspaceToolsWindow: vi.fn(() => tools.window),
    createAgentWindow: vi.fn(() => agent.window),
  };
  loadRenderer = vi.fn(async (_window: BrowserWindow) => {});
  ipc = registerIpcHandlers(windows, { isDev: true, loadFromDist: false, loadRenderer });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'model', context_length: 8192 }] })));
});

afterEach(async () => {
  aiProvider.setAiConversationLogSink(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(electron.userData, { recursive: true, force: true });
});

describe('Electron IPC domain composition', () => {
  it('registers every domain once and waits for readiness before native integrations', () => {
    const channels = [...electron.handlers.keys(), ...electron.listeners.keys()];
    const counts = Object.fromEntries([
      ['aiProse', 8], ['aiConversation', 2], ['fs', 12], ['dialog', 2], ['templates', 1],
      ['app', 5], ['betaState', 2], ['crash', 4], ['workspaceTools', 8], ['projectAgent', 29],
      ['collaborationServer', 5], ['path', 7], ['updater', 4], ['export', 1],
    ]);
    expect(channels).toHaveLength(90);
    for (const [domain, count] of Object.entries(counts)) {
      expect(channels.filter(channel => channel.startsWith(`${domain}:`))).toHaveLength(count);
    }
    expect(electron.protocols.size).toBe(0);
    ipc.onReady();
    for (const channel of [
      'runtime:getLive2DAvailability', 'runtime:getLive2DStatus', 'runtime:refreshLive2DStatus',
      'runtime:openLive2DDirectory', 'app:openExternal', 'ffmpeg:convert',
      'gptSovits:status', 'voiceAuthoring:scanCatalog',
    ]) {
      expect(electron.handlers.has(channel), channel).toBe(true);
    }
    expect([...electron.protocols.keys()].sort()).toEqual(['aeon-runtime', 'asset']);
  });

  it('keeps workspace relay permissions and follows recreated editor windows', async () => {
    const payload = { requestId: 'result-1', success: true };
    publish('workspaceTools:commandResult', eventFor(agent.window), payload);
    expect(tools.webContents.send).not.toHaveBeenCalled();
    publish('workspaceTools:commandResult', eventFor(editor.window), payload);
    expect(tools.webContents.send).toHaveBeenCalledWith('workspaceTools:commandResult', payload);

    const oldEditor = editor;
    editor = createWindow(4);
    expect(await invoke('workspaceTools:open', eventFor(oldEditor.window))).toEqual({ success: false });
    expect(await invoke('workspaceTools:open', eventFor(editor.window))).toEqual({ success: true });
    expect(windows.createWorkspaceToolsWindow).toHaveBeenCalledOnce();
    publish('workspaceTools:command', eventFor(tools.window), payload);
    expect(editor.webContents.send).toHaveBeenCalledWith('workspaceTools:command', payload);
    expect(oldEditor.webContents.send).not.toHaveBeenCalled();
    tools.destroyed.mockReturnValue(true);
    expect(await invoke('workspaceTools:getWindowState', eventFor(editor.window))).toEqual({ open: false });
  });

  it('limits persisted beta state to the editor and preserves its file location', async () => {
    expect(await invoke('betaState:save', eventFor(tools.window), 'first-lesson', {})).toMatchObject({ success: false });
    expect(await invoke('betaState:load', eventFor(agent.window), 'first-lesson')).toBeNull();
    const value = { completed: true };
    expect(await invoke('betaState:save', eventFor(editor.window), 'first-lesson', value)).toEqual({ success: true });
    expect(await invoke('betaState:load', eventFor(editor.window), 'first-lesson')).toEqual(value);
    expect(JSON.parse(await readFile(join(electron.userData, 'beta/first-lesson.json'), 'utf8'))).toEqual(value);
  });

  it('rejects subframes and keeps prose provider updates visible to conversation', async () => {
    const provider = { endpoint, defaultModel: 'model' };
    const subframe = eventFor(editor.window, { frameTreeNodeId: 999 } as Electron.WebFrameMain);
    expect(await invoke('aiProse:configureProvider', subframe, provider)).toMatchObject({ success: false });
    expect(await invoke('projectAgent:openWindow', subframe)).toEqual({ success: false });
    expect(await invoke('collaborationServer:start', subframe, { projectId: 'p' })).toMatchObject({ success: false });
    expect(await invoke('aiProse:configureProvider', eventFor(editor.window), provider)).toEqual({ success: true });
    const completion = vi.spyOn(aiProvider, 'completeAiConversationRequest').mockResolvedValue(response);
    expect(await invoke('aiConversation:complete', eventFor(agent.window), conversationRequest('agent'))).toMatchObject({ status: 'error', code: 'configuration' });
    expect(await invoke('aiConversation:complete', subframe, conversationRequest('subframe'))).toMatchObject({ status: 'error', code: 'configuration' });
    expect(await invoke('aiConversation:complete', eventFor(tools.window), conversationRequest('tools'))).toEqual({ status: 'ok', response });
    const nextEndpoint = 'https://next.example.test/v1';
    await invoke('aiProse:configureProvider', eventFor(editor.window), { ...provider, endpoint: nextEndpoint });
    expect(await invoke('aiConversation:complete', eventFor(editor.window), conversationRequest('old'))).toMatchObject({ status: 'error', code: 'configuration' });
    expect(await invoke('aiConversation:complete', eventFor(editor.window), conversationRequest('new', nextEndpoint))).toEqual({ status: 'ok', response });
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])('aborts conversation requests on %s', async (eventName) => {
    await invoke('aiProse:configureProvider', eventFor(editor.window), { endpoint, defaultModel: 'model' });
    ipc.aiConversation.wireWebContentsLifetime(editor.webContents as unknown as WebContents);
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(aiProvider, 'completeAiConversationRequest').mockImplementation((_request, options) => {
      signal = options.signal;
      started();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const result = invoke('aiConversation:complete', eventFor(editor.window), conversationRequest('pending'));
    await providerStarted;
    expect(await invoke('aiConversation:cancel', eventFor(tools.window), 'pending')).toBe('notFound');
    expect(signal?.aborted).toBe(false);
    editor.webContents.emit(eventName);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ status: 'error' });
  });

  it('delegates development restart and application shutdown to their original owners', async () => {
    expect(await invoke('app:restart')).toEqual({ success: true });
    expect(loadRenderer).toHaveBeenCalledWith(editor.window);
    expect(editor.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    const stopVoice = vi.spyOn(gptSovits, 'stopGptSovitsProcess').mockReturnValue({ success: true, state: 'stopped', logs: [] });
    const clearSessions = vi.spyOn(voiceAuthoring, 'clearAllVoiceSessionsSync').mockImplementation(() => {});
    const stopCollaboration = vi.spyOn(EmbeddedCollaborationServer.prototype, 'stop').mockResolvedValue();
    ipc.beforeQuit();
    expect(stopVoice).toHaveBeenCalledWith('Stopping GPT-SoVITS API before app quit.');
    expect(clearSessions).toHaveBeenCalledOnce();
    expect(stopCollaboration).toHaveBeenCalledOnce();
  });
});
