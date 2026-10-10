import { app, ipcMain } from 'electron';
import { isCollaborationOriginAllowed } from '../../server/collaboration/security';
import type { CollaborationServerStatus } from '../../server/collaboration/server';
import { listCollaborationSessions } from '../../server/collaboration/sessionStore';
import { EmbeddedCollaborationServer } from '../embeddedCollaborationServer';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerCollaborationHandlers(windows: IpcWindowContext) {
  const { isMainWindowFrameSender } = createWindowSenderGuards(windows);
  const embeddedCollaborationServer = new EmbeddedCollaborationServer();
  ipcMain.handle('collaborationServer:start', async (event, input: { projectId: string; host?: string; port?: number; password?: string }) => {
    if (!isMainWindowFrameSender(event)) return { success: false, error: 'Unauthorized collaboration server sender.' };
    try {
      if (!input?.projectId || typeof input.projectId !== 'string') {
        throw new Error('A project ID is required to host collaboration');
      }
      const rendererUrl = windows.mainWindow?.webContents.getURL() ?? '';
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

  return { stop: () => embeddedCollaborationServer.stop() };
}
