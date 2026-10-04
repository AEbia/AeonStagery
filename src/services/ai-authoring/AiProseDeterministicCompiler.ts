import {
  AI_PROSE_BLOCK_TARGET_VISIBLE_CHARACTERS,
  DEFAULT_BASELINE_GAP_SECONDS,
  DEFAULT_SCRIPT_READING_SPEED,
  DEFAULT_STORY_SEGMENT_GAP_SECONDS,
  MAX_RHYTHM_GAP_SECONDS,
  MIN_RHYTHM_GAP_SECONDS,
  type AiProseCanonicalStatement,
  type AiProseNormalizationTask,
  type AiProseRhythmTask,
  type AiProseTimedStatement,
} from '../../api/types/ai-prose-authoring';
import {
  estimateAiProseDuration,
  splitAiProseStatementText,
} from './AiProseTextMetrics';

export interface AiProseStatementBlock extends AiProseCanonicalStatement {
  segmentIndex: number;
  sourceStatementIndex: number;
  blockIndex: number;
}

export interface AiProseDeterministicCompilerOptions {
  scriptReadingSpeed?: number;
  baselineGapSeconds?: number;
  storySegmentGapSeconds?: number;
  targetVisibleCharacters?: number;
}

export function splitAiProseNormalizationTasks(
  tasks: readonly AiProseNormalizationTask[],
  targetVisibleCharacters = AI_PROSE_BLOCK_TARGET_VISIBLE_CHARACTERS,
): AiProseStatementBlock[] {
  const blocks: AiProseStatementBlock[] = [];
  [...tasks]
    .sort((left, right) => left.segmentIndex - right.segmentIndex)
    .forEach((task) => {
      if (task.status !== 'succeeded') {
        throw new Error(`故事段 ${task.segmentIndex + 1} 尚未完成正文规范化`);
      }
      task.statements.forEach((statement, sourceStatementIndex) => {
        const chunks = splitAiProseStatementText(statement.text, targetVisibleCharacters);
        chunks.forEach((text, blockIndex) => {
          blocks.push({
            segmentIndex: task.segmentIndex,
            sourceStatementIndex,
            blockIndex,
            speaker: statement.speaker,
            text,
          });
        });
      });
    });
  if (blocks.length === 0) throw new Error('正文规范化没有生成可编排的语句块');
  return blocks;
}

export function clampAiProseRhythmGap(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BASELINE_GAP_SECONDS;
  return Math.min(MAX_RHYTHM_GAP_SECONDS, Math.max(MIN_RHYTHM_GAP_SECONDS, value));
}

function resolveSegmentGaps(
  segmentBlocks: readonly AiProseStatementBlock[],
  rhythmTask: AiProseRhythmTask | undefined,
  fallbackGap: number,
): number[] {
  const expectedLength = Math.max(0, segmentBlocks.length - 1);
  if (!rhythmTask || rhythmTask.status !== 'succeeded' || rhythmTask.gapSeconds.length !== expectedLength) {
    return Array.from({ length: expectedLength }, () => fallbackGap);
  }
  return rhythmTask.gapSeconds.map(clampAiProseRhythmGap);
}

export function buildAiProseDeterministicPreview(
  normalizationTasks: readonly AiProseNormalizationTask[],
  rhythmTasks: readonly AiProseRhythmTask[] = [],
  anchorTime = 0,
  options: AiProseDeterministicCompilerOptions = {},
): {
  statements: AiProseTimedStatement[];
  anchorTime: number;
  durationSeconds: number;
} {
  if (!Number.isFinite(anchorTime) || anchorTime < 0) throw new Error('anchorTime must be a non-negative finite number');
  const baselineGap = options.baselineGapSeconds ?? DEFAULT_BASELINE_GAP_SECONDS;
  const storySegmentGap = options.storySegmentGapSeconds ?? DEFAULT_STORY_SEGMENT_GAP_SECONDS;
  if (!Number.isFinite(baselineGap) || baselineGap < 0) throw new Error('baselineGapSeconds must be non-negative');
  if (!Number.isFinite(storySegmentGap) || storySegmentGap < 0) throw new Error('storySegmentGapSeconds must be non-negative');

  const blocks = splitAiProseNormalizationTasks(
    normalizationTasks,
    options.targetVisibleCharacters ?? AI_PROSE_BLOCK_TARGET_VISIBLE_CHARACTERS,
  );
  const rhythmBySegment = new Map(rhythmTasks.map((task) => [task.segmentIndex, task]));
  const gapsByBlockIndex = new Map<number, number>();

  let blockStart = 0;
  while (blockStart < blocks.length) {
    const segmentIndex = blocks[blockStart].segmentIndex;
    let blockEnd = blockStart + 1;
    while (blockEnd < blocks.length && blocks[blockEnd].segmentIndex === segmentIndex) blockEnd += 1;
    const segmentBlocks = blocks.slice(blockStart, blockEnd);
    const segmentGaps = resolveSegmentGaps(segmentBlocks, rhythmBySegment.get(segmentIndex), baselineGap);
    segmentGaps.forEach((gap, index) => gapsByBlockIndex.set(blockStart + index, gap));
    blockStart = blockEnd;
  }

  const statements: AiProseTimedStatement[] = [];
  let cursor = anchorTime;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const durationSeconds = estimateAiProseDuration(block.text, {
      scriptReadingSpeed: options.scriptReadingSpeed ?? DEFAULT_SCRIPT_READING_SPEED,
    });
    const nextBlock = blocks[index + 1];
    const gapSecondsToNext = nextBlock
      ? nextBlock.segmentIndex === block.segmentIndex
        ? gapsByBlockIndex.get(index) ?? baselineGap
        : storySegmentGap
      : 0;
    statements.push({
      speaker: block.speaker,
      text: block.text,
      segmentIndex: block.segmentIndex,
      statementIndex: index,
      time: index === 0 ? anchorTime : roundTime(cursor),
      durationSeconds,
      gapSecondsToNext,
    });
    cursor = roundTime(cursor + durationSeconds + gapSecondsToNext);
  }

  const last = statements.at(-1);
  const end = last ? roundTime(last.time + last.durationSeconds - anchorTime) : 0;
  return {
    statements,
    anchorTime,
    durationSeconds: end,
  };
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}
