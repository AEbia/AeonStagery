import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import './ai-prose-workbench.css';
import { AiWorkbenchModeSwitch } from './AiWorkbenchMode';
import {
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_SCRIPT_READING_SPEED,
  SCRIPT_READING_SPEED_RANGE,
  type AiProseAnchorMode,
  type AiProseProviderConfig,
  type AiProseTaskStatus,
} from '../api/types/ai-prose-authoring';
import { eventBus } from '../api/events';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import type { AiProseEnhancementStageCheckpointV1 } from '../api/types/ai-prose-enhancement';
import type { SemanticScenePatchV1 } from '../api/types/semantic-scene-patch';
import type { SceneEnhancementStageResultV1 } from '../services/ai-authoring/SceneEnhancementSnapshot';
import {
  buildAiProseDeterministicPreview,
  splitAiProseNormalizationTasks,
} from '../services/ai-authoring/AiProseDeterministicCompiler';
import {
  collectEnhancementPerformanceMotions,
  combineStageUnitPatches,
  flattenEnhancementStagePlan,
  type EnhancementStagePlanV1,
} from '../services/ai-authoring/FormalEnhancementApply';
import {
  confirmMainCharacters,
  createDraft,
  duplicateAppliedDraft,
  replaceEnhancementState,
  replacePreview,
  setCharacterBinding,
  setCharacterBindingPlan,
  updateScriptReadingSpeed,
  updateSourceText,
  updateTargetBatchSize,
  type DraftSession,
} from '../services/ai-authoring/AiProseDraftSession';
import {
  buildCharacterBindingPlan,
  projectDraftSemanticScene,
} from '../services/ai-authoring/CharacterBindingPlan';
import {
  FormalEnhancementOrchestrator,
} from '../services/ai-authoring/FormalEnhancementOrchestrator';
import {
  EnhancementProcessorRunner,
} from '../services/ai-authoring/EnhancementProcessorRunner';
import {
  beginFormalEnhancementRun,
  buildFormalStatementGroups,
  buildSingleSegmentSegmentation,
} from '../services/ai-authoring/FormalSceneEnhancementHost';
import {
  restoreEnhancementState,
  replayEnhancementState,
  enhancementStagePlanFromState,
  enhancementStageCheckpointFromSnapshot,
  createIncrementalStageCheckpointPersister,
} from '../services/ai-authoring/AiProseEnhancementRestore';
import {
  createAiProseEnhancementBaseFingerprint,
  createEmptyEnhancementState,
  withEnhancementStageCheckpoint,
} from '../services/ai-authoring/AiProseEnhancementState';
import type {
  AiProseNormalizationRun,
  AiProsePreparedPipeline,
} from '../services/ai-authoring/AiProsePipeline';
import type {
  AiProseAuthoringComposition,
} from '../services/ai-authoring/AiProseAuthoringComposition';
import type {
  AiProseElectronCredentialController,
  AiProseElectronProviderController,
} from '../services/ai-authoring/AiProseElectronTransport';
import type {
  AiProseLlmProgress,
} from '../services/ai-authoring/AiProseContracts';
import {
  visibleCharacterCount,
  spokenCharacterCount,
} from '../services/ai-authoring/AiProseTextMetrics';
import { IconX } from './icons';
import { InfoTip } from './Tooltip';
import {
  AiRequestTracePanel,
  toRecord,
  useAiRequestTrace,
} from './AiProseTrace';
import {
  useApp,
  useDocumentStore,
} from './context/AppContext';
import { useEditorTime, useSemanticDocument } from './store/storeHooks';
import { normalizeScriptReadingSpeed, useSettings } from './SettingsStore';
import { showToast } from './Toast';
import { useModalDialog } from './hooks/useModalDialog';
import { useEnhancementCapabilityPorts } from './hooks/useEnhancementCapabilityPorts';

type WorkbenchStage = 'source' | 'segments' | 'characters' | 'normalize' | 'timing';

const STAGES: readonly {
  id: WorkbenchStage;
  number: string;
  label: string;
  shortLabel: string;
}[] = [
  { id: 'source', number: '01', label: '原文输入', shortLabel: '原文' },
  { id: 'segments', number: '02', label: '语义分段', shortLabel: '分段' },
  { id: 'characters', number: '03', label: '人物确认', shortLabel: '人物' },
  { id: 'normalize', number: '04', label: '语句规范化', shortLabel: '语句' },
  { id: 'timing', number: '05', label: '时间编排', shortLabel: '时间' },
];

type WorkbenchErrorInfo = {
  stage?: WorkbenchStage;
  code?: string;
  message: string;
  details: Record<string, unknown>;
};

function createWorkbenchErrorInfo(error: unknown, stage?: WorkbenchStage): WorkbenchErrorInfo {
  if (typeof error === 'string') return { stage, message: error, details: {} };
  const record = toRecord(error);
  const details = {
    ...(toRecord(record?.details) ?? {}),
    ...(typeof record?.path === 'string' ? { path: record.path } : {}),
    ...(record?.cause instanceof Error ? { cause: record.cause.message } : {}),
  };
  return {
    stage,
    ...(typeof record?.code === 'string' ? { code: record.code } : {}),
    message: error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error),
    details,
  };
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

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

