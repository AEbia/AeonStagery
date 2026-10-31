import { useCallback, type MutableRefObject } from 'react';
import type { AiProseTaskStatus } from '../../api/types/ai-prose-authoring';
import type { AiProseLlmProgress } from '../../services/ai-authoring/AiProseContracts';
import type { AiProseAuthoringComposition } from '../../services/ai-authoring/AiProseAuthoringComposition';
import type { AiProseDraftProjectInput } from '../../services/ai-authoring/AiProseDraftPersistence';
import { confirmMainCharacters, type DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import type { AiProseNormalizationRun, AiProsePreparedPipeline } from '../../services/ai-authoring/AiProsePipeline';
import type { useAiRequestTrace } from '../AiProseTrace';
import type { WorkbenchStage } from './workbenchPresentation';

interface ProsePipelineInput {
  composition: AiProseAuthoringComposition | undefined;
  project: AiProseDraftProjectInput | null;
  draftRef: MutableRefObject<DraftSession | null>;
  aiTrace: ReturnType<typeof useAiRequestTrace>;
  setDraft: (draft: DraftSession | null) => void;
  commitDraft: (draft: DraftSession, immediate: boolean) => void;
  reportError: (error: unknown, stage?: WorkbenchStage) => void;
  clearError: () => void;
  setMainCharacters: (names: string[]) => void;
  setBusyStage: (stage: WorkbenchStage | null) => void;
  setActiveStage: (stage: WorkbenchStage) => void;
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

function isTaskSettled(status: AiProseTaskStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function useAiProsePipeline({
  composition, project, draftRef, aiTrace, setDraft, commitDraft, reportError,
  clearError, setMainCharacters, setBusyStage, setActiveStage,
}: ProsePipelineInput) {
  const { handleLlmProgress, reset: resetAiTrace, setRuntimeState: setAiTraceRuntimeState } = aiTrace;

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
  }, [clearError, draftRef, preparePipeline, reportError, resetAiTrace, setActiveStage, setAiTraceRuntimeState, setBusyStage, setMainCharacters]);

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
  }, [clearError, commitDraft, composition, createCheckpoint, draftRef, handleLlmProgress, preparePipeline, reportError, resetAiTrace, setActiveStage, setAiTraceRuntimeState, setBusyStage, setDraft]);

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
  }, [clearError, commitDraft, composition, createCheckpoint, draftRef, handleLlmProgress, preparePipeline, reportError, resetAiTrace, setAiTraceRuntimeState, setBusyStage, setDraft]);

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
  }, [clearError, commitDraft, composition, createCheckpoint, draftRef, handleLlmProgress, preparePipeline, reportError, resetAiTrace, setActiveStage, setAiTraceRuntimeState, setBusyStage, setDraft]);

  return { runPrepare, runNormalization, retryNormalizationSegment, runRhythm };
}
