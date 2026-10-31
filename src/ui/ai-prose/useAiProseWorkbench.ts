import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_SCRIPT_READING_SPEED,
  type AiProseAnchorMode,
  type AiProseProviderConfig,
} from '../../api/types/ai-prose-authoring';
import {
  buildAiProseDeterministicPreview,
  splitAiProseNormalizationTasks,
} from '../../services/ai-authoring/AiProseDeterministicCompiler';
import type { EnhancementStagePlanV1 } from '../../services/ai-authoring/FormalEnhancementApply';
import {
  createDraft,
  duplicateAppliedDraft,
  replacePreview,
  setCharacterBinding,
  updateScriptReadingSpeed,
  updateSourceText,
  updateTargetBatchSize,
  type DraftSession,
} from '../../services/ai-authoring/AiProseDraftSession';
import { projectDraftSemanticScene } from '../../services/ai-authoring/CharacterBindingPlan';
import {
  restoreEnhancementState,
  replayEnhancementState,
  enhancementStagePlanFromState,
} from '../../services/ai-authoring/AiProseEnhancementRestore';
import { createAiProseEnhancementBaseFingerprint } from '../../services/ai-authoring/AiProseEnhancementState';
import type {
  AiProseAuthoringComposition,
} from '../../services/ai-authoring/AiProseAuthoringComposition';
import type {
  AiProseElectronCredentialController,
  AiProseElectronProviderController,
} from '../../services/ai-authoring/AiProseElectronTransport';
import {
  visibleCharacterCount,
  spokenCharacterCount,
} from '../../services/ai-authoring/AiProseTextMetrics';
import { useAiRequestTrace } from '../AiProseTrace';
import {
  useApp,
  useDocumentStore,
} from '../context/AppContext';
import { useEditorTime, useSemanticDocument } from '../store/storeHooks';
import { normalizeScriptReadingSpeed, useSettings } from '../SettingsStore';
import { showToast } from '../Toast';
import { useModalDialog } from '../hooks/useModalDialog';
import { useEnhancementCapabilityPorts } from '../hooks/useEnhancementCapabilityPorts';

import { runDraftEnhancement } from './runDraftEnhancement';
import { useAiProsePipeline } from './useAiProsePipeline';
import { STAGES, createWorkbenchErrorInfo, getErrorMessage, type WorkbenchStage, type WorkbenchErrorInfo } from './workbenchPresentation';

function getCredentialController(
  composition: AiProseAuthoringComposition | undefined,
): AiProseElectronCredentialController | undefined {
  const transport = composition?.transport as Partial<AiProseElectronCredentialController> | undefined;
  if (!transport
    || typeof transport.getCredentialStatus !== 'function'
    || typeof transport.setCredential !== 'function'
    || typeof transport.clearCredential !== 'function') {
    return undefined;
  }
  return transport as AiProseElectronCredentialController;
}

