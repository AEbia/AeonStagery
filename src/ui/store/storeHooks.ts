import { useState, useEffect, useSyncExternalStore, useCallback, useMemo } from 'react';
import {
  useApp,
  useDocumentStore,
  useEditorStore,
  usePlaybackAdapter,
  useTimelineAdapter,
  useSceneFileService,
  useSemanticAuthoringService,
  useValidationStore,
  useCollaborationStatus,
  isCollaborationUndoDisabled
} from '../context/AppContext';
import { showToast } from '../Toast';
import type { SaveResult } from '../../services/io/SceneFileService';

export function useSemanticDocument() {
  const store = useDocumentStore();
  const getVersion = useCallback(() => store.version, [store]);
  const getFilePath = useCallback(() => store.filePath, [store]);

  const version = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getVersion,
  );
  const documentSnapshot = useMemo(
    () => ({ document: store.getCurrentSceneDocumentSnapshot(), version }),
    [store, version],
  );
  const document = documentSnapshot.document;
  const path = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getFilePath,
  );

  return {
    document,
    filePath: path,
  };
}

// ── useEditorTime ─────────────────────────────────────────────────

export function useEditorDuration() {
  const playbackStore = useApp().stores.playback;
  const subscribe = useCallback((listener: () => void) => playbackStore.subscribe(listener), [playbackStore]);
  const getDuration = useCallback(() => playbackStore.duration, [playbackStore]);

  return useSyncExternalStore(subscribe, getDuration, getDuration);
}

export function useEditorTime() {
  const adapter = usePlaybackAdapter();
  const playbackStore = useApp().stores.playback;
  const [time, setTime] = useState(adapter.getCurrentTime());
  const duration = useEditorDuration();

  useEffect(() => {
    const unsub = adapter.subscribeTime((t: number) => {
      setTime(t);
    });
    
    return unsub;
  }, [adapter]);

  return {
    currentTime: time,
    duration: duration,
    setCurrentTime: (t: number, _force?: boolean) => {
      adapter.seek(t);
    },
    setDuration: (d: number) => {
      playbackStore.setDuration(d);
    },
  };
}

// ── useEditorSelection ───────────────────────────────────────────

export function useEditorSelection() {
  const store = useEditorStore();
  const timelineAdapter = useTimelineAdapter();
  const getSelectedIds = useCallback(
    () => (store as any).selectedActionIdsSnapshot ?? store.selectedActionIds,
    [store]
  );
  const selectedIds = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getSelectedIds
  );

  return {
    selectedActionIds: selectedIds,
    setSelectedIds: (ids: Record<string, boolean>) => timelineAdapter.select(ids),
  };
}

export function useSelectedActionCount() {
  const store = useEditorStore();
  const getSelectedCount = useCallback(
    () => ((store as any).selectedCount as number) ?? Object.keys(store.selectedActionIds).length,
    [store]
  );

  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getSelectedCount
  );
}

export function useFirstSelectedActionId() {
  const store = useEditorStore();
  const getFirstSelectedId = useCallback(() => {
    const explicit = (store as any).firstSelectedId as string | null | undefined;
    if (explicit !== undefined) return explicit;
    const selectedIds = store.selectedActionIds;
    for (const id of Object.keys(selectedIds)) {
      if (selectedIds[id]) return id;
    }
    return null;
  }, [store]);

  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getFirstSelectedId
  );
}

// ── useEditorSettings ─────────────────────────────────────────────

export function useEditorSettings() {
  const store = useApp().stores.editor;
  const getPixelsPerSecond = useCallback(() => store.pixelsPerSecond, [store]);
  const getGizmosVisible = useCallback(() => store.gizmosVisible, [store]);

  const pps = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getPixelsPerSecond
  );
  const gizmos = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getGizmosVisible
  );

  return {
    pixelsPerSecond: pps,
    gizmosVisible: gizmos,
    setPixelsPerSecond: (p: number) => {
      store.setPixelsPerSecond(p);
    },
    setGizmosVisible: (v: boolean) => {
      store.setGizmosVisible(v);
    },
  };
}

