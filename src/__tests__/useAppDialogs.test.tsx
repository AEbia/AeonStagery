/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../api/events';
import { useAppDialogs } from '../ui/hooks/useAppDialogs';

vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({ settings: { autoShowChangelogOnUpdate: false, showLive2DRuntimeSetupOnStartup: false } }),
}));
vi.mock('../services/announcements/ChangelogService', () => ({
  defaultChangelogService: { hasUnread: () => false },
}));
vi.mock('../services/live2d/live2dRuntimeDetection', () => ({
  detectLive2DRuntimeStatus: async () => ({ cubism2: true, cubism3Plus: true, missingAny: false }),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  eventBus.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAppDialogs', () => {
  it('keeps dirty settings open when discarding edits is declined, then closes after animation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderHook(useAppDialogs);
    await act(async () => { await eventBus.emit('ui:openSettings', { tab: 'templates' }); });
    act(() => result.current.setIsPerformanceProfileEditorDirty(true));
    act(() => result.current.handleCloseSettings());
    expect(confirm).toHaveBeenCalled();
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.isSettingsClosing).toBe(false);

    confirm.mockReturnValue(true);
    act(() => result.current.handleCloseSettings());
    expect(result.current.isSettingsClosing).toBe(true);
    act(() => vi.advanceTimersByTime(220));
    expect(result.current.isSettingsOpen).toBe(false);
    expect(result.current.isSettingsClosing).toBe(false);
  });

  it('cancels a pending close when settings reopen on another tab', async () => {
    const { result } = renderHook(useAppDialogs);
    await act(async () => { await eventBus.emit('ui:openSettings', { tab: 'templates' }); });
    act(() => result.current.handleCloseSettings());
    await act(async () => { await eventBus.emit('ui:openSettings', { tab: 'shortcuts' }); });
    act(() => vi.advanceTimersByTime(220));
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.isSettingsClosing).toBe(false);
    expect(result.current.settingsInitialTab).toBe('shortcuts');
  });

  it('removes the pending close timer and event subscriptions on unmount', async () => {
    const subscribe = eventBus.on.bind(eventBus);
    const unsubscribes: Array<() => void> = [];
    vi.spyOn(eventBus, 'on').mockImplementation((event, handler) => {
      const unsubscribe = vi.fn(subscribe(event, handler));
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    });
    const { result, unmount } = renderHook(useAppDialogs);
    await act(async () => { await eventBus.emit('ui:openSettings'); });
    act(() => result.current.handleCloseSettings());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    for (const unsubscribe of unsubscribes) {
      expect(unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it('retains dialogue context when opening voice authoring and defaults free text', async () => {
    const { result } = renderHook(useAppDialogs);
    await act(async () => { await eventBus.emit('ui:openVoiceWorkbench', {
      mode: 'dialogue', statementId: 'dialogue', characterId: 'alice', text: 'Hello',
    }); });
    expect(result.current.showVoiceWorkbench).toBe(true);
    expect(result.current.voiceWorkbenchContext).toMatchObject({
      mode: 'dialogue', statementId: 'dialogue', characterId: 'alice', text: 'Hello',
    });
    await act(async () => { await eventBus.emit('ui:openVoiceWorkbench'); });
    expect(result.current.voiceWorkbenchContext).toEqual({ mode: 'free', text: '' });
  });
});
