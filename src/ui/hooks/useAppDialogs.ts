import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { eventBus } from '../../api/events';
import { useSettings } from '../SettingsStore';
import { isSettingsDialogTab } from '../settingsNavigation';
import type { SettingsDialogTab } from '../SettingsDialog';
import { defaultChangelogService } from '../../services/announcements/ChangelogService';
import { detectLive2DRuntimeStatus } from '../../services/live2d/live2dRuntimeDetection';
import type { Live2DRuntimeStatusReport } from '../../api/types/live2dRuntime';

export function useAppDialogs() {
  const { settings } = useSettings();
  const [isPerformanceProfileEditorDirty, setIsPerformanceProfileEditorDirty] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showWebGalRegenerate, setShowWebGalRegenerate] = useState(false);
  const [showAIWorkbench, setShowAIWorkbench] = useState(false);
  const [showVoiceWorkbench, setShowVoiceWorkbench] = useState(false);
  const [voiceWorkbenchContext, setVoiceWorkbenchContext] = useState<import('../voice/VoiceWorkbench').VoiceWorkbenchContext>({ mode: 'free' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsClosing, setIsSettingsClosing] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsDialogTab>('general');
  const settingsCloseTimerRef = useRef<number | null>(null);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const hasCheckedAutoChangelogRef = useRef(false);

  const hasUnreadChangelog = useMemo(() => {
    return defaultChangelogService.hasUnread(
      settings.lastReadChangelogId,
      settings.readAnnouncementIds,
    );
  }, [settings.lastReadChangelogId, settings.readAnnouncementIds]);
  const [showLive2DRuntimeDialog, setShowLive2DRuntimeDialog] = useState(false);
  const [live2DRuntimeReport, setLive2DRuntimeReport] = useState<Live2DRuntimeStatusReport | null>(null);
  const showLive2DRuntimeSetupOnStartupRef = useRef(settings.showLive2DRuntimeSetupOnStartup);

  useEffect(() => {
    let mounted = true;
    void detectLive2DRuntimeStatus().then((report) => {
      if (!mounted) return;
      setLive2DRuntimeReport(report);
      console.info(
        `[Live2D] Startup runtime status: cubism2=${report.cubism2}, cubism3Plus=${report.cubism3Plus}, missingAny=${report.missingAny}`,
      );
      if (report.missingAny && showLive2DRuntimeSetupOnStartupRef.current) {
        setShowLive2DRuntimeDialog(true);
      }
    }).catch((err) => {
      console.warn('[Live2D] Failed to detect runtime status on startup:', err);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    return eventBus.on('ui:openLive2DRuntimeDialog', () => {
      setShowLive2DRuntimeDialog(true);
    });
  }, []);

  // Auto-prompt changelog on startup after an update
  useEffect(() => {
    if (hasCheckedAutoChangelogRef.current) return;
    hasCheckedAutoChangelogRef.current = true;

    const autoShow = settings.autoShowChangelogOnUpdate ?? true;
    if (!autoShow) return;

    const latestRelease = defaultChangelogService.getLatestRelease();
    if (!latestRelease?.version) return;

    const isUnread = defaultChangelogService.isItemUnread(
      latestRelease,
      settings.lastReadChangelogId,
      settings.readAnnouncementIds,
    );

    if (isUnread) {
      setIsChangelogOpen(true);
    }
  }, [settings.autoShowChangelogOnUpdate, settings.lastReadChangelogId, settings.readAnnouncementIds]);

  useEffect(() => {
    return eventBus.on('ui:openChangelog', () => {
      setIsChangelogOpen(true);
    });
  }, []);

  useEffect(() => eventBus.on('ui:openVoiceWorkbench', (payload: unknown) => {
    const requested = payload && typeof payload === 'object' ? payload as Partial<import('../voice/VoiceWorkbench').VoiceWorkbenchContext> : {};
    setVoiceWorkbenchContext(requested.mode === 'dialogue' ? {
      mode: 'dialogue',
      statementId: requested.statementId,
      sceneId: requested.sceneId,
      characterId: requested.characterId,
      characterName: requested.characterName,
      voiceProfileId: requested.voiceProfileId,
      text: requested.text ?? '',
    } : { mode: 'free', text: requested.text ?? '' });
    setShowVoiceWorkbench(true);
  }), []);

  useEffect(() => {
    const unsubscribeOpenSettings = eventBus.on('ui:openSettings', (payload: unknown) => {
      if (settingsCloseTimerRef.current !== null) {
        window.clearTimeout(settingsCloseTimerRef.current);
        settingsCloseTimerRef.current = null;
      }
      const requestedTab = typeof payload === 'object' && payload && 'tab' in payload
        ? (payload as { tab?: unknown }).tab
        : null;
      setSettingsInitialTab(
        isSettingsDialogTab(requestedTab) ? requestedTab : 'general',
      );
      setIsSettingsClosing(false);
      setIsSettingsOpen(true);
    });

    return () => {
      if (settingsCloseTimerRef.current !== null) {
        window.clearTimeout(settingsCloseTimerRef.current);
      }
      unsubscribeOpenSettings();
    };
  }, []);

  const handleCloseSettings = useCallback(() => {
    if (!isSettingsOpen || isSettingsClosing) return;
    if (isPerformanceProfileEditorDirty && !window.confirm('AI 表演模板有未保存修改。仍要关闭设置并丢弃这些修改吗？')) return;
    setIsSettingsClosing(true);
    settingsCloseTimerRef.current = window.setTimeout(() => {
      setIsSettingsOpen(false);
      setIsSettingsClosing(false);
      settingsCloseTimerRef.current = null;
    }, 220);
  }, [isPerformanceProfileEditorDirty, isSettingsClosing, isSettingsOpen]);

  const handleRestartApp = useCallback(async () => {
    const confirmed = window.confirm('确认重新启动应用？未保存的更改可能会丢失。');
    if (!confirmed) {
      return;
    }
    await window.aeonStageryAPI.app.restart();
  }, []);

  return {
    showExport, setShowExport, showWebGalRegenerate, setShowWebGalRegenerate,
    showAIWorkbench, setShowAIWorkbench, showVoiceWorkbench, setShowVoiceWorkbench,
    voiceWorkbenchContext, isSettingsOpen, isSettingsClosing, settingsInitialTab,
    hasUnreadChangelog, isChangelogOpen, setIsChangelogOpen,
    showLive2DRuntimeDialog, setShowLive2DRuntimeDialog, live2DRuntimeReport,
    setIsPerformanceProfileEditorDirty, handleCloseSettings, handleRestartApp,
  };
}
