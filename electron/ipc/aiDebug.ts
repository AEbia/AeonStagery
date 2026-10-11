import type { IpcWindowContext } from './windows';

export function createAiDebugLogBroadcaster(windows: IpcWindowContext) {
  /**
   * Mirrors AI LLM debug logs (prose + conversation) to every renderer's
   * DevTools console via the `aiDebug:log` channel, so they are visible
   * without reading the main-process terminal.
   */
  function broadcastAiLlmDebugLog(tag: string, payload: unknown): void {
    const entry = { tag, payload };
    for (const target of [windows.mainWindow, windows.agentWindow]) {
      if (target && !target.isDestroyed()) {
        target.webContents.send('aiDebug:log', entry);
      }
    }
  }

  return broadcastAiLlmDebugLog;
}
