import {
  type AiProseCharacterExtractionState,
  type AiProseNormalizationTask,
  type AiProsePreview,
  type AiProseRhythmTask,
  type AiProseSegmentationState,
  type AiProseStorySegment,
  type AiProseTaskError,
} from '../../api/types/ai-prose-authoring';
import {
  DEFAULT_BASELINE_GAP_SECONDS,
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_SCRIPT_READING_SPEED,
} from '../../api/types/ai-prose-authoring';
import {
  type AiProseLlmResult,
  AiProseLlmService,
} from './AiProseLlmService';
import type { AiProseLlmProgress } from './AiProseContracts';
import {
  buildAiProseDeterministicPreview,
  clampAiProseRhythmGap,
  splitAiProseNormalizationTasks,
  type AiProseStatementBlock,
} from './AiProseDeterministicCompiler';
import {
  createAiProseSegmentationPlan,
  createAiProseSegmentationFingerprint,
  type AiProseSegmentationPlan,
} from './AiProseSegmentation';
import {
  confirmMainCharacters,
  replaceCharacterExtraction,
  replaceNormalization,
  replacePreview,
  replaceRhythm,
  replaceSegmentation,
  updateScriptReadingSpeed,
  updateNormalizationTask,
  updateRhythmTask,
  type DraftSession,
} from './AiProseDraftSession';
import type {
  AiProseDraftPersistence,
  AiProseDraftProjectInput,
} from './AiProseDraftPersistence';

export interface AiProsePipelinePrepareOptions {
  targetBatchSize?: number;
  anchorTime?: number;
  scriptReadingSpeed?: number;
  targetVisibleCharacters?: number;
  sourceRevision?: number;
  existingPrepared?: AiProsePreparedPipeline;
  existing?: AiProsePipelineExistingCheckpoint;
  existingDraft?: Pick<DraftSession, 'sourceText' | 'sourceRevision' | 'scriptReadingSpeed'>;
  checkpoint?: AiProsePipelineCheckpoint;
  onLlmProgress?: (progress: AiProseLlmProgress) => void;
}

export interface AiProsePipelineOptions {
  scriptReadingSpeed?: number;
  targetVisibleCharacters?: number;
  checkpoint?: AiProsePipelineCheckpoint;
}

export interface AiProsePreparedPipeline {
  sourceText: string;
  sourceRevision?: number;
  anchorTime: number;
  targetBatchSize: number;
  segmentationFingerprint: string;
  scriptReadingSpeed?: number;
  targetVisibleCharacters?: number;
  plan: AiProseSegmentationPlan;
  segmentation: AiProseSegmentationState;
  characterExtraction: AiProseCharacterExtractionState;
  segments: AiProseStorySegment[];
  suggestedMainCharacters: string[];
}

export interface AiProseNormalizationRun {
  status: 'succeeded' | 'failed';
  sourceText?: string;
  sourceRevision?: number;
  segmentationFingerprint: string;
  confirmedMainCharacters: string[];
  tasks: AiProseNormalizationTask[];
}

export interface AiProseCharacterConfirmation {
  confirmedMainCharacters: readonly string[];
  mainCharactersConfirmed?: boolean;
}

export type AiProseConfirmationInput =
  | readonly string[]
  | AiProseCharacterConfirmation;

export interface AiProseRhythmRun {
  status: 'succeeded' | 'failed';
  sourceText?: string;
  sourceRevision?: number;
  segmentationFingerprint: string;
  normalizationFingerprint?: string;
  tasks: AiProseRhythmTask[];
  preview: AiProsePreview;
}

export interface AiProsePipelineExistingCheckpoint {
  sourceText: string;
  sourceRevision?: number;
  targetBatchSize: number;
  anchorTime: number;
  segmentation?: AiProseSegmentationState;
  characterExtraction?: AiProseCharacterExtractionState;
}

