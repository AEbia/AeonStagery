import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/** Reads the current windows so handlers survive window close/recreation. */
export interface IpcWindowContext {
  readonly mainWindow: BrowserWindow | null;
  readonly workspaceToolsWindow: BrowserWindow | null;
  readonly agentWindow: BrowserWindow | null;
  createWorkspaceToolsWindow(): BrowserWindow;
  createAgentWindow(): BrowserWindow;
}

export function createWindowSenderGuards(windows: IpcWindowContext) {
  function isMainWindowSender(senderId: number): boolean {
    return !!windows.mainWindow
      && !windows.mainWindow.isDestroyed()
      && senderId === windows.mainWindow.webContents.id;
  }

  function isMainWindowFrameSender(
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  ): boolean {
    const window = windows.mainWindow;
    return !!window
      && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame;
  }

  function isWorkspaceToolsWindowSender(senderId: number): boolean {
    return !!windows.workspaceToolsWindow
      && !windows.workspaceToolsWindow.isDestroyed()
      && senderId === windows.workspaceToolsWindow.webContents.id;
  }

  function isAiConversationSenderFrame(
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  ): boolean {
    const senderId = event.sender.id;
    const window = senderId === windows.mainWindow?.webContents.id
      ? windows.mainWindow
      : senderId === windows.workspaceToolsWindow?.webContents.id
        ? windows.workspaceToolsWindow
        : null;
    return !!window
      && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame;
  }

  function isAgentWindowFrameSender(
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  ): boolean {
    const window = windows.agentWindow;
    return !!window
      && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame;
  }

  return {
    isMainWindowSender,
    isMainWindowFrameSender,
    isWorkspaceToolsWindowSender,
    isAiConversationSenderFrame,
    isAgentWindowFrameSender,
  };
}