function formatTime(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '00:00.0';
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const seconds = (safe % 60).toFixed(decimals).padStart(decimals === 0 ? 2 : 4, '0');
  return `${minutes}:${seconds}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageStatus(draft: DraftSession | null, stage: WorkbenchStage): AiProseTaskStatus {
  if (!draft) return 'idle';
  if (stage === 'source') return draft.sourceText.length > 0 ? 'succeeded' : 'idle';
  if (stage === 'segments') return draft.segmentation.status;
  if (stage === 'characters') return draft.characterExtraction.status;
  if (stage === 'normalize') {
    if (draft.normalization.length === 0) return 'idle';
    return draft.normalization.every((task) => task.status === 'succeeded') ? 'succeeded' : 'failed';
  }
  return draft.preview ? 'succeeded' : 'idle';
}

function isStageReady(draft: DraftSession | null, stage: WorkbenchStage): boolean {
  if (!draft) return stage === 'source';
  if (stage === 'source') return true;
  if (stage === 'segments') return draft.segmentation.status !== 'idle';
  if (stage === 'characters') return draft.segmentation.status === 'succeeded';
  if (stage === 'normalize') return draft.mainCharactersConfirmed && draft.segmentation.status === 'succeeded';
  return draft.normalization.length > 0 && draft.normalization.every((task) => task.status === 'succeeded');
}

function statusText(status: AiProseTaskStatus): string {
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '需重试';
  if (status === 'running') return '运行中';
  return '未开始';
}

function toNormalizationRun(draft: DraftSession): AiProseNormalizationRun {
  return {
    status: draft.normalization.length > 0
      && draft.normalization.every((task) => task.status === 'succeeded')
      ? 'succeeded'
      : 'failed',
    sourceText: draft.sourceText,
    sourceRevision: draft.sourceRevision,
    segmentationFingerprint: draft.segmentation.planFingerprint,
    confirmedMainCharacters: [...draft.confirmedMainCharacters],
    tasks: draft.normalization.map((task) => ({
      ...task,
      statements: task.statements.map((statement) => ({ ...statement })),
      ...(task.error ? { error: { ...task.error } } : {}),
    })),
  };
}

function getSourceLines(sourceText: string): string[] {
  return sourceText.split(/\r?\n/u);
}

function getLineNumberAtOffset(sourceText: string, offset: number): number {
  return sourceText.slice(0, offset).split(/\r?\n/u).length;
}

function getCompletedTaskCount(tasks: readonly { status: AiProseTaskStatus }[]): number {
  return tasks.filter((task) => task.status === 'succeeded').length;
}

function isTaskSettled(status: AiProseTaskStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function AiProseWorkbench({ onClose }: { onClose?: () => void } = {}) {
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
  const [traceOpen, setTraceOpen] = useState(true);
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
    handleLlmProgress,
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

  const createCheckpoint = useCallback((baseDraft: DraftSession) => {
    if (!composition || !project) throw new Error('当前没有可用的项目草稿服务');
    return composition.createDraftCheckpoint(project, baseDraft);
  }, [composition, project]);

  const preparePipeline = useCallback(async (
    baseDraft: DraftSession,
    onLlmProgress: (progress: AiProseLlmProgress) => void = handleLlmProgress,
  ): Promise<{
    prepared: AiProsePreparedPipeline;
    draft: DraftSession;
  }> => {
    const checkpoint = createCheckpoint(baseDraft);
    let prepared: AiProsePreparedPipeline;
    try {
      prepared = await composition!.pipeline.prepare(baseDraft.sourceText, {
        targetBatchSize: baseDraft.targetBatchSize,
        anchorTime: baseDraft.anchorTime,
        sourceRevision: baseDraft.sourceRevision,
        existing: baseDraft,
        existingDraft: baseDraft,
        checkpoint,
        onLlmProgress,
      });
    } catch (error) {
      // The checkpoint mutates its in-memory draft before persistence. Keep
      // the AI task failure visible even when the save itself also fails.
      setDraft(checkpoint.getDraft());
      throw error;
    }
    const checkpointDraft = checkpoint.getDraft();
    setDraft(checkpointDraft);
    return { prepared, draft: checkpointDraft };
  }, [composition, createCheckpoint, handleLlmProgress, setDraft]);

  const runPrepare = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft || !currentDraft.sourceText.trim()) {
      reportError('请先输入完整正文。AI 铺戏不接受只有梗概或写作要求的输入。', 'source');
      return;
    }
    resetAiTrace();
    setBusyStage('segments');
    setAiTraceRuntimeState('running');
    clearError();
    try {
      const { prepared, draft: next } = await preparePipeline(currentDraft);
      setMainCharacters(prepared.suggestedMainCharacters);
      // prepare() waits for both parallel AI tasks and the persistence
      // checkpoint. Use the checkpoint's final draft as the source of truth
      // for navigation so the UI advances only after both task results have
      // been committed.
      const prepareSettled = isTaskSettled(next.segmentation.status)
        && isTaskSettled(next.characterExtraction.status);
      setActiveStage(next.segmentation.status === 'succeeded' && prepareSettled ? 'segments' : 'source');
      if (next.segmentation.status === 'failed') {
        reportError(next.segmentation.error ?? '语义分段失败，请重试。', 'segments');
      } else if (next.characterExtraction.status === 'failed') {
        reportError(next.characterExtraction.error ?? '人物提取失败；可以手动填写人物名单后继续。', 'characters');
      } else {
        setAiTraceRuntimeState('succeeded');
      }
    } catch (error) {
      reportError(error, 'segments');
    } finally {
      setBusyStage(null);
    }
  }, [clearError, preparePipeline, reportError, resetAiTrace, setAiTraceRuntimeState]);

  const runNormalization = useCallback(async (names: readonly string[]) => {
    const currentDraft = draftRef.current;
    if (!currentDraft) return;
    if (new Set(names).size !== names.length || names.some((name) => !name.trim())) {
      reportError('主要人物名字必须非空且不能重复。', 'characters');
      return;
    }
    if (currentDraft.segmentation.status !== 'succeeded') {
      reportError('请先完成语义分段。', 'segments');
      setActiveStage('segments');
      return;
    }
    resetAiTrace();
    setBusyStage('normalize');
    setAiTraceRuntimeState('running');
    clearError();
    try {
      const confirmed = confirmMainCharacters(currentDraft, names.map((name) => name.trim()));
      commitDraft(confirmed, true);
      const { prepared, draft: preparedDraft } = await preparePipeline(confirmed);
      const checkpoint = createCheckpoint(preparedDraft);
      try {
        await composition!.pipeline.normalize(
          prepared,
          { confirmedMainCharacters: preparedDraft.confirmedMainCharacters, mainCharactersConfirmed: true },
          { existingDraft: preparedDraft, checkpoint, onLlmProgress: handleLlmProgress },
        );
      } catch (error) {
        setDraft(checkpoint.getDraft());
        throw error;
      }
      const next = checkpoint.getDraft();
      commitDraft(next, false);
      setActiveStage('normalize');
      if (next.normalization.some((task) => task.status === 'failed')) {
        const failedTask = next.normalization.find((task) => task.status === 'failed');
        reportError(failedTask?.error ?? '部分故事段规范化失败，可以单独重试失败段。', 'normalize');
      } else {
        setAiTraceRuntimeState('succeeded');
      }
    } catch (error) {
      reportError(error, 'normalize');
    } finally {
      setBusyStage(null);
    }
  }, [clearError, commitDraft, composition, createCheckpoint, handleLlmProgress, preparePipeline, reportError, resetAiTrace, setAiTraceRuntimeState, setDraft]);

  const retryNormalizationSegment = useCallback(async (segmentIndex: number) => {
    const currentDraft = draftRef.current;
    if (!currentDraft || !composition) return;
    resetAiTrace();
    setBusyStage('normalize');
    setAiTraceRuntimeState('running');
    clearError();
    try {
      const { prepared, draft: preparedDraft } = await preparePipeline(currentDraft);
      const checkpoint = createCheckpoint(preparedDraft);
      try {
        await composition.pipeline.retrySegment(
          prepared,
          toNormalizationRun(preparedDraft),
          segmentIndex,
          { checkpoint, onLlmProgress: handleLlmProgress },
        );
      } catch (error) {
        setDraft(checkpoint.getDraft());
        throw error;
      }
      const next = checkpoint.getDraft();
      commitDraft(next, false);
      if (next.normalization.every((task) => task.status === 'succeeded')) setAiTraceRuntimeState('succeeded');
      else {
        const failedTask = next.normalization.find((task) => task.status === 'failed');
        reportError(failedTask?.error ?? '故事段规范化失败，可以单独重试失败段。', 'normalize');
      }
    } catch (error) {
      reportError(error, 'normalize');
    } finally {
      setBusyStage(null);
    }
  }, [clearError, commitDraft, composition, createCheckpoint, handleLlmProgress, preparePipeline, reportError, resetAiTrace, setAiTraceRuntimeState, setDraft]);

  const runRhythm = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (!currentDraft || !composition) return;
    if (!currentDraft.normalization.length || currentDraft.normalization.some((task) => task.status !== 'succeeded')) {
      reportError('所有故事段规范化成功后才能进行时间编排。', 'normalize');
      setActiveStage('normalize');
      return;
    }
    resetAiTrace();
    setBusyStage('timing');
    setAiTraceRuntimeState('running');
    clearError();
    try {
      const { prepared, draft: preparedDraft } = await preparePipeline(currentDraft);
      const checkpoint = createCheckpoint(preparedDraft);
      try {
        await composition.pipeline.rhythm(
          prepared,
          toNormalizationRun(preparedDraft),
          { existingDraft: preparedDraft, checkpoint, onLlmProgress: handleLlmProgress },
        );
      } catch (error) {
        setDraft(checkpoint.getDraft());
        throw error;
      }
      const next = checkpoint.getDraft();
      commitDraft(next, false);
      setActiveStage('timing');
      const rhythmError = next.rhythm.find((task) => task.error)?.error;
      if (rhythmError) reportError({
        ...rhythmError,
        message: `语义节奏请求失败，已使用基线间隔：${rhythmError.message}`,
      }, 'timing');
      else setAiTraceRuntimeState('succeeded');
    } catch (error) {
      reportError(error, 'timing');
    } finally {
      setBusyStage(null);
    }
  }, [clearError, commitDraft, composition, createCheckpoint, handleLlmProgress, preparePipeline, reportError, resetAiTrace, setAiTraceRuntimeState, setDraft]);

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
      // Bind the run to the exact DocumentStore version it authors line
      // locators against; apply/restore refuse stale results after a scene edit.
      const boundDocumentVersion = documentVersion;

      const plan = buildCharacterBindingPlan({
        document,
        confirmedMainCharacters: currentDraft.confirmedMainCharacters,
        requestedBindings: currentDraft.characterBindings,
      });
      if (plan.status === 'ambiguous') {
        setEnhancementMessage(
          `角色绑定歧义：${plan.ambiguous.map((item) => item.name).join('、')}。请在人物确认中选择。`,
        );
        commitDraft(setCharacterBindingPlan(currentDraft, plan), true);
        return;
      }
      // Persist the binding plan as a session fact so a restart restores the
      // exact plan used by the enhancement run (ADR-0022 schema v4).
      commitDraft(setCharacterBindingPlan(currentDraft, plan), true);

      // Persist each stage checkpoint into the draft session so successful
      // windows/splits survive a restart (ticket 02) and can be restored.
      const persistEnhancementStageCheckpoint = async (
        checkpoint: AiProseEnhancementStageCheckpointV1,
      ) => {
        const latest = draftRef.current;
        if (!latest) return;
        const base = latest.enhancement ?? createEmptyEnhancementState(latest);
        commitDraft(replaceEnhancementState(latest, {
          ...base,
          characterBindingPlan: plan,
          boundDocumentVersion,
          ...withEnhancementStageCheckpoint(base, checkpoint),
        }), true);
      };

      const persistEnhancementCheckpoint = async (
        stage: 'performance' | 'cinematic',
        result: SceneEnhancementStageResultV1,
      ) => {
        await persistEnhancementStageCheckpoint(enhancementStageCheckpointFromSnapshot(stage, result));
      };

      // Persist a 'running' stage checkpoint before the first unit and an
      // incremental partial checkpoint after each completed unit, so a crash
      // mid-stage keeps every finished unit (ADR-0022 per-unit checkpoints).
      const checkpointHooks = createIncrementalStageCheckpointPersister({
        persist: (_stage, checkpoint) => {
          void persistEnhancementStageCheckpoint(checkpoint);
        },
      });

      // Same baseline shape as AiProseSceneApplicator: existing formal + draft dialogues.
      const projected = projectDraftSemanticScene({
        baseDocument: document,
        plan,
        confirmedMainCharacters: currentDraft.confirmedMainCharacters,
        previewStatements: currentDraft.preview.statements.map((statement) => ({
          speaker: statement.speaker,
          text: statement.text,
          time: statement.time,
          durationSeconds: statement.durationSeconds,
        })),
      });

      const groups = buildFormalStatementGroups(projected);
      const segmentation = buildSingleSegmentSegmentation(groups);
      // The projection preserves formal statement ids; placeholder materialization
      // must stay created-only so the baseline matches the apply-time baseline
      // (pre-existing formal dialogues are never backfilled by the apply path).
      const formalStatementIds = new Set(document.statements.map((statement) => statement.id));
      const createdStatementIds = new Set(
        projected.statements
          .filter((statement) => !formalStatementIds.has(statement.id))
          .map((statement) => statement.id),
      );
      const runner = new EnhancementProcessorRunner({
        llm: composition.llm,
        modelCapabilities: capabilityPorts.modelCapabilityPort,
        cinematicCapabilities: capabilityPorts.cinematicCapabilityPort,
        profileProvider: capabilityPorts.profileProvider,
        onUnitComplete: checkpointHooks.onUnitComplete,
        onStageStarted: checkpointHooks.onStageStarted,
      });
      const orchestrator = new FormalEnhancementOrchestrator({
        llm: composition.llm,
        runnerFactory: () => runner,
      });
      const binding = { sceneSessionEpoch: 0, documentVersion: 0 };
      let snap = beginFormalEnhancementRun({
        binding,
        document: projected,
        segmentation,
      });

      let performancePatches: readonly SemanticScenePatchV1[] | undefined = undefined;
      if (enableActing) {
        snap = await orchestrator.runPerformance({
          snapshot: snap,
          document: projected,
          binding,
          ensurePlaceholders: false,
          placeholderTargetStatementIds: createdStatementIds,
        });
        if (snap.performance?.status !== 'succeeded') {
          setEnhancementMessage(
            `表演增强失败：${snap.performance?.diagnostics?.map((d) => d.message).join('; ') || '未知错误'}`,
          );
          return;
        }
        performancePatches = snap.performance.unitPatches
          ?? (snap.performance.patch ? [snap.performance.patch] : undefined);
        await persistEnhancementCheckpoint('performance', snap.performance);
      }

      let cinematicPatches: readonly SemanticScenePatchV1[] | undefined = undefined;
      if (enableCinematic) {
        snap = await orchestrator.runCinematic({
          snapshot: snap,
          document: projected,
          placeholderTargetStatementIds: createdStatementIds,
        });
        if (snap.cinematic?.status !== 'succeeded' && snap.phase !== 'preview_ready') {
          setEnhancementMessage(
            `电影感增强失败：${snap.cinematic?.diagnostics?.map((d) => d.message).join('; ') || '未知错误'}`,
          );
        }
        cinematicPatches = snap.cinematic?.status === 'succeeded'
          ? (snap.cinematic.unitPatches
            ?? (snap.cinematic.patch ? [snap.cinematic.patch] : undefined))
          : undefined;
        if (snap.cinematic) {
          await persistEnhancementCheckpoint('cinematic', snap.cinematic);
        }
      }

      const stagePlan = combineStageUnitPatches(performancePatches, cinematicPatches);
      setEnhancementStagePlan(stagePlan.stages.length > 0 ? stagePlan : null);
      const opCount = flattenEnhancementStagePlan(stagePlan).operations.length;
      setEnhancementMessage(
        opCount > 0
          ? `可选增强就绪：${opCount} 项操作，将随原子应用一并写入。`
          : '可选增强完成：无需额外更改。',
      );
    } catch (error) {
      setEnhancementMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setEnhancementBusy(false);
    }
  }, [
    capabilityPorts.cinematicCapabilityPort,
    capabilityPorts.modelCapabilityPort,
    capabilityPorts.profileProvider,
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

  if (!composition || !project || !document) {
    return (
      <div className="ai-prose-workbench ai-prose-workbench--empty">
        <div className="ai-prose-empty-state">
          <span className="ai-prose-empty-state__mark">AI</span>
          <h2>AI 铺戏工作台</h2>
          <p>打开项目和场景后，可将完整正文无损结构化为可编排语句。</p>
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="ai-prose-workbench ai-prose-workbench--empty">
        <header className="ai-prose-topbar">
          <div className="ai-prose-brand">AI 铺戏</div>
          <AiWorkbenchModeSwitch />
          <div className="ai-prose-topbar__spacer" />
          {onClose && <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={onClose} title="关闭 AI 铺戏" aria-label="关闭 AI 铺戏"><IconX width={16} height={16} /></button>}
        </header>
        <div className="ai-prose-empty-state">
          <span className="ai-prose-empty-state__mark">{initializing ? '…' : '!'}</span>
          <h2>{initializing ? '正在恢复 AI 草稿' : 'AI 草稿不可用'}</h2>
          <p>{initializationMessage || errorMessage || '当前场景还没有可编辑的草稿。'}</p>
          {!initializing && <button className="ai-prose-button ai-prose-button--primary" type="button" onClick={startNewDraft}>新建草稿</button>}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={dialogRef}
      className="ai-prose-workbench"
      data-stage={activeStage}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="ai-prose-topbar">
        <div className="ai-prose-brand">AI 铺戏</div>
        <AiWorkbenchModeSwitch />
        <div className="ai-prose-topbar__spacer" />
        <span className="ai-prose-save-state"><i />{persistenceMessage ? '保存异常' : '草稿已保存'}</span>
        <span className={`ai-prose-ai-state ${aiStateClass}`} aria-live="polite"><i />{aiStateText}</span>
        <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={() => setTraceOpen((value) => !value)}>{traceOpen ? '隐藏轨迹' : '显示轨迹'}</button>
        <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={() => void eventBus.emit('ui:openSettings', { tab: 'ai' })}>AI 设置</button>
        <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={startNewDraft} title="新建 AI 草稿" aria-label="新建 AI 草稿">＋</button>
        {onClose && <button className="ai-prose-button ai-prose-button--icon" type="button" onClick={onClose} title="关闭 AI 铺戏" aria-label="关闭 AI 铺戏"><IconX width={16} height={16} /></button>}
      </header>

      <div className={`ai-prose-body-grid ${traceOpen ? 'has-trace' : ''}`}>
        <aside className="ai-prose-source-rail" aria-label="正文与阶段">
          <div className="ai-prose-rail-inner">
            <div className="ai-prose-section-title">
              <h2>正文</h2>
              <span className="ai-prose-session-id">{document.meta.title || document.sceneId}</span>
            </div>
            <div className="ai-prose-source-actions">
              <label className="ai-prose-button ai-prose-button--secondary ai-prose-file-button">
                导入
                <input key={fileInputKey} type="file" accept=".txt,.text,.md" onChange={(event) => void handleImportFile(event)} />
              </label>
              <button className="ai-prose-button ai-prose-button--ghost" type="button" onClick={() => handleSourceChange('')} disabled={busyStage !== null}>清空</button>
            </div>
            <textarea
              className="ai-prose-source-editor"
              aria-label="完整正文"
              value={sourceText}
              onChange={(event) => handleSourceChange(event.target.value)}
              disabled={busyStage !== null}
              placeholder="粘贴完整正文。只做无损结构化，不改写剧情。"
            />
            <div className="ai-prose-field-foot">
              <strong>{sourceName}</strong>
              <span>
                {formatCount(visibleCount)}
                {' '}
                字 ·
                {' '}
                {formatCount(spokenCount)}
                {' '}
                朗读 ·
                {' '}
                {formatTime(draft.anchorTime)}
              </span>
            </div>

            <div className="ai-prose-section-title ai-prose-section-title--artifacts">
              <h3>阶段</h3>
              <span>
                {getCompletedTaskCount(STAGES.map((stage) => ({ status: stageStatus(draft, stage.id) })))}
                {' '}
                /
                {' '}
                5
              </span>
            </div>
            <div className="ai-prose-artifact-list" role="tablist" aria-label="AI 铺戏阶段">
              {STAGES.map((stage) => {
                const status = stageStatus(draft, stage.id);
                return (
                  <button
                    key={stage.id}
                    className={`ai-prose-artifact-item ${activeStage === stage.id ? 'is-active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={activeStage === stage.id}
                    onClick={() => setActiveStage(stage.id)}
                    disabled={!isStageReady(draft, stage.id)}
                  >
                    <span className="ai-prose-artifact-glyph">{status === 'succeeded' ? '✓' : stage.number}</span>
                    <span className="ai-prose-artifact-name">{stage.label}</span>
                    <span className={`ai-prose-artifact-state is-${status}`}>{statusText(status)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="ai-prose-pipeline-space" id="ai-prose-workbench-title">
          {errorMessage && <WorkbenchErrorAlert info={errorInfo ?? createWorkbenchErrorInfo(errorMessage, activeStage)} />}
          {busyStage && (
            <div className="ai-prose-run-banner is-running" role="status">
              <div className="ai-prose-run-title">
                <span className="ai-prose-run-icon">…</span>
                <strong>
                  正在运行：
                  {STAGES.find((stage) => stage.id === busyStage)?.label}
                </strong>
              </div>
            </div>
          )}

          <div className="ai-prose-artifact-workspace">
            {activeStage === 'source' && (
              <SourceStage
                anchorMode={draft.anchorMode}
                scriptReadingSpeed={scriptReadingSpeed}
                onReadingSpeedChange={handleReadingSpeedChange}
              />
            )}
            {activeStage === 'segments' && (
              <SegmentsStage
                draft={draft}
                segments={segments}
                selectedSegment={selectedSegment}
                targetBatchSize={targetBatchSize}
                onSelectSegment={setSelectedSegment}
                onTargetBatchSizeChange={handleTargetBatchSizeChange}
                onPrepare={() => void runPrepare()}
                busy={busyStage !== null}
              />
            )}
            {activeStage === 'characters' && (
              <CharactersStage
                draft={draft}
                names={mainCharacters}
                document={document}
                onNamesChange={setMainCharacters}
                onBindingChange={handleBindingChange}
                busy={busyStage !== null}
              />
            )}
            {activeStage === 'normalize' && (
              <NormalizeStage
                draft={draft}
                blocks={filteredBlocks}
                selectedFilter={selectedFilter}
                onFilterChange={setSelectedFilter}
                onRetry={retryNormalizationSegment}
                onNormalize={() => void runNormalization(draft.confirmedMainCharacters)}
                busy={busyStage !== null}
              />
            )}
            {activeStage === 'timing' && (
              <TimingStage
                draft={draft}
                blocks={normalizationBlocks}
                scriptReadingSpeed={scriptReadingSpeed}
                onReadingSpeedChange={handleReadingSpeedChange}
                onRhythm={() => void runRhythm()}
                busy={busyStage !== null || enhancementBusy}
                enableActing={enableActing}
                enableCinematic={enableCinematic}
                onEnableActingChange={setEnableActing}
                onEnableCinematicChange={setEnableCinematic}
                onRunEnhancement={() => void handleRunDraftEnhancement()}
                enhancementBusy={enhancementBusy}
                enhancementMessage={enhancementMessage}
                enhancementOperationCount={enhancementStagePlan
                  ? enhancementStagePlan.stages.reduce((sum, stage) => sum + stage.patch.operations.length, 0)
                  : 0}
                enhancementMotions={enhancementStagePlan
                  ? collectEnhancementPerformanceMotions(enhancementStagePlan)
                  : null}
              />
            )}
          </div>
        </main>

        {traceOpen && (
          <AiRequestTracePanel
            requests={aiTrace.traceRequests}
            expandedIds={aiTrace.expandedRequestIds}
            onToggle={aiTrace.toggleTraceRequest}
            onCollapse={() => setTraceOpen(false)}
          />
        )}
      </div>

      <footer className="ai-prose-bottom-bar">
        <div className="ai-prose-bottom-summary">
          <span className="ai-prose-bottom-mark">{STAGES[activeStageIndex]?.number}</span>
          <span>
            <strong>{STAGES[activeStageIndex]?.label}</strong>
            <small>
              {formatCount(visibleCount)}
              {' '}
              字 ·
              {' '}
              {lineCount}
              {' '}
              行
              {draft.status === 'applied' ? ' · 已应用' : ''}
              {initializationMessage ? ` · ${initializationMessage}` : ''}
            </small>
          </span>
        </div>
        <div className="ai-prose-bottom-spacer" />
        {draft.status === 'applied' && (
          <div className="ai-prose-archive-actions">
            <button
              className="ai-prose-button"
              type="button"
              onClick={() => void handleDuplicateArchive()}
              disabled={busyStage !== null}
            >
              复制为新会话
            </button>
            <button
              className="ai-prose-button ai-prose-button--archive-delete"
              type="button"
              onClick={() => void handleDeleteArchive()}
              disabled={busyStage !== null}
            >
              删除归档
            </button>
          </div>
        )}
        <div className="ai-prose-bottom-actions">
          <button
            className="ai-prose-button ai-prose-button--primary"
            type="button"
            onClick={() => {
              if (activeStage === 'source') void runPrepare();
              else if (activeStage === 'segments' && draft.segmentation.status === 'succeeded') setActiveStage('characters');
              else if (activeStage === 'characters') void runNormalization(mainCharacters);
              else if (activeStage === 'normalize') void runRhythm();
              else if (activeStage === 'timing') setShowApplyDialog(true);
            }}
            disabled={
              busyStage !== null
              || enhancementBusy
              || (activeStage === 'source' && !sourceText.trim())
              || (activeStage === 'segments' && draft.segmentation.status !== 'succeeded')
              || (activeStage === 'timing' && !canApply)
            }
          >
            {activeStage === 'timing'
              ? '写入正式时间线'
              : busyStage
                ? '分析中…'
                : activeStage === 'source'
                  ? '开始分析'
                  : activeStage === 'segments'
                    ? '进入人物确认'
                    : activeStage === 'characters'
                      ? '确认人物并规范化'
                      : activeStage === 'normalize'
                        ? '计算时间预览'
                        : '继续'}
            <span>→</span>
          </button>
        </div>
      </footer>

      {showApplyDialog && <ApplyDialog draft={draft} onCancel={() => setShowApplyDialog(false)} onConfirm={() => void handleApply()} />}
    </div>
  );
}

function WorkbenchErrorAlert({ info }: { info: WorkbenchErrorInfo }) {
  const detailEntries = Object.entries(info.details).filter(([key, value]) => (
    key !== 'stage' && value !== undefined && value !== null && value !== ''
  ));
  const stageLabel = info.stage ? STAGES.find((stage) => stage.id === info.stage)?.label : undefined;
  const status = info.details.status;
  return (
    <div className="ai-prose-inline-error" role="alert">
      <div className="ai-prose-error-heading">
        <strong>{stageLabel ? `${stageLabel}失败` : 'AI 工作台错误'}</strong>
        <span>{info.message}</span>
      </div>
      {(info.code || typeof status === 'number') && (
        <div className="ai-prose-error-meta">
          {info.code && <code>{info.code}</code>}
          {typeof status === 'number' && <code>HTTP {status}</code>}
        </div>
      )}
      {detailEntries.length > 0 && (
        <dl className="ai-prose-error-details">
          {detailEntries.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function ReadingSpeedControl({
  value,
  onChange,
  compact = false,
}: {
  value: number;
  onChange: (value: number) => void;
  compact?: boolean;
}) {
  const progress = ((value - SCRIPT_READING_SPEED_RANGE.min)
    / (SCRIPT_READING_SPEED_RANGE.max - SCRIPT_READING_SPEED_RANGE.min)) * 100;
  const rangeStyle = {
    '--ai-reading-speed-progress': `${Math.max(0, Math.min(100, progress))}%`,
  } as React.CSSProperties;

  return (
    <div className={`ai-prose-reading-speed-control ${compact ? 'is-compact' : ''}`}>
      <div className="ai-prose-reading-speed-head">
        <span className="ai-prose-reading-speed-label">
          <b>朗读速度</b>
          <InfoTip
            title="预估朗读速度"
            content="用于推算生成对白草稿在时间轴上的默认持续时间（字/秒）。中文字幕推荐 4.5~6.0 字/秒。"
          />
          {!compact && <small>用于新时间块的时长估算</small>}
        </span>
        <output>{value.toFixed(1)}<small> chars/sec</small></output>
      </div>
      <input
        aria-label="scriptReadingSpeed"
        className="ai-prose-reading-speed-range"
        type="range"
        min={SCRIPT_READING_SPEED_RANGE.min}
        max={SCRIPT_READING_SPEED_RANGE.max}
        step={SCRIPT_READING_SPEED_RANGE.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={rangeStyle}
        aria-valuetext={`${value.toFixed(1)} chars/sec`}
      />
      <div className="ai-prose-reading-speed-scale" aria-hidden="true">
        <span>{SCRIPT_READING_SPEED_RANGE.min}</span>
        <span>{DEFAULT_SCRIPT_READING_SPEED}</span>
        <span>{SCRIPT_READING_SPEED_RANGE.max}</span>
      </div>
    </div>
  );
}

function SourceStage({
  anchorMode,
  scriptReadingSpeed,
  onReadingSpeedChange,
}: {
  anchorMode: AiProseAnchorMode;
  scriptReadingSpeed: number;
  onReadingSpeedChange: (value: number) => void;
}) {
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro title="原文输入" />
      <div className="ai-prose-source-options">
        <div>
          <label>
            时间锚点
            <InfoTip
              title="时间锚点 (Anchor Mode)"
              content="决定 AI 生成的对白、动作与镜头在主工程时间轴上的起始插入位置。"
            />
          </label>
          <strong>{anchorMode === 'zero' ? '从 00:00.0 开始' : '从创建草稿时的播放头开始'}</strong>
        </div>
        <ReadingSpeedControl value={scriptReadingSpeed} onChange={onReadingSpeedChange} />
      </div>
    </section>
  );
}

function TabIntro({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="ai-prose-tab-intro">
      <div>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function SegmentsStage({
  draft,
  segments,
  selectedSegment,
  targetBatchSize,
  onSelectSegment,
  onTargetBatchSizeChange,
  onPrepare,
  busy,
}: {
  draft: DraftSession;
  segments: DraftSession['segmentation']['segments'];
  selectedSegment: number;
  targetBatchSize: number;
  onSelectSegment: (index: number) => void;
  onTargetBatchSizeChange: (value: number) => void;
  onPrepare: () => void;
  busy: boolean;
}) {
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro
        title="语义分段"
        action={<button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onPrepare} disabled={busy}>重新分析</button>}
      />
      <div className="ai-prose-segment-controls">
        <div className="ai-prose-segment-control">
          <div>
            <strong>
              目标处理量
              <InfoTip
                title="语义分段批大小"
                content="单次请求送入大语言模型进行分段分析的目标文本字数，平衡语义完整性与模型上下文开销。"
              />
            </strong>
            <output>
              {formatCount(targetBatchSize)}
              {' '}
              字
            </output>
          </div>
          <input
            aria-label="目标处理量"
            type="range"
            min="1000"
            max="12000"
            step="500"
            value={targetBatchSize}
            onChange={(event) => onTargetBatchSizeChange(Number(event.target.value))}
          />
          <small>
            约
            {' '}
            {draft.segmentation.targetSegmentCount}
            {' '}
            段
          </small>
        </div>
        <div className="ai-prose-segment-progress">
          <div>
            <strong>分段</strong>
            <b>
              {draft.segmentation.status === 'succeeded'
                ? `${segments.length} 段`
                : statusText(draft.segmentation.status)}
            </b>
          </div>
          <div className="ai-prose-progress-track">
            <span style={{ width: `${draft.segmentation.status === 'succeeded' ? 100 : 0}%` }} />
          </div>
          <small>
            {draft.segmentation.candidates.length}
            {' '}
            个边界
          </small>
        </div>
      </div>
      <div className="ai-prose-segment-list">
        {segments.map((segment, index) => (
          <button
            key={`${segment.index}-${segment.startOffset}`}
            className={`ai-prose-segment-card ${selectedSegment === index ? 'is-selected' : ''}`}
            type="button"
            onClick={() => onSelectSegment(index)}
          >
            <div className="ai-prose-segment-card-head">
              <span>
                <i>{String(index + 1).padStart(2, '0')}</i>
                <strong>
                  故事段
                  {' '}
                  {index + 1}
                </strong>
                <small>
                  L
                  {getLineNumberAtOffset(draft.sourceText, segment.startOffset)}
                  –
                  {getLineNumberAtOffset(draft.sourceText, segment.endOffset)}
                </small>
              </span>
            </div>
            <div className="ai-prose-segment-body">
              <p>
                {segment.sourceText.slice(0, 220)}
                {segment.sourceText.length > 220 ? '…' : ''}
              </p>
            </div>
          </button>
        ))}
        {segments.length === 0 && <EmptyStage message="语义分段尚未完成。" />}
      </div>
    </section>
  );
}

function CharactersStage({
  draft,
  names,
  document,
  onNamesChange,
  onBindingChange,
  busy,
}: {
  draft: DraftSession;
  names: string[];
  document: CurrentSceneDocument;
  onNamesChange: React.Dispatch<React.SetStateAction<string[]>>;
  onBindingChange: (name: string, characterId: string) => void;
  busy: boolean;
}) {
  const characters = document.meta.characters ?? [];
  const addName = () => onNamesChange((current) => [...current, '']);
  const removeName = (index: number) => onNamesChange((current) => current.filter((_, itemIndex) => itemIndex !== index));
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro
        title="人物确认"
        action={<button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={addName}>＋ 添加人物</button>}
      />
      <div className="ai-prose-character-list">
        <div className="ai-prose-list-heading">
          <span>
            主要人物 ·
            {' '}
            {names.length}
          </span>
          <small>
            AI 建议
            {' '}
            {draft.characterExtraction.suggestedNames.length}
            {draft.characterExtraction.status === 'failed' ? ' · 提取失败' : ''}
          </small>
        </div>
        {names.map((name, index) => {
          const matches = characters.filter((character) => character.name === name);
          return (
            <div className="ai-prose-character-row" key={index}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <input
                aria-label={`主要人物 ${index + 1}`}
                value={name}
                onChange={(event) => onNamesChange((current) => current.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                disabled={busy}
              />
              <button
                className="ai-prose-button ai-prose-button--icon"
                type="button"
                onClick={() => removeName(index)}
                disabled={busy}
                aria-label={`删除人物 ${index + 1}`}
              >
                ×
              </button>
              {draft.mainCharactersConfirmed && matches.length > 1 && (
                <select
                  aria-label={`${name} 的角色绑定`}
                  value={draft.characterBindings[name] ?? ''}
                  onChange={(event) => onBindingChange(name, event.target.value)}
                >
                  <option value="">选择绑定角色</option>
                  {matches.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}
                      {' · '}
                      {character.id}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        {names.length === 0 && <EmptyStage message="没有主要人物" />}
      </div>
    </section>
  );
}

function NormalizeStage({
  draft,
  blocks,
  selectedFilter,
  onFilterChange,
  onRetry,
  onNormalize,
  busy,
}: {
  draft: DraftSession;
  blocks: ReturnType<typeof splitAiProseNormalizationTasks>;
  selectedFilter: 'all' | 'dialogue' | 'narration';
  onFilterChange: (filter: 'all' | 'dialogue' | 'narration') => void;
  onRetry: (segmentIndex: number) => Promise<void>;
  onNormalize: () => void;
  busy: boolean;
}) {
  const failedTasks = draft.normalization.filter((task) => task.status === 'failed');
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro
        title="语句规范化"
        action={(
          <div className="ai-prose-filter-buttons">
            {(['all', 'dialogue', 'narration'] as const).map((filter) => (
              <button
                key={filter}
                className={selectedFilter === filter ? 'is-active' : ''}
                type="button"
                onClick={() => onFilterChange(filter)}
              >
                {filter === 'all' ? '全部' : filter === 'dialogue' ? '对白' : '旁白'}
              </button>
            ))}
          </div>
        )}
      />
      {failedTasks.length > 0 && (
        <div className="ai-prose-stage-callout ai-prose-stage-callout--warning">
          <b>
            {failedTasks.length}
            {' '}
            个故事段失败
          </b>
          {failedTasks.map((task) => (
            <button
              key={task.segmentIndex}
              className="ai-prose-button ai-prose-button--secondary"
              type="button"
              onClick={() => void onRetry(task.segmentIndex)}
              disabled={busy}
            >
              重试段
              {' '}
              {task.segmentIndex + 1}
            </button>
          ))}
        </div>
      )}
      <div className="ai-prose-statement-list">
        {blocks.map((block) => {
          const visible = selectedFilter === 'all'
            || (selectedFilter === 'dialogue' && block.speaker !== '')
            || (selectedFilter === 'narration' && block.speaker === '');
          if (!visible) return null;
          return (
            <article
              className={`ai-prose-statement-row ${block.speaker ? 'is-dialogue' : 'is-narration'}`}
              key={`${block.segmentIndex}-${block.sourceStatementIndex}-${block.blockIndex}`}
            >
              <span className="ai-prose-statement-number">
                #
                {String(block.blockIndex + 1).padStart(3, '0')}
              </span>
              <div>
                <small>
                  {block.speaker || '旁白'}
                  {' · 段 '}
                  {block.segmentIndex + 1}
                </small>
                <p>{block.text}</p>
              </div>
            </article>
          );
        })}
        {blocks.length === 0 && <EmptyStage message="正文规范化尚未完成。" />}
      </div>
      {blocks.length > 0 && (
        <div className="ai-prose-stage-callout">
          <button
            className="ai-prose-button ai-prose-button--secondary"
            type="button"
            onClick={onNormalize}
            disabled={busy || failedTasks.length > 0}
          >
            重新规范化
          </button>
        </div>
      )}
    </section>
  );
}

function TimingStage({
  draft,
  blocks,
  scriptReadingSpeed,
  onReadingSpeedChange,
  onRhythm,
  busy,
  enableActing,
  enableCinematic,
  onEnableActingChange,
  onEnableCinematicChange,
  onRunEnhancement,
  enhancementBusy,
  enhancementMessage,
  enhancementOperationCount,
  enhancementMotions,
}: {
  draft: DraftSession;
  blocks: ReturnType<typeof splitAiProseNormalizationTasks>;
  scriptReadingSpeed: number;
  onReadingSpeedChange: (value: number) => void;
  onRhythm: () => void;
  busy: boolean;
  enableActing: boolean;
  enableCinematic: boolean;
  onEnableActingChange: (value: boolean) => void;
  onEnableCinematicChange: (value: boolean) => void;
  onRunEnhancement: () => void;
  enhancementBusy: boolean;
  enhancementMessage: string;
  enhancementOperationCount: number;
  enhancementMotions: { readonly motionCount: number; readonly motions: readonly string[] } | null;
}) {
  const preview = draft.preview;
  const statementCount = preview?.statements.length ?? blocks.length;
  const duration = preview?.durationSeconds ?? 0;
  const maxDuration = Math.max(duration, 0.1);

  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro title="时间编排" />
      <div className="ai-prose-timing-progress">
        <div>
          <strong>时间预览</strong>
          <b>
            {statementCount}
            {' '}
            句 ·
            {' '}
            {formatTime(duration)}
          </b>
        </div>
        <div className="ai-prose-progress-track">
          <span style={{ width: `${preview ? 100 : 0}%` }} />
        </div>
        <small>
          {scriptReadingSpeed.toFixed(1)}
          {' '}
          字/秒
        </small>
      </div>
      {preview && (
        <div className="ai-prose-timing-track">
          <div className="ai-prose-timing-axis">
            <span>00:00</span>
            <span>{formatTime(maxDuration * 0.5, 0)}</span>
            <span>{formatTime(maxDuration, 0)}</span>
          </div>
          <div className="ai-prose-timing-line" />
          {preview.statements.map((statement, index) => (
            <span
              key={`${statement.statementIndex}-${statement.time}`}
              className={`ai-prose-timing-block ${statement.speaker ? 'is-dialogue' : 'is-narration'}`}
              style={{
                left: `${Math.min(96, Math.max(0, ((statement.time - preview.anchorTime) / maxDuration) * 100))}%`,
                width: `${Math.max(3, Math.min(18, (statement.durationSeconds / maxDuration) * 100))}%`,
              }}
              title={`${statement.speaker || '旁白'} · ${statement.durationSeconds.toFixed(1)}s`}
            >
              #
              {String(index + 1).padStart(3, '0')}
            </span>
          ))}
        </div>
      )}
      <div className="ai-prose-timing-options">
        <ReadingSpeedControl value={scriptReadingSpeed} onChange={onReadingSpeedChange} compact />
        <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onRhythm} disabled={busy || blocks.length === 0}>
          {preview ? '重新规划节奏' : '计算时间预览'}
        </button>
      </div>

      <div className="ai-enhance-panel ai-prose-optional-enhance">
        <div className="ai-prose-section-title">
          <h3>可选增强</h3>
          <span>{enhancementOperationCount > 0 ? `${enhancementOperationCount} 操作` : '基线'}</span>
        </div>
        <div className="ai-enhance-mode-row" role="group" aria-label="可选增强">
          <button
            type="button"
            className={`ai-prose-button ${enableActing ? 'ai-prose-button--primary' : 'ai-prose-button--secondary'}`}
            onClick={() => onEnableActingChange(!enableActing)}
            disabled={busy || !preview}
          >
            表演指导
          </button>
          <button
            type="button"
            className={`ai-prose-button ${enableCinematic ? 'ai-prose-button--primary' : 'ai-prose-button--secondary'}`}
            onClick={() => onEnableCinematicChange(!enableCinematic)}
            disabled={busy || !preview}
          >
            电影感
          </button>
          <button
            type="button"
            className="ai-prose-button ai-prose-button--secondary"
            onClick={onRunEnhancement}
            disabled={busy || !preview || (!enableActing && !enableCinematic)}
          >
            {enhancementBusy ? '增强中…' : '运行可选增强'}
          </button>
        </div>
        {enhancementMessage && (
          <div className="ai-enhance-note">{enhancementMessage}</div>
        )}
        {enhancementMotions && enhancementMotions.motionCount > 0 && (
          <div className="ai-enhance-motion-summary">
            <strong>
              表演指导已为
              {' '}
              {enhancementMotions.motionCount}
              {' '}
              条对白填充动作：
            </strong>
            <span>{enhancementMotions.motions.join('、')}</span>
          </div>
        )}
        <p className="ai-prose-timing-hint">
          应用时始终写入确定性基线与角色表演占位；可选增强 patch 若已生成将一并原子提交。
          既有正式 scene 请用「正式增强」模式。
        </p>
      </div>

      <div className="ai-prose-timing-table">
        <div className="ai-prose-timing-row is-head">
          <span>#</span>
          <span>语句</span>
          <span>时长</span>
          <span>起点</span>
          <span>间隔</span>
        </div>
        {preview?.statements.map((statement, index) => (
          <div className="ai-prose-timing-row" key={`${statement.statementIndex}-${statement.time}`}>
            <span>
              #
              {String(index + 1).padStart(3, '0')}
            </span>
            <strong>{statement.text}</strong>
            <b>
              {statement.durationSeconds.toFixed(1)}
              s
            </b>
            <span>{formatTime(statement.time)}</span>
            <span>{statement.gapSecondsToNext ? `${statement.gapSecondsToNext.toFixed(2)}s` : '—'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyStage({ message }: { message: string }) {
  return <div className="ai-prose-empty-stage"><span>—</span>{message}</div>;
}

function ApplyDialog({ draft, onCancel, onConfirm }: { draft: DraftSession; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="ai-prose-apply-overlay" role="dialog" aria-modal="true" aria-labelledby="ai-prose-apply-title">
      <div className="ai-prose-apply-dialog">
        <h2 id="ai-prose-apply-title">写入正式时间线？</h2>
        <p>
          将添加
          {' '}
          {draft.preview?.statements.length ?? 0}
          {' '}
          条语句（含绑定对白的表演占位）；现有时间线不会被覆盖或平移。
        </p>
        <div className="ai-prose-apply-summary">
          <div>
            <label>锚点</label>
            <b>{formatTime(draft.anchorTime)}</b>
          </div>
          <div>
            <label>时长</label>
            <b>{formatTime(draft.preview?.durationSeconds ?? 0)}</b>
          </div>
          <div>
            <label>人物</label>
            <b>{draft.confirmedMainCharacters.length}</b>
          </div>
        </div>
        <div className="ai-prose-apply-actions">
          <button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={onCancel}>取消</button>
          <button className="ai-prose-button ai-prose-button--primary" type="button" onClick={onConfirm}>确认原子应用</button>
        </div>
      </div>
    </div>
  );
}

export default AiProseWorkbench;