export interface AiProsePipelineCheckpoint {
  onPrepared?: (prepared: AiProsePreparedPipeline) => void | Promise<void>;
  onNormalizationTask?: (context: {
    sourceText: string;
    sourceRevision?: number;
    segmentationFingerprint: string;
    confirmedMainCharacters: readonly string[];
    task: AiProseNormalizationTask;
  }) => void | Promise<void>;
  onRhythmTask?: (context: {
    sourceText: string;
    sourceRevision?: number;
    segmentationFingerprint: string;
    normalizationFingerprint: string;
    task: AiProseRhythmTask;
  }) => void | Promise<void>;
  onNormalizationComplete?: (run: AiProseNormalizationRun) => void | Promise<void>;
  onRhythmComplete?: (run: AiProseRhythmRun) => void | Promise<void>;
}

export interface AiProseDraftPersistenceCheckpoint extends AiProsePipelineCheckpoint {
  getDraft(): DraftSession;
}

export interface AiProseNormalizationOptions {
  existing?: AiProseNormalizationRun;
  existingDraft?: Pick<DraftSession, 'sourceText' | 'sourceRevision' | 'confirmedMainCharacters' | 'segmentation' | 'normalization'>;
  checkpoint?: AiProsePipelineCheckpoint;
  onLlmProgress?: (progress: AiProseLlmProgress) => void;
}

export interface AiProseRetryOptions {
  checkpoint?: AiProsePipelineCheckpoint;
  onLlmProgress?: (progress: AiProseLlmProgress) => void;
}

export interface AiProseRhythmOptions {
  existing?: AiProseRhythmRun;
  existingDraft?: Pick<DraftSession, 'sourceText' | 'sourceRevision' | 'segmentation' | 'normalization' | 'rhythm'>;
  checkpoint?: AiProsePipelineCheckpoint;
  onLlmProgress?: (progress: AiProseLlmProgress) => void;
}

export class AiProsePipelineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AiProsePipelineError';
    this.code = code;
  }
}

function requireAnchorTime(anchorTime: number | undefined): number {
  const value = anchorTime ?? 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new AiProsePipelineError('invalid-anchor-time', 'anchorTime must be a non-negative finite number');
  }
  return value;
}

function resultError<T>(result: AiProseLlmResult<T>): AiProseTaskError | undefined {
  return result.status === 'failed' ? result.error : undefined;
}

function createSegmentationState(
  plan: AiProseSegmentationPlan,
  result: AiProseLlmResult<{
    boundaryIds: string[];
    segments: AiProseStorySegment[];
  }>,
): AiProseSegmentationState {
  const boundaryIds = result.status === 'succeeded' ? [...result.value.boundaryIds] : [];
  const segments = result.status === 'succeeded' ? [...result.value.segments] : [];
  return {
    status: result.status,
    planFingerprint: createAiProseSegmentationFingerprint(plan, boundaryIds, segments),
    targetSegmentCount: plan.targetSegmentCount,
    candidates: [...plan.candidates],
    boundaryIds,
    segments,
    ...(resultError(result) ? { error: resultError(result) } : {}),
  };
}

function createCharacterExtractionState(
  result: AiProseLlmResult<{ mainCharacters: string[] }>,
): AiProseCharacterExtractionState {
  return {
    status: result.status,
    suggestedNames: result.status === 'succeeded' ? [...result.value.mainCharacters] : [],
    ...(resultError(result) ? { error: resultError(result) } : {}),
  };
}

function resolveConfirmedMainCharacters(
  input: AiProseConfirmationInput,
): string[] {
  const names: readonly string[] = isCharacterConfirmation(input)
    ? input.confirmedMainCharacters
    : input;
  const explicitlyUnconfirmed = isCharacterConfirmation(input)
    && input.mainCharactersConfirmed !== true;
  if (explicitlyUnconfirmed) {
    throw new AiProsePipelineError(
      'main-characters-not-confirmed',
      'normalization requires an explicit main-character confirmation',
    );
  }
  if (names.some((name) => typeof name !== 'string' || name.trim().length === 0)) {
    throw new AiProsePipelineError(
      'invalid-confirmed-main-characters',
      'confirmed main character names must be non-empty strings',
    );
  }
  return [...names];
}

function isCharacterConfirmation(
  input: AiProseConfirmationInput,
): input is AiProseCharacterConfirmation {
  return !Array.isArray(input);
}

