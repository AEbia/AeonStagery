import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '../SettingsStore';
import { useResizableLayout } from './useResizableLayout';
import type { InspectorPanelView } from '../timeline/InspectorViewPicker';
import type { WorkspaceToolTab } from '../workspace-tools/types';

type SidePanelView = 'inspector' | 'workspace-tools';

export function computeSidePanelWidth(params: {
  isTracksMode: boolean;
  panelWidth: number;
  inspectorNavigatorWidth: number;
  inspectorLayout: 'split' | 'replace';
  isInspectorDetailVisible: boolean;
  detailWidth: number;
  timelineLayoutMode?: 'tracks' | 'list';
}): number {
  if (params.isTracksMode) {
    return params.panelWidth;
  }
  // In list mode, inspector detail is embedded directly inside TimelineListView,
  // so sidePanelWidth remains fixed at the panel width (inspectorNavigatorWidth)
  // rather than splitting or popping out a separate side column.
  return params.inspectorNavigatorWidth;
}

/** Owns persisted panel navigation, sizing, and per-mode widths. */
export function useAppLayout(hasLoadedScene: boolean) {
  const { settings, setSetting } = useSettings();
  const inspectorDetailVisibleRef = useRef(false);
  const [isInspectorDetailVisible, setIsInspectorDetailVisible] = useState(false);
  const [sidePanelView, setSidePanelView] = useState<SidePanelView>(() => (
    settings.workbenchContextPanelOpen ? 'workspace-tools' : 'inspector'
  ));
  const [windowWidth, setWindowWidth] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth : 1920
  ));
  const [contextTab, setContextTab] = useState<WorkspaceToolTab>(() => settings.workbenchContextTab);
  const isListMode = settings.workbenchTimelineLayoutMode === 'list';
  const [initialLeftPanelWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('aeonstagery:left-panel-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!Number.isNaN(parsed)) return Math.min(420, Math.max(320, parsed));
      }
    } catch {}
    return 340;
  });
  const layoutOptions = useMemo(() => {
    const defaultWidth = isListMode ? 600 : 400;
    const initialWidth = (!settings.workbenchPanelWidth || settings.workbenchPanelWidth === 380 || (isListMode && (settings.workbenchPanelWidth === 400 || settings.workbenchPanelWidth < 560)))
      ? defaultWidth
      : settings.workbenchPanelWidth;
    return {
      initialPanelWidth: initialWidth,
      initialLeftPanelWidth,
      onLeftPanelWidthCommit: (width: number) => {
        try { localStorage.setItem('aeonstagery:left-panel-width', String(width)); } catch {}
      },
      initialDetailWidth: settings.workbenchDetailWidth,
      initialTimelineHeight: settings.workbenchTimelineHeight,
      onPanelWidthCommit: (width: number) => setSetting('workbenchPanelWidth', width),
      onDetailWidthCommit: (width: number) => setSetting('workbenchDetailWidth', width),
      onTimelineHeightCommit: (height: number) => setSetting('workbenchTimelineHeight', height),
    };
  }, [
    initialLeftPanelWidth,
    isListMode,
    settings.workbenchDetailWidth,
    settings.workbenchPanelWidth,
    settings.workbenchTimelineHeight,
    setSetting,
  ]);
  const {
    panelWidth,
    setPanelWidth,
    leftPanelWidth,
    handleLeftResizeMouseDown,
    handleLeftResizeKeyDown,
    detailWidth,
    timelineHeight,
    handleMouseDown,
    handleHeightMouseDown,
  } = useResizableLayout(layoutOptions);
  const panelWidthsByModeRef = useRef({ list: 600, tracks: 400 });
  const previousPanelModeRef = useRef(isListMode);
  useEffect(() => {
    if (previousPanelModeRef.current === isListMode) return;
    panelWidthsByModeRef.current[previousPanelModeRef.current ? 'list' : 'tracks'] = panelWidth;
    previousPanelModeRef.current = isListMode;
    const next = panelWidthsByModeRef.current[isListMode ? 'list' : 'tracks'];
    setPanelWidth(next);
    setSetting('workbenchPanelWidth', next);
  }, [isListMode, panelWidth, setPanelWidth, setSetting]);
  useEffect(() => {
    const updateWorkspaceSize = () => {
      setWindowWidth(window.innerWidth);
    };
    updateWorkspaceSize();
    window.addEventListener('resize', updateWorkspaceSize);
    return () => window.removeEventListener('resize', updateWorkspaceSize);
  }, []);

  const handleSetContextTab = useCallback((tab: WorkspaceToolTab) => {
    setContextTab(tab);
    setSetting('workbenchContextTab', tab);
  }, [setSetting]);

  const handleSetSidePanelView = useCallback((view: SidePanelView) => {
    setSidePanelView(view);
    setSetting('workbenchContextPanelOpen', view === 'workspace-tools');
  }, [setSetting]);

  const handleSelectWorkspaceView = useCallback((tab: WorkspaceToolTab) => {
    handleSetContextTab(tab);
    handleSetSidePanelView('workspace-tools');
  }, [handleSetContextTab, handleSetSidePanelView]);

  const handleSelectInspectorView = useCallback((view: InspectorPanelView) => {
    if (view === 'actions') {
      handleSetSidePanelView('inspector');
      return;
    }
    handleSelectWorkspaceView(view);
  }, [handleSelectWorkspaceView, handleSetSidePanelView]);

  const isTracksMode = settings.workbenchTimelineLayoutMode === 'tracks';
  const workspaceToolsPanelWidth = Math.max(panelWidth, 400);
  const inspectorNavigatorWidth = sidePanelView === 'workspace-tools'
    ? workspaceToolsPanelWidth
    : panelWidth;
  const availableStageWidth = windowWidth - (isTracksMode ? leftPanelWidth : 0) - inspectorNavigatorWidth - detailWidth;
  const inspectorLayout = availableStageWidth >= 720
    ? 'split'
    : 'replace';
  const sidePanelWidth = computeSidePanelWidth({
    isTracksMode,
    panelWidth,
    inspectorNavigatorWidth,
    inspectorLayout,
    isInspectorDetailVisible,
    detailWidth,
    timelineLayoutMode: settings.workbenchTimelineLayoutMode,
  });
  const navigatorPriorityActive = !isTracksMode
    && settings.workbenchTimelineLayoutMode === 'list'
    && hasLoadedScene;
  const timelinePanelWidth = isTracksMode
    ? '100%'
    : (navigatorPriorityActive ? 'auto' : '100%');
  const timelinePanelMarginRight = isTracksMode
    ? 0
    : (navigatorPriorityActive ? inspectorNavigatorWidth : 0);

  const handleInspectorDetailVisibilityChange = useCallback((visible: boolean) => {
    if (inspectorDetailVisibleRef.current === visible) return;
    inspectorDetailVisibleRef.current = visible;
    setIsInspectorDetailVisible(visible);
  }, []);

  return {
    contextTab, sidePanelView, isTracksMode, leftPanelWidth, sidePanelWidth,
    inspectorNavigatorWidth, isInspectorDetailVisible, navigatorPriorityActive,
    timelinePanelWidth, timelinePanelMarginRight, timelineHeight,
    handleLeftResizeMouseDown, handleLeftResizeKeyDown, handleMouseDown, handleHeightMouseDown,
    handleInspectorDetailVisibilityChange, handleSelectInspectorView,
    handleSetContextTab, handleSetSidePanelView, handleSelectWorkspaceView,
  };
}