function getProviderController(
  composition: AiProseAuthoringComposition | undefined,
): AiProseElectronProviderController | undefined {
  const transport = composition?.transport as Partial<AiProseElectronProviderController> | undefined;
  return typeof transport?.configureProvider === 'function'
    ? transport as AiProseElectronProviderController
    : undefined;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function getSourceLines(sourceText: string): string[] {
  return sourceText.split(/\r?\n/u);
}

export function useAiProseWorkbench(onClose?: () => void) {
  const app = useApp();
  const documentStore = useDocumentStore();
  const documentVersion = documentStore.version;
  const composition = app.services?.aiProse;
  const projectWorkspace = app.services?.projectWorkspace;
  const { document } = useSemanticDocument();
  const { currentTime } = useEditorTime();
  const { settings, setSetting } = useSettings();
  const [draft, setDraftState] = useState<DraftSession | null>(null);
  const draftRef = useRef<DraftSession | null>(null);
  const [activeStage, setActiveStage] = useState<WorkbenchStage>('source');
  const [sourceText, setSourceText] = useState('');
  const [sourceName, setSourceName] = useState('source.txt');
  const [mainCharacters, setMainCharacters] = useState<string[]>([]);
  const [anchorMode, setAnchorMode] = useState<AiProseAnchorMode>('zero');
  const [targetBatchSize, setTargetBatchSize] = useState(DEFAULT_AI_TARGET_BATCH_SIZE);
  const [scriptReadingSpeed, setScriptReadingSpeed] = useState(DEFAULT_SCRIPT_READING_SPEED);
  const [busyStage, setBusyStage] = useState<WorkbenchStage | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorInfo, setErrorInfo] = useState<WorkbenchErrorInfo | null>(null);
  const [persistenceMessage, setPersistenceMessage] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [initializationMessage, setInitializationMessage] = useState('');
  const [traceOpen, setTraceOpen] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState(0);
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'dialogue' | 'narration'>('all');
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [enableActing, setEnableActing] = useState(false);
  const [enableCinematic, setEnableCinematic] = useState(false);
  const [enhancementBusy, setEnhancementBusy] = useState(false);
  const [enhancementMessage, setEnhancementMessage] = useState('');
  const [enhancementStagePlan, setEnhancementStagePlan] = useState<EnhancementStagePlanV1 | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const initializationKeyRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dialogRef = useModalDialog(onClose ?? (() => {}), !!onClose);

  const getProject = useCallback(
    () => projectWorkspace?.getCurrentProject() ?? null,
    [projectWorkspace],
  );
  const subscribeProject = useCallback(
    (listener: () => void) => projectWorkspace?.subscribe(listener) ?? (() => {}),
    [projectWorkspace],
  );
  const project = useSyncExternalStore(subscribeProject, getProject, () => null);
  const aiSettings = settings.aiProse;
  const configuredScriptReadingSpeed = settings.scriptReadingSpeed || DEFAULT_SCRIPT_READING_SPEED;
  const initializationIdentity = composition && project && document
    ? `${project.rootPath}:${document.sceneId}`
    : null;
  const aiTrace = useAiRequestTrace({ effort: aiSettings.effort });
  const {
    reset: resetAiTrace,
    setRuntimeState: setAiTraceRuntimeState,
  } = aiTrace;

  // Shared with the formal enhancement panel: the same capability ports must
  // drive run-time orchestration and restore-time fingerprint replay so unit
  // fingerprints stay consistent across a restart.
  const capabilityPorts = useEnhancementCapabilityPorts({
    document,
    characterAdapter: app.adapters.character,
    templatePackages: app.services?.templatePackages ?? null,
    enabledTemplateIds: project?.metadata.templates?.enabledTemplateIds ?? null,
  });
  // Restore reads the latest ports at replay time; keeping them out of the
  // restore effect deps prevents the effect from restarting (and canceling)
  // when model capabilities finish loading after mount.
  const capabilityPortsRef = useRef(capabilityPorts);
  capabilityPortsRef.current = capabilityPorts;

  const setDraft = useCallback((next: DraftSession | null) => {
    draftRef.current = next;
    setDraftState(next);
    setEnhancementStagePlan(null);
  }, []);

  const compositionRef = useRef(composition);
  compositionRef.current = composition;
  const projectRef = useRef(project);
  projectRef.current = project;
  const documentRef = useRef(document);
  documentRef.current = document;
  const documentVersionRef = useRef(documentVersion);
  documentVersionRef.current = documentVersion;
  const restoreDefaultsRef = useRef({
    anchorMode,
    currentTime,
    targetBatchSize: aiSettings.targetBatchSize,
    scriptReadingSpeed: configuredScriptReadingSpeed,
  });
  restoreDefaultsRef.current = {
    anchorMode,
    currentTime,
    targetBatchSize: aiSettings.targetBatchSize,
    scriptReadingSpeed: configuredScriptReadingSpeed,
  };

  const clearError = useCallback(() => {
    setErrorMessage('');
    setErrorInfo(null);
  }, []);

  const reportError = useCallback((error: unknown, stage?: WorkbenchStage) => {
    const info = createWorkbenchErrorInfo(error, stage);
    console.error('[AI prose workbench]', info);
    setErrorInfo(info);
    setErrorMessage(info.message);
    setAiTraceRuntimeState('failed');
  }, [setAiTraceRuntimeState]);

  const clearErrorRef = useRef(clearError);
  clearErrorRef.current = clearError;
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;

  const queueSave = useCallback((next: DraftSession): Promise<void> => {
    if (!composition || !project) return Promise.resolve();
    const operation = saveQueueRef.current.then(async () => {
      try {
        await composition.draftPersistence.saveCheckpoint(project, next);
        setPersistenceMessage('');
      } catch (error) {
        setPersistenceMessage(`草稿保存失败：${getErrorMessage(error)}`);
      }
    });
    saveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  }, [composition, project]);

  const persistDraft = useCallback((next: DraftSession, immediate = false): Promise<void> | void => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (immediate) return queueSave(next);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void queueSave(next);
    }, 260);
  }, [queueSave]);

  const commitDraft = useCallback((next: DraftSession, immediate = false) => {
    setDraft(next);
    setSourceText(next.sourceText);
    setTargetBatchSize(next.targetBatchSize);
    setScriptReadingSpeed(next.scriptReadingSpeed);
    setMainCharacters(next.mainCharactersConfirmed
      ? [...next.confirmedMainCharacters]
      : next.characterExtraction.suggestedNames.length > 0
        ? [...next.characterExtraction.suggestedNames]
        : [...next.confirmedMainCharacters]);
    persistDraft(next, immediate);
  }, [persistDraft, setDraft]);

  useEffect(() => {
    const currentComposition = compositionRef.current;
    const currentProject = projectRef.current;
    const currentDocument = documentRef.current;
    if (!initializationIdentity || !currentComposition || !currentProject || !currentDocument) {
      initializationKeyRef.current = null;
      setInitializing(false);
      setDraftRef.current(null);
      return;
    }
    const identity = initializationIdentity;
    if (initializationKeyRef.current === identity) return;
    initializationKeyRef.current = identity;
    let cancelled = false;
    setInitializing(true);
    setInitializationMessage('正在恢复本地草稿…');
    clearErrorRef.current();
    setPersistenceMessage('');

    const restore = async () => {
      const storage = getStorage();
      const pointerKey = `aeonstagery.ai-prose.${currentDocument.sceneId}.session`;
      const savedSessionId = storage?.getItem(pointerKey);
      let restored: DraftSession | null = null;
      if (savedSessionId) {
        const result = await currentComposition.draftPersistence.loadResult(currentProject, currentDocument.sceneId, savedSessionId);
        if (result.status === 'loaded') {
          if (result.draft.status === 'active') {
            restored = result.draft;
          } else {
            setInitializationMessage('上一次草稿已经应用，当前展示为新草稿入口。');
          }
        } else if (result.status !== 'missing') {
          throw result.error;
        }
      }
      if (!restored) {
        const restoreDefaults = restoreDefaultsRef.current;
        restored = createDraft({
          sceneId: currentDocument.sceneId,
          sourceText: '',
          anchorMode: restoreDefaults.anchorMode,
          playheadTime: restoreDefaults.currentTime,
          targetBatchSize: restoreDefaults.targetBatchSize,
          scriptReadingSpeed: restoreDefaults.scriptReadingSpeed,
        });
        storage?.setItem(pointerKey, restored.sessionId);
      }
      if (cancelled) return;
      setDraftRef.current(restored);
      setSourceText(restored.sourceText);
      setTargetBatchSize(restored.targetBatchSize);
      setScriptReadingSpeed(restored.scriptReadingSpeed);
      setAnchorMode(restored.anchorMode);
      setMainCharacters(restored.mainCharactersConfirmed
        ? [...restored.confirmedMainCharacters]
        : restored.characterExtraction.suggestedNames.length > 0
          ? [...restored.characterExtraction.suggestedNames]
          : [...restored.confirmedMainCharacters]);
      setInitializing(false);
      if (!restored.sourceText) setInitializationMessage('输入完整正文后即可开始分段。');
      else setInitializationMessage('已恢复上次草稿；成功的故事段会被保留。');

      if (restored.status === 'active'
        && restored.enhancement
        && restored.preview
        && restored.characterBindingPlan) {
        try {
          const plan = restored.characterBindingPlan;
          if (plan.status === 'ambiguous') {
            setEnhancementMessage(
              `角色绑定存在歧义：${plan.ambiguous.map((item) => item.name).join('、')}。请重新选择后运行增强。`,
            );
          } else {
            const restoredState = restoreEnhancementState({
              state: restored.enhancement,
              baseFingerprint: createAiProseEnhancementBaseFingerprint(restored),
              currentBindingPlan: plan,
            });
            const boundDocumentVersion = restoredState.boundDocumentVersion;
            if (boundDocumentVersion !== undefined && boundDocumentVersion !== documentVersionRef.current) {
              setEnhancementMessage('场景已变化，请重新运行增强。');
            } else {
              const latestDocument = documentRef.current ?? currentDocument;
              const projected = projectDraftSemanticScene({
                baseDocument: latestDocument,
                plan,
                confirmedMainCharacters: restored.confirmedMainCharacters,
                previewStatements: restored.preview.statements.map((statement) => ({
                  speaker: statement.speaker,
                  text: statement.text,
                  time: statement.time,
                  durationSeconds: statement.durationSeconds,
                })),
              });
              const { state } = replayEnhancementState({
                document: projected,
                state: restoredState,
                ports: {
                  modelCapabilities: capabilityPortsRef.current.modelCapabilityPort,
                  cinematicCapabilities: capabilityPortsRef.current.cinematicCapabilityPort,
                  profileProvider: capabilityPortsRef.current.profileProvider,
                },
              });
              const stagePlan = enhancementStagePlanFromState(state);
              setEnhancementStagePlan(stagePlan.stages.length > 0 ? stagePlan : null);
              const invalidUnits = (state.performance?.units.filter((unit) => unit.status !== 'succeeded').length ?? 0)
                + (state.cinematic?.units.filter((unit) => unit.status !== 'succeeded').length ?? 0);
              setEnhancementMessage(invalidUnits > 0
                ? `已恢复可选增强进度：${invalidUnits} 个处理单元需要重新运行。`
                : '已恢复可选增强结果，可以直接应用。');
            }
          }
        } catch (error) {
          setEnhancementMessage(`增强状态恢复失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    void restore().catch((error) => {
      if (cancelled) return;
      setInitializing(false);
      setDraftRef.current(null);
      setInitializationMessage('草稿未能恢复');
      reportErrorRef.current(error);
    });
    return () => {
      cancelled = true;
    };
  }, [initializationIdentity]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    if (!composition) return;
    const configuration = composition.configuration as typeof composition.configuration & {
      updateProvider?: (provider: AiProseProviderConfig) => void;
    };
    try {
      const provider = {
        endpoint: aiSettings.baseUrl,
        defaultModel: aiSettings.defaultModel,
        projectAgentModel: aiSettings.projectAgentModel,
        modelOverrides: aiSettings.modelOverrides,
        jsonOutputSupported: aiSettings.jsonOutputSupported,
      } satisfies AiProseProviderConfig;
      configuration.updateProvider?.(provider);
      composition.configuration.updateRequestSettings({
        targetBatchSize: aiSettings.targetBatchSize,
        maxConcurrentAiRequests: aiSettings.maxConcurrentAiRequests,
        effort: aiSettings.effort,
      });
      const providerController = getProviderController(composition);
      if (providerController) {
        void providerController.configureProvider(provider).then((result) => {
          if (!result.success) reportError(`AI 设置无效：${result.error ?? 'provider 配置失败'}`);
        }).catch((error) => {
          reportError(`AI 设置同步失败：${getErrorMessage(error)}`);
        });
      }
    } catch (error) {
      reportError(`AI 设置无效：${getErrorMessage(error)}`);
    }
  }, [aiSettings, composition, reportError]);

  useEffect(() => {
    setScriptReadingSpeed(draft?.scriptReadingSpeed ?? configuredScriptReadingSpeed);
  }, [configuredScriptReadingSpeed, draft?.scriptReadingSpeed]);

  useEffect(() => {
    const controller = getCredentialController(composition);
    if (!controller) {
      setCredentialConfigured(false);
      return;
    }
    void controller.getCredentialStatus()
      .then((status) => setCredentialConfigured(status.configured))
      .catch(() => setCredentialConfigured(false));
  }, [composition]);

  const { runPrepare, runNormalization, retryNormalizationSegment, runRhythm } = useAiProsePipeline({
    composition, project, draftRef, aiTrace, setDraft, commitDraft, reportError,
    clearError, setMainCharacters, setBusyStage, setActiveStage,
  });

  const handleSourceChange = useCallback((value: string) => {
    setSourceText(value);
    const currentDraft = draftRef.current;
    if (!currentDraft || value === currentDraft.sourceText) return;
    const next = updateSourceText(currentDraft, value);
    commitDraft(next, false);
    setActiveStage('source');
    clearError();
  }, [clearError, commitDraft]);

  const handleTargetBatchSizeChange = useCallback((value: number) => {
    const safe = Math.max(1000, Math.min(12000, Math.round(value)));
    setTargetBatchSize(safe);
    setSetting('aiProse', { ...aiSettings, targetBatchSize: safe });
    const currentDraft = draftRef.current;
    if (!currentDraft || currentDraft.targetBatchSize === safe) return;
    const next = updateTargetBatchSize(currentDraft, safe);
    commitDraft(next, true);
    setActiveStage('segments');
  }, [aiSettings, commitDraft, setSetting]);

  const handleReadingSpeedChange = useCallback((value: number) => {
    const safe = normalizeScriptReadingSpeed(value);
    setScriptReadingSpeed(safe);
    setSetting('scriptReadingSpeed', safe);
    const currentDraft = draftRef.current;
    if (!currentDraft) return;
    let next = updateScriptReadingSpeed(currentDraft, safe);
    if (next.normalization.length > 0 && next.normalization.every((task) => task.status === 'succeeded')) {
      try {
        next = replacePreview(next, buildAiProseDeterministicPreview(
          next.normalization,
          next.rhythm,
          next.anchorTime,
          { scriptReadingSpeed: safe },
        ));
      } catch {
        // A partial draft remains a valid checkpoint; preview will be rebuilt by timing.
      }
    }
    commitDraft(next, true);
  }, [commitDraft, setSetting]);

  const handleBindingChange = useCallback((name: string, characterId: string) => {
    const currentDraft = draftRef.current;
    if (!currentDraft) return;
    try {
      commitDraft(setCharacterBinding(currentDraft, name, characterId), true);
    } catch (error) {
      reportError(error, 'characters');
    }
  }, [commitDraft, reportError]);

  const startNewDraft = useCallback(() => {
    if (!document) return;
    resetAiTrace();
    const next = createDraft({
      sceneId: document.sceneId,
      sourceText: '',
      anchorMode,
      playheadTime: currentTime,
      targetBatchSize: aiSettings.targetBatchSize,
      scriptReadingSpeed: configuredScriptReadingSpeed,
    });
    getStorage()?.setItem(`aeonstagery.ai-prose.${document.sceneId}.session`, next.sessionId);
    commitDraft(next, true);
    setActiveStage('source');
    setAiTraceRuntimeState('idle');
    setInitializationMessage('新草稿已创建；可以输入完整正文。');
    clearError();
  }, [aiSettings.targetBatchSize, anchorMode, clearError, commitDraft, configuredScriptReadingSpeed, currentTime, document, resetAiTrace, setAiTraceRuntimeState]);

  const handleRunDraftEnhancement = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!composition || !document || !currentDraft?.preview) return;
    if (!enableActing && !enableCinematic) {
      setEnhancementMessage('请至少启用表演指导或电影感。');
      return;
    }
    setEnhancementBusy(true);
    setEnhancementMessage('可选增强运行中…');
    clearError();
    try {
      const stagePlan = await runDraftEnhancement({
        currentDraft,
        document,
        documentVersion,
        composition,
        capabilityPorts,
        enableActing,
        enableCinematic,
        getCurrentDraft: () => draftRef.current,
        commitDraft,
        onMessage: setEnhancementMessage,
      });
      if (stagePlan !== undefined) setEnhancementStagePlan(stagePlan);
    } catch (error) {
      setEnhancementMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setEnhancementBusy(false);
    }
  }, [
    capabilityPorts,
    clearError,
    commitDraft,
    composition,
    document,
    documentVersion,
    enableActing,
    enableCinematic,
  ]);

  const handleApply = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!composition || !document || !currentDraft) return;
    if (enhancementBusy) return;
    const boundDocumentVersion = currentDraft.enhancement?.boundDocumentVersion;
    if (boundDocumentVersion !== undefined && boundDocumentVersion !== documentVersion) {
      setShowApplyDialog(false);
      setEnhancementMessage('场景已变化，请重新运行增强');
      return;
    }
    setBusyStage('timing');
    clearError();
    try {
      const result = await composition.applicator.apply(currentDraft, document, {
        ...(enhancementStagePlan ? { enhancementStagePlan } : {}),
      });
      setDraft(result.appliedDraft);
      setEnhancementStagePlan(null);
      setShowApplyDialog(false);
      setActiveStage('timing');
      showToast(`已写入正式时间线：${result.receipt.createdStatementIds.length} 句`, 'success');
    } catch (error) {
      reportError(error, 'timing');
      setShowApplyDialog(false);
    } finally {
      setBusyStage(null);
    }
  }, [clearError, composition, document, documentVersion, enhancementBusy, enhancementStagePlan, reportError, setDraft]);

  // Ticket 06: applied archives can be copied into a new active session and
  // explicitly deleted (including the archive file).
  const handleDuplicateArchive = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft || currentDraft.status !== 'applied') return;
    try {
      const copy = duplicateAppliedDraft(currentDraft);
      commitDraft(copy, true);
      getStorage()?.setItem(`aeonstagery.ai-prose.${currentDraft.sceneId}.session`, copy.sessionId);
      setActiveStage('source');
      showToast('已复制归档为新会话，可重新生成或再次应用。', 'success');
    } catch (error) {
      reportError(error, 'source');
    }
  }, [commitDraft, reportError]);

  const handleDeleteArchive = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!composition || !project || !currentDraft || currentDraft.status !== 'applied') return;
    if (!window.confirm('删除后不可恢复。确定删除该已应用归档草稿吗？')) return;
    try {
      await composition.draftPersistence.deleteDraft(
        project,
        currentDraft.sceneId,
        currentDraft.sessionId,
      );
      getStorage()?.removeItem(`aeonstagery.ai-prose.${currentDraft.sceneId}.session`);
      startNewDraft();
      showToast('已删除归档草稿。', 'success');
    } catch (error) {
      reportError(error, 'source');
    }
  }, [composition, project, reportError, startNewDraft]);

  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setSourceName(file.name);
      handleSourceChange(text);
    } catch (error) {
      reportError(`读取正文失败：${getErrorMessage(error)}`, 'source');
    } finally {
      setFileInputKey((value) => value + 1);
    }
  }, [handleSourceChange, reportError]);

  const lineCount = useMemo(() => getSourceLines(sourceText).length, [sourceText]);
  const visibleCount = useMemo(() => visibleCharacterCount(sourceText), [sourceText]);
  const spokenCount = useMemo(() => spokenCharacterCount(sourceText), [sourceText]);
  const segments = draft?.segmentation.segments ?? [];
  const normalizationBlocks = useMemo(() => {
    if (!draft) return [];
    try {
      return splitAiProseNormalizationTasks(draft.normalization);
    } catch {
      return [];
    }
  }, [draft]);
  const filteredBlocks = useMemo(() => normalizationBlocks.filter((block) => (
    selectedFilter === 'all'
      || (selectedFilter === 'dialogue' && block.speaker !== '')
      || (selectedFilter === 'narration' && block.speaker === '')
  )), [normalizationBlocks, selectedFilter]);
  const duplicateBindings = useMemo(() => (
    (draft?.confirmedMainCharacters ?? []).filter((name) => (
      (document?.meta.characters ?? []).filter((character) => character.name === name).length > 1
    ))
  ), [draft?.confirmedMainCharacters, document?.meta.characters]);
  const canApply = !!draft
    && draft.status === 'active'
    && !!draft.preview
    && draft.mainCharactersConfirmed
    && duplicateBindings.every((name) => !!draft.characterBindings[name]);
  const activeStageIndex = STAGES.findIndex((stage) => stage.id === activeStage);
  const aiStateText = busyStage
    ? `AI 运行中 · ${STAGES.find((stage) => stage.id === busyStage)?.label ?? '当前阶段'}`
    : aiTrace.runtimeState === 'failed'
      ? 'AI 请求异常'
      : aiTrace.runtimeState === 'succeeded'
        ? 'AI 就绪'
        : credentialConfigured
          ? 'AI 已配置'
          : 'AI 待配置';
  const aiStateClass = busyStage ? 'is-running' : aiTrace.runtimeState === 'failed' ? 'is-error' : aiTrace.runtimeState === 'succeeded' ? 'is-ready' : '';

  return {
    composition,
    project,
    document,
    draft,
    activeStage,
    setActiveStage,
    sourceText,
    sourceName,
    mainCharacters,
    setMainCharacters,
    targetBatchSize,
    scriptReadingSpeed,
    busyStage,
    errorMessage,
    errorInfo,
    persistenceMessage,
    initializing,
    initializationMessage,
    traceOpen,
    setTraceOpen,
    showApplyDialog,
    setShowApplyDialog,
    enableActing,
    setEnableActing,
    enableCinematic,
    setEnableCinematic,
    enhancementBusy,
    enhancementMessage,
    enhancementStagePlan,
    fileInputKey,
    dialogRef,
    aiTrace,
    startNewDraft,
    handleSourceChange,
    handleImportFile,
    runPrepare,
    handleReadingSpeedChange,
    handleTargetBatchSizeChange,
    handleBindingChange,
    runNormalization,
    retryNormalizationSegment,
    runRhythm,
    handleRunDraftEnhancement,
    handleDuplicateArchive,
    handleDeleteArchive,
    handleApply,
    lineCount,
    visibleCount,
    spokenCount,
    segments,
    normalizationBlocks,
    filteredBlocks,
    selectedFilter,
    setSelectedFilter,
    selectedSegment,
    setSelectedSegment,
    canApply,
    activeStageIndex,
    aiStateText,
    aiStateClass
  };
}