export function useEditorPixelsPerSecond() {
  const store = useApp().stores.editor;
  const getPixelsPerSecond = useCallback(() => store.pixelsPerSecond, [store]);

  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getPixelsPerSecond
  );
}

export function useGizmosVisible() {
  const store = useApp().stores.editor;
  const getGizmosVisible = useCallback(() => store.gizmosVisible, [store]);
  const gizmosVisible = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getGizmosVisible
  );

  return {
    gizmosVisible,
    setGizmosVisible: (v: boolean) => {
      store.setGizmosVisible(v);
    },
  };
}

// ── useCustomMotionEditorActionId ─────────────────────────────────
/** 当前在轨道区展开关键帧编辑器的动作 id（null 表示未展开）。 */
export function useCustomMotionEditorActionId() {
  const store = useEditorStore();
  const getActionId = useCallback(
    () => store?.customMotionEditorActionId ?? null,
    [store],
  );

  return useSyncExternalStore(
    (listener) => (typeof store?.subscribe === 'function' ? store.subscribe(listener) : () => {}),
    getActionId,
  );
}

// ── useEditorSaveStatus ───────────────────────────────────────────

export function useEditorSaveStatus() {
  const store = useEditorStore();
  const getSaveStatus = useCallback(() => store?.saveStatus ?? 'idle', [store]);
  const saveStatus = useSyncExternalStore(
    (listener) => (typeof store?.subscribe === 'function' ? store.subscribe(listener) : () => {}),
    getSaveStatus
  );

  return { saveStatus };
}

// ── useEditorStatus ───────────────────────────────────────────────

export function useEditorStatus() {
  const playbackStore = useApp().stores.playback;
  const editorStore = useApp().stores.editor;
  
  const [isPlaying, setIsPlaying] = useState(playbackStore.playing);
  const [engineStatus, setEngineStatus] = useState(playbackStore.engineStatus);
  const [saveStatus, setSaveStatus] = useState(editorStore.saveStatus);

  useEffect(() => {
    const playListener = () => {
      setIsPlaying(playbackStore.playing);
      setEngineStatus(playbackStore.engineStatus);
    };
    const unsubPlay = playbackStore.subscribe(playListener);

    const editListener = () => {
      setSaveStatus(editorStore.saveStatus);
    };
    const unsubEdit = editorStore.subscribe(editListener);

    return () => {
      unsubPlay();
      unsubEdit();
    };
  }, [playbackStore, editorStore]);

  return {
    saveStatus,
    engineStatus,
    isPlaying,
    setEngineStatus: (s: string) => playbackStore.setEngineStatus(s),
    setIsPlaying: (p: boolean) => playbackStore.setPlaying(p),
    setDuration: (d: number) => playbackStore.setDuration(d),
  };
}

// ── useEditorState (composite) ────────────────────────────────────

