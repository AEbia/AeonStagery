import { setAiConversationLogSink } from '../aiConversationProvider';
import { registerFFmpegHandlers } from '../ffmpeg-export';
import { registerGptSovitsHandlers, stopGptSovitsProcess } from '../gpt-sovits';
import { clearAllVoiceSessionsSync, registerVoiceAuthoringHandlers } from '../voice-authoring';
import { registerAiConversationHandlers } from './aiConversation';
import { createAiDebugLogBroadcaster } from './aiDebug';
import { registerAiProseHandlers } from './aiProse';
import { registerAppHandlers, registerExternalUrlHandler, type RendererLifecycle } from './app';
import { registerBetaStateHandlers } from './betaState';
import { registerCollaborationHandlers } from './collaboration';
import { registerCrashHandlers } from './crash';
import { registerDialogHandlers } from './dialog';
import { registerExportHandlers } from './export';
import { registerFileSystemHandlers } from './fs';
import { registerPathHandlers } from './path';
import { registerProjectAgentHandlers } from './projectAgent';
import { registerRuntimeHandlers } from './runtime';
import { registerTemplateHandlers } from './templates';
import { registerUpdaterHandlers } from './updater';
import type { IpcWindowContext } from './windows';
import { registerWorkspaceToolsHandlers } from './workspaceTools';

/** Register process-wide handlers once; ready-only integrations follow Electron's lifecycle. */
export function registerIpcHandlers(windows: IpcWindowContext, renderer: RendererLifecycle) {
  const broadcastAiLlmDebugLog = createAiDebugLogBroadcaster(windows);
  const providerAccess = registerAiProseHandlers(windows, broadcastAiLlmDebugLog);
  const aiConversation = registerAiConversationHandlers(windows, providerAccess);
  registerFileSystemHandlers();
  registerDialogHandlers(windows);
  registerTemplateHandlers(windows);
  registerAppHandlers(windows, renderer);
  registerBetaStateHandlers(windows);
  registerCrashHandlers();
  registerWorkspaceToolsHandlers(windows);
  const projectAgent = registerProjectAgentHandlers(windows);
  const collaboration = registerCollaborationHandlers(windows);
  registerPathHandlers();
  const updater = registerUpdaterHandlers(windows, renderer.isDev);
  registerExportHandlers();

  return {
    aiConversation,
    projectAgent,
    onReady() {
      setAiConversationLogSink(({ tag, payload }) => broadcastAiLlmDebugLog(tag, payload));
      registerRuntimeHandlers(renderer.isDev);
      updater.setup();
      registerExternalUrlHandler();
      registerFFmpegHandlers();
      registerGptSovitsHandlers();
      registerVoiceAuthoringHandlers();
    },
    beforeQuit() {
      stopGptSovitsProcess('Stopping GPT-SoVITS API before app quit.');
      clearAllVoiceSessionsSync();
      void collaboration.stop();
    },
  };
}