function resolveExistingPrepareCheckpoint(
  options: AiProsePipelinePrepareOptions,
): AiProsePreparedPipeline | AiProsePipelineExistingCheckpoint | undefined {
  return options.existingPrepared ?? options.existing;
}

function isReusablePrepareCheckpoint(
  existing: AiProsePreparedPipeline | AiProsePipelineExistingCheckpoint | undefined,
  sourceText: string,
  targetBatchSize: number,
  anchorTime: number,
  sourceRevision: number | undefined,
): boolean {
  const existingSegmentation = existing?.segmentation;
  const expectedFingerprint = existingSegmentation
    ? createAiProseSegmentationFingerprint(
      createAiProseSegmentationPlan(sourceText, targetBatchSize),
      existingSegmentation.boundaryIds,
      existingSegmentation.segments,
    )
    : undefined;
  return !!existing
    && existing.sourceText === sourceText
    && existing.targetBatchSize === targetBatchSize
    && existing.anchorTime === anchorTime
    && existing.sourceRevision === sourceRevision
    && existingSegmentation?.planFingerprint === expectedFingerprint;
}

function createNormalizationTask(
  segmentIndex: number,
  result: AiProseLlmResult<{ statements: Array<{ speaker: string; text: string }> }>,
): AiProseNormalizationTask {
  return {
    segmentIndex,
    status: result.status,
    statements: result.status === 'succeeded' ? [...result.value.statements] : [],
    ...(result.status === 'failed' ? { error: result.error } : {}),
  };
}

function createRhythmTask(
  segmentIndex: number,
  blockCount: number,
  result: AiProseLlmResult<{ gapSeconds: number[] }>,
): AiProseRhythmTask {
  if (result.status === 'succeeded') {
    return {
      segmentIndex,
      status: 'succeeded',
      gapSeconds: result.value.gapSeconds.map(clampAiProseRhythmGap),
    };
  }
  return {
    segmentIndex,
    status: 'succeeded',
    gapSeconds: Array.from(
      { length: Math.max(0, blockCount - 1) },
      () => DEFAULT_BASELINE_GAP_SECONDS,
    ),
    usedFallback: true,
    error: result.error,
  };
}

function isReusableRunCheckpoint(
  existing: AiProseNormalizationRun | AiProseRhythmRun | undefined,
  sourceText: string,
  sourceRevision: number | undefined,
  segmentationFingerprint: string,
): boolean {
  if (!existing) return false;
  return existing.sourceText === sourceText
    && existing.sourceRevision === sourceRevision
    && existing.segmentationFingerprint === segmentationFingerprint;
}