export function useEditorState() {
  const documentStore = useDocumentStore();
  const select = useEditorSelection();
  const settings = useEditorSettings();
  const status = useEditorStatus();
  const sceneFileService = useSceneFileService();
  const semanticAuthoring = useSemanticAuthoringService();
  const collaborationStatus = useCollaborationStatus();
  const collaborationUndoDisabled = isCollaborationUndoDisabled(collaborationStatus);
  const getFilePath = useCallback(() => documentStore.filePath, [documentStore]);
  const filePath = useSyncExternalStore(
    (listener) => documentStore.subscribe(listener),
    getFilePath,
  );

  return {
    filePath, ...select, ...settings, ...status,
    handleSave: async (): Promise<SaveResult | undefined> => {
      if (sceneFileService) {
        const res = await sceneFileService.save();
        if (res.success) {
          showToast('剧本保存成功！', 'success');
        } else if ('error' in res) {
          showToast(`剧本保存失败: ${res.error}`, 'error');
        } else if ('cancelled' in res) {
          // Explicitly matched: User cancelled dialog. No error toast shown.
        }
        return res;
      }
      return undefined;
    },
    handleSaveAs: async (): Promise<SaveResult | undefined> => {
      if (sceneFileService) {
        const res = await sceneFileService.saveAs();
        if (res.success) {
          showToast('剧本另存为成功！', 'success');
        } else if ('error' in res) {
          showToast(`剧本另存为失败: ${res.error}`, 'error');
        } else if ('cancelled' in res) {
          // Explicitly matched: User cancelled dialog. No error toast shown.
        }
        return res;
      }
      return undefined;
    },
    undo: () => {
      if (collaborationUndoDisabled) {
        showToast('协作模式暂不支持撤销', 'info');
        return;
      }
      void semanticAuthoring?.undo();
    },
    redo: () => {
      if (collaborationUndoDisabled) {
        showToast('协作模式暂不支持重做', 'info');
        return;
      }
      void semanticAuthoring?.redo();
    },
    loadExample: async (): Promise<boolean> => {
      if (sceneFileService) {
        const res = await sceneFileService.loadExample();
        if (res.success) {
          showToast('已加载默认示例剧本', 'success');
          if (res.issues && res.issues.length > 0) {
            const errors = res.issues.filter((i: any) => i.severity === 'error');
            const warnings = res.issues.filter((i: any) => i.severity === 'warning');
            const parts: string[] = [];
            if (errors.length) parts.push(`${errors.length} 个错误`);
            if (warnings.length) parts.push(`${warnings.length} 个警告`);
            showToast(`场景校验: ${parts.join('，')} — 查看控制台了解详情`, 'warning');
          }
          return true;
        } else if ('error' in res) {
          showToast(`加载示例剧本失败: ${res.error}`, 'error');
        }
      }
      return false;
    },
    loadFile: async (): Promise<boolean> => {
      if (sceneFileService) {
        const res = await sceneFileService.loadFile();
        if (res.success) {
          showToast('剧本加载成功！', 'success');
          if (res.issues && res.issues.length > 0) {
            const errors = res.issues.filter((i: any) => i.severity === 'error');
            const warnings = res.issues.filter((i: any) => i.severity === 'warning');
            const parts: string[] = [];
            if (errors.length) parts.push(`${errors.length} 个错误`);
            if (warnings.length) parts.push(`${warnings.length} 个警告`);
            showToast(`场景校验: ${parts.join('，')} — 查看控制台了解详情`, 'warning');
          }
          return true;
        } else if ('error' in res) {
          showToast(`加载剧本失败: ${res.error}`, 'error');
        }
      }
      return false;
    },
  };
}

// ── Validation hooks ──────────────────────────────────────────────

export function useValidationIssues() {
  const store = useValidationStore();

  const getIssues = useCallback(() => store?.issues ?? [], [store]);
  const getLoading = useCallback(() => store?.loading ?? false, [store]);
  const subscribe = useCallback(
    (listener: () => void) => (typeof store?.subscribe === 'function' ? store.subscribe(listener) : () => {}),
    [store],
  );

  const issues = useSyncExternalStore(
    subscribe,
    getIssues
  );

  const loading = useSyncExternalStore(
    subscribe,
    getLoading
  );

  return {
    issues,
    loading,
    errorsCount: store?.errorsCount ?? 0,
    warningsCount: store?.warningsCount ?? 0,
  };
}

export function useValidationSummary() {
  const store = useValidationStore();
  const getErrorsCount = useCallback(() => store.errorsCount, [store]);
  const getWarningsCount = useCallback(() => store.warningsCount, [store]);

  const errorsCount = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getErrorsCount
  );
  const warningsCount = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getWarningsCount
  );

  return { errorsCount, warningsCount };
}

export function useDocumentTitle() {
  const store = useDocumentStore();
  const getTitle = useCallback(() => store.getCurrentSceneDocumentSnapshot()?.meta?.title || '', [store]);

  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getTitle
  );
}

export function usePlaybackSummary() {
  const store = useApp().stores.playback;
  const getDuration = useCallback(() => store.duration, [store]);
  const getEngineStatus = useCallback(() => store.engineStatus, [store]);

  const duration = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getDuration
  );
  const engineStatus = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getEngineStatus
  );

  return { duration, engineStatus };
}

export function useActionValidationSeverity(actionId: string) {
  const store = useValidationStore();

  const getSeverity = useCallback(() => {
    return store.getSeverityByActionId(actionId);
  }, [store, actionId]);

  const severity = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    getSeverity
  );

  return severity;
}