function assertRunCheckpointMatchesPrepared(
  run: AiProseNormalizationRun,
  prepared: AiProsePreparedPipeline,
): void {
  if (!isReusableRunCheckpoint(
    run,
    prepared.sourceText,
    prepared.sourceRevision,
    prepared.segmentationFingerprint,
  )) {
    throw new AiProsePipelineError(
      'stale-checkpoint',
      'The AI prose checkpoint belongs to a different source revision',
    );
  }
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSegmentationState(
  left: AiProseSegmentationState,
  right: AiProseSegmentationState,
): boolean {
  return left.status === right.status
    && left.planFingerprint === right.planFingerprint
    && left.targetSegmentCount === right.targetSegmentCount
    && JSON.stringify(left.error) === JSON.stringify(right.error);
}

function sameCharacterExtractionState(
  left: AiProseCharacterExtractionState,
  right: AiProseCharacterExtractionState,
): boolean {
  return left.status === right.status
    && sameStringList(left.suggestedNames, right.suggestedNames)
    && JSON.stringify(left.error) === JSON.stringify(right.error);
}

function cloneNormalizationTask(task: AiProseNormalizationTask): AiProseNormalizationTask {
  return {
    ...task,
    statements: task.statements.map((statement) => ({ ...statement })),
    ...(task.error ? { error: { ...task.error, ...(task.error.details ? { details: { ...task.error.details } } : {}) } } : {}),
  };
}

function cloneRhythmTask(task: AiProseRhythmTask): AiProseRhythmTask {
  return {
    ...task,
    gapSeconds: [...task.gapSeconds],
    ...(task.error ? { error: { ...task.error, ...(task.error.details ? { details: { ...task.error.details } } : {}) } } : {}),
  };
}

function normalizationRunFromDraft(
  draft: NonNullable<AiProseNormalizationOptions['existingDraft']>,
): AiProseNormalizationRun {
  return {
    status: draft.normalization.length > 0
      && draft.normalization.every((task) => task.status === 'succeeded')
      ? 'succeeded'
      : 'failed',
    sourceText: draft.sourceText,
    sourceRevision: draft.sourceRevision,
    segmentationFingerprint: draft.segmentation.planFingerprint,
    confirmedMainCharacters: [...draft.confirmedMainCharacters],
    tasks: draft.normalization.map(cloneNormalizationTask),
  };
}

function rhythmRunFromDraft(
  draft: NonNullable<AiProseRhythmOptions['existingDraft']>,
  targetVisibleCharacters: number | undefined,
): AiProseRhythmRun | undefined {
  try {
    const blocks = splitAiProseNormalizationTasks(draft.normalization, targetVisibleCharacters);
    return {
      status: 'succeeded',
      sourceText: draft.sourceText,
      sourceRevision: draft.sourceRevision,
      segmentationFingerprint: draft.segmentation.planFingerprint,
      normalizationFingerprint: fingerprintNormalizationBlocks(blocks),
      tasks: draft.rhythm.map(cloneRhythmTask),
      preview: {
        statements: [],
        anchorTime: 0,
        durationSeconds: 0,
      },
    };
  } catch {
    return undefined;
  }
}

function fingerprintNormalizationBlocks(blocks: readonly AiProseStatementBlock[]): string {
  return JSON.stringify(blocks.map((block) => ({
    segmentIndex: block.segmentIndex,
    sourceStatementIndex: block.sourceStatementIndex,
    blockIndex: block.blockIndex,
    speaker: block.speaker,
    text: block.text,
  })));
}

export class AiProsePipeline {
  constructor(
    private readonly llm: AiProseLlmService,
    private options: AiProsePipelineOptions = {},
  ) {}

  updateOptions(options: Partial<AiProsePipelineOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async prepare(
    sourceText: string,
    options: AiProsePipelinePrepareOptions = {},
  ): Promise<AiProsePreparedPipeline> {
    if (typeof sourceText !== 'string') {
      throw new AiProsePipelineError('invalid-source-text', 'sourceText must be a string');
    }
    const targetBatchSize = options.targetBatchSize ?? this.llm.targetBatchSize ?? DEFAULT_AI_TARGET_BATCH_SIZE;
    const anchorTime = requireAnchorTime(options.anchorTime);
    const plan = createAiProseSegmentationPlan(sourceText, targetBatchSize);
    const existing = resolveExistingPrepareCheckpoint(options);
    const canReusePrepare = isReusablePrepareCheckpoint(
      existing,
      sourceText,
      targetBatchSize,
      anchorTime,
      options.sourceRevision,
    );
    const reuseSegmentation = canReusePrepare && existing?.segmentation?.status === 'succeeded';
    const reuseCharacterExtraction = canReusePrepare && existing?.characterExtraction?.status === 'succeeded';
    const [segmentationResult, characterResult] = await Promise.all([
      reuseSegmentation
        ? Promise.resolve({
          status: 'succeeded' as const,
          value: {
            boundaryIds: [...existing!.segmentation!.boundaryIds],
            segments: [...existing!.segmentation!.segments],
          },
          correctionUsed: false,
        })
        : this.llm.segment(plan, { onProgress: options.onLlmProgress }),
      reuseCharacterExtraction
        ? Promise.resolve({
          status: 'succeeded' as const,
          value: { mainCharacters: [...existing!.characterExtraction!.suggestedNames] },
          correctionUsed: false,
        })
        : this.llm.extractCharacters(sourceText, { onProgress: options.onLlmProgress }),
    ]);
    const segmentation = createSegmentationState(plan, segmentationResult);
    const characterExtraction = createCharacterExtractionState(characterResult);
    const prepared = {
      sourceText,
      sourceRevision: options.sourceRevision ?? existing?.sourceRevision,
      anchorTime,
      targetBatchSize,
      segmentationFingerprint: segmentation.planFingerprint,
      scriptReadingSpeed: options.existingDraft?.scriptReadingSpeed
        ?? options.scriptReadingSpeed
        ?? this.options.scriptReadingSpeed
        ?? DEFAULT_SCRIPT_READING_SPEED,
      targetVisibleCharacters: options.targetVisibleCharacters ?? this.options.targetVisibleCharacters,
      plan,
      segmentation,
      characterExtraction,
      segments: [...segmentation.segments],
      suggestedMainCharacters: [...characterExtraction.suggestedNames],
    };
    await (options.checkpoint ?? this.options.checkpoint)?.onPrepared?.(prepared);
    return prepared;
  }

  async normalize(
    prepared: AiProsePreparedPipeline,
    confirmation: AiProseConfirmationInput,
    options: AiProseNormalizationOptions = {},
  ): Promise<AiProseNormalizationRun> {
    const confirmedMainCharacters = resolveConfirmedMainCharacters(confirmation);
    if (prepared.segmentation.status !== 'succeeded' || prepared.segments.length === 0) {
      throw new AiProsePipelineError(
        'segmentation-not-ready',
        'normalization requires a successful segmentation plan',
      );
    }
    const checkpoint = options.checkpoint ?? this.options.checkpoint;
    const existing = options.existing
      ?? (options.existingDraft ? normalizationRunFromDraft(options.existingDraft) : undefined);
    const reuseExisting = isReusableRunCheckpoint(
      existing,
      prepared.sourceText,
      prepared.sourceRevision,
      prepared.segmentationFingerprint,
    )
      && sameStringList(existing!.confirmedMainCharacters, confirmedMainCharacters);
    const existingTasks = new Map(existing?.tasks.map((task) => [task.segmentIndex, task]));
    const tasks = await Promise.all(prepared.segments.map(async (segment) => {
      const existingTask = reuseExisting ? existingTasks.get(segment.index) : undefined;
      const task = existingTask?.status === 'succeeded'
        ? cloneNormalizationTask(existingTask)
        : createNormalizationTask(
          segment.index,
          await this.llm.normalize(segment, confirmedMainCharacters, { onProgress: options.onLlmProgress }),
        );
      await checkpoint?.onNormalizationTask?.({
        sourceText: prepared.sourceText,
        sourceRevision: prepared.sourceRevision,
        segmentationFingerprint: prepared.segmentationFingerprint,
        confirmedMainCharacters,
        task,
      });
      return task;
    }));
    tasks.sort((left, right) => left.segmentIndex - right.segmentIndex);
    const run: AiProseNormalizationRun = {
      status: tasks.every((task) => task.status === 'succeeded') ? 'succeeded' : 'failed',
      sourceText: prepared.sourceText,
      sourceRevision: prepared.sourceRevision,
      segmentationFingerprint: prepared.segmentationFingerprint,
      confirmedMainCharacters,
      tasks,
    };
    await checkpoint?.onNormalizationComplete?.(run);
    return run;
  }

  async retrySegment(
    prepared: AiProsePreparedPipeline,
    previous: AiProseNormalizationRun,
    segmentIndex: number,
    options: AiProseRetryOptions = {},
  ): Promise<AiProseNormalizationRun> {
    assertRunCheckpointMatchesPrepared(previous, prepared);
    const existingTaskIndex = previous.tasks.findIndex((task) => task.segmentIndex === segmentIndex);
    if (existingTaskIndex < 0) {
      throw new AiProsePipelineError(
        'unknown-segment',
        `cannot retry unknown story segment ${segmentIndex}`,
      );
    }
    if (previous.tasks[existingTaskIndex].status === 'succeeded') {
      return previous;
    }
    const segment = prepared.segments.find((candidate) => candidate.index === segmentIndex);
    if (!segment) {
      throw new AiProsePipelineError(
        'unknown-segment',
        `cannot retry unknown story segment ${segmentIndex}`,
      );
    }
    const confirmedMainCharacters = resolveConfirmedMainCharacters(
      previous.confirmedMainCharacters,
    );
    const retriedTask = createNormalizationTask(
      segmentIndex,
      await this.llm.normalize(segment, confirmedMainCharacters, { onProgress: options.onLlmProgress }),
    );
    await (options.checkpoint ?? this.options.checkpoint)?.onNormalizationTask?.({
      sourceText: prepared.sourceText,
      sourceRevision: prepared.sourceRevision,
      segmentationFingerprint: prepared.segmentationFingerprint,
      confirmedMainCharacters,
      task: retriedTask,
    });
    const tasks = previous.tasks.map((task, index) => (
      index === existingTaskIndex ? retriedTask : task
    ));
    tasks.sort((left, right) => left.segmentIndex - right.segmentIndex);
    const run: AiProseNormalizationRun = {
      status: tasks.every((task) => task.status === 'succeeded') ? 'succeeded' : 'failed',
      sourceText: prepared.sourceText,
      sourceRevision: prepared.sourceRevision,
      segmentationFingerprint: prepared.segmentationFingerprint,
      confirmedMainCharacters,
      tasks,
    };
    await (options.checkpoint ?? this.options.checkpoint)?.onNormalizationComplete?.(run);
    return run;
  }

  async rhythm(
    prepared: AiProsePreparedPipeline,
    normalization: AiProseNormalizationRun,
    options: AiProseRhythmOptions = {},
  ): Promise<AiProseRhythmRun> {
    if (normalization.status !== 'succeeded') {
      throw new AiProsePipelineError(
        'normalization-not-ready',
        'rhythm requires every story segment to pass normalization',
      );
    }
    assertRunCheckpointMatchesPrepared(normalization, prepared);
    const blocks = splitAiProseNormalizationTasks(
      normalization.tasks,
      prepared.targetVisibleCharacters,
    );
    const blocksBySegment = new Map<number, AiProseStatementBlock[]>();
    for (const block of blocks) {
      const segmentBlocks = blocksBySegment.get(block.segmentIndex) ?? [];
      segmentBlocks.push(block);
      blocksBySegment.set(block.segmentIndex, segmentBlocks);
    }
    const normalizationFingerprint = fingerprintNormalizationBlocks(blocks);
    const existing = options.existing
      ?? (options.existingDraft
        ? rhythmRunFromDraft(options.existingDraft, prepared.targetVisibleCharacters)
        : undefined);
    const reuseExisting = isReusableRunCheckpoint(
      existing,
      prepared.sourceText,
      prepared.sourceRevision,
      prepared.segmentationFingerprint,
    )
      && existing?.normalizationFingerprint === normalizationFingerprint;
    const existingTasks = new Map(existing?.tasks.map((task) => [task.segmentIndex, task]));
    const checkpoint = options.checkpoint ?? this.options.checkpoint;
    const tasks = await Promise.all(prepared.segments.map(async (segment) => {
      const segmentBlocks = blocksBySegment.get(segment.index) ?? [];
      const existingTask = reuseExisting ? existingTasks.get(segment.index) : undefined;
      const expectedGapCount = Math.max(0, segmentBlocks.length - 1);
      const task = existingTask?.status === 'succeeded'
        && existingTask.gapSeconds.length === expectedGapCount
        ? cloneRhythmTask(existingTask)
        : createRhythmTask(
          segment.index,
          segmentBlocks.length,
          await this.llm.rhythm(segment.index, segmentBlocks, { onProgress: options.onLlmProgress }),
        );
      await checkpoint?.onRhythmTask?.({
        sourceText: prepared.sourceText,
        sourceRevision: prepared.sourceRevision,
        segmentationFingerprint: prepared.segmentationFingerprint,
        normalizationFingerprint,
        task,
      });
      return task;
    }));
    tasks.sort((left, right) => left.segmentIndex - right.segmentIndex);
    const run: AiProseRhythmRun = {
      status: 'succeeded',
      sourceText: prepared.sourceText,
      sourceRevision: prepared.sourceRevision,
      segmentationFingerprint: prepared.segmentationFingerprint,
      normalizationFingerprint,
      tasks,
      preview: buildAiProseDeterministicPreview(
        normalization.tasks,
        tasks,
        prepared.anchorTime,
        {
          scriptReadingSpeed: prepared.scriptReadingSpeed,
          targetVisibleCharacters: prepared.targetVisibleCharacters,
        },
      ),
    };
    await checkpoint?.onRhythmComplete?.(run);
    return run;
  }
}

export function createAiProseDraftPersistenceCheckpoint(options: {
  persistence: Pick<AiProseDraftPersistence, 'saveCheckpoint'>;
  project: AiProseDraftProjectInput;
  draft: DraftSession;
}): AiProseDraftPersistenceCheckpoint {
  let currentDraft = options.draft;
  let pending = Promise.resolve();

  const enqueue = (operation: () => void | Promise<void>): Promise<void> => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };

  const assertSource = (sourceText: string, sourceRevision: number | undefined): void => {
    if (currentDraft.sourceText !== sourceText
      || (sourceRevision !== undefined && currentDraft.sourceRevision !== sourceRevision)) {
      throw new AiProsePipelineError(
        'stale-checkpoint',
        'The draft persistence checkpoint belongs to a different source revision',
      );
    }
  };

  const assertPlan = (segmentationFingerprint: string): void => {
    if (currentDraft.segmentation.planFingerprint !== segmentationFingerprint) {
      throw new AiProsePipelineError(
        'stale-checkpoint',
        'The draft persistence checkpoint belongs to a different segmentation plan',
      );
    }
  };

  const save = async (): Promise<void> => {
    await options.persistence.saveCheckpoint(options.project, currentDraft);
  };

  return {
    onPrepared: (prepared) => enqueue(async () => {
      assertSource(prepared.sourceText, prepared.sourceRevision);
      // prepare() is also used to rehydrate the next stage. When the
      // segmentation/extraction artifacts are unchanged, replacing them would
      // unnecessarily invalidate the already completed normalization and
      // timing stages. Only clear downstream artifacts when an upstream
      // artifact actually changed.
      if (!sameSegmentationState(currentDraft.segmentation, prepared.segmentation)) {
        currentDraft = replaceSegmentation(currentDraft, prepared.segmentation);
      }
      if (!sameCharacterExtractionState(currentDraft.characterExtraction, prepared.characterExtraction)) {
        currentDraft = replaceCharacterExtraction(currentDraft, prepared.characterExtraction);
      }
      if (prepared.scriptReadingSpeed !== undefined
        && currentDraft.scriptReadingSpeed !== prepared.scriptReadingSpeed) {
        currentDraft = updateScriptReadingSpeed(currentDraft, prepared.scriptReadingSpeed);
        currentDraft = replacePreview(currentDraft, null);
      }
      await save();
    }),
    onNormalizationTask: (context) => enqueue(async () => {
      assertSource(context.sourceText, context.sourceRevision);
      assertPlan(context.segmentationFingerprint);
      if (!currentDraft.mainCharactersConfirmed
        || !sameStringList(currentDraft.confirmedMainCharacters, context.confirmedMainCharacters)) {
        currentDraft = confirmMainCharacters(currentDraft, context.confirmedMainCharacters);
      }
      currentDraft = updateNormalizationTask(currentDraft, context.task);
      await save();
    }),
    onNormalizationComplete: (run) => enqueue(async () => {
      assertSource(run.sourceText ?? currentDraft.sourceText, run.sourceRevision);
      assertPlan(run.segmentationFingerprint);
      currentDraft = replaceNormalization(currentDraft, run.tasks);
      await save();
    }),
    onRhythmTask: (context) => enqueue(async () => {
      assertSource(context.sourceText, context.sourceRevision);
      assertPlan(context.segmentationFingerprint);
      currentDraft = updateRhythmTask(currentDraft, context.task);
      await save();
    }),
    onRhythmComplete: (run) => enqueue(async () => {
      assertSource(run.sourceText ?? currentDraft.sourceText, run.sourceRevision);
      assertPlan(run.segmentationFingerprint);
      currentDraft = replaceRhythm(currentDraft, run.tasks);
      currentDraft = replacePreview(currentDraft, run.preview);
      await save();
    }),
    getDraft: () => currentDraft,
  };
}
