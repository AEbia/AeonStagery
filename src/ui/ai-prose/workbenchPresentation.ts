import type { SceneMeta } from '../../api/types/scene-common';
import { splitAiProseNormalizationTasks, type AiProseStatementBlock } from '../../services/ai-authoring/AiProseDeterministicCompiler';
import type { AiProsePreview, AiProseTaskError, AiProseTaskStatus } from '../../api/types/ai-prose-authoring';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { toRecord } from '../AiProseTrace';

export type WorkbenchStage = 'source' | 'segments' | 'characters' | 'normalize' | 'timing';

export const STAGES: readonly {
  id: WorkbenchStage;
  number: string;
  label: string;
  shortLabel: string;
  description: string;
}[] = [
  { id: 'source', number: '01', label: '原文输入', shortLabel: '原文', description: '粘贴或导入正文，开始分析故事段落与主要人物。' },
  { id: 'segments', number: '02', label: '语义分段', shortLabel: '分段', description: '检查故事段落；需要调整时，可修改目标处理量后重新分析。' },
  { id: 'characters', number: '03', label: '人物确认', shortLabel: '人物', description: '核对主要人物名单，可修改、补充或删除 AI 建议的人物。' },
  { id: 'normalize', number: '04', label: '语句规范化', shortLabel: '语句', description: '检查拆分后的对白与旁白，确认后计算时间预览。' },
  { id: 'timing', number: '05', label: '时间编排', shortLabel: '时间', description: '核对语句时长与起点，调整朗读速度，再写入正式时间线。' },
];

export type WorkbenchErrorInfo = {
  stage?: WorkbenchStage;
  code?: string;
  message: string;
  details: Record<string, unknown>;
};

export function createWorkbenchErrorInfo(error: unknown, stage?: WorkbenchStage): WorkbenchErrorInfo {
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

export function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

export function formatTime(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '00:00.0';
  const safe = Number(Math.max(0, value).toFixed(decimals));
  const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
  const seconds = (safe % 60).toFixed(decimals).padStart(decimals === 0 ? 2 : 4, '0');
  return `${minutes}:${seconds}`;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stageStatus(draft: DraftSession | null, stage: WorkbenchStage): AiProseTaskStatus {
  if (!draft) return 'idle';
  if (stage === 'source') return draft.sourceText.length > 0 ? 'succeeded' : 'idle';
  if (stage === 'segments') return draft.segmentation.status;
  if (stage === 'characters') return draft.characterExtraction.status;
  if (stage === 'normalize') {
    if (draft.normalization.length === 0) return 'idle';
    if (draft.normalization.some((task) => task.status === 'failed')) return 'failed';
    if (draft.normalization.some((task) => task.status === 'running')) return 'running';
    return draft.normalization.length === draft.segmentation.segments.length
      && draft.normalization.every((task) => task.status === 'succeeded') ? 'succeeded' : 'idle';
  }
  return draft.preview ? 'succeeded' : 'idle';
}

export function isStageReady(draft: DraftSession | null, stage: WorkbenchStage): boolean {
  if (!draft) return stage === 'source';
  if (stage === 'source') return true;
  if (stage === 'segments') return draft.segmentation.status !== 'idle';
  if (stage === 'characters') return draft.segmentation.status === 'succeeded';
  if (stage === 'normalize') return draft.mainCharactersConfirmed && draft.segmentation.status === 'succeeded';
  return draft.normalization.length > 0
    && draft.normalization.length === draft.segmentation.segments.length
    && draft.normalization.every((task) => task.status === 'succeeded');
}

export function getResumeStage(draft: DraftSession): WorkbenchStage {
  if (draft.status === 'applied' || isStageReady(draft, 'timing')) return 'timing';
  if (draft.mainCharactersConfirmed) return 'normalize';
  if (draft.segmentation.status === 'succeeded') return draft.characterExtraction.status === 'idle' ? 'segments' : 'characters';
  if (draft.segmentation.status !== 'idle') return 'segments';
  return 'source';
}

export function statusText(status: AiProseTaskStatus): string {
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '需重试';
  if (status === 'running') return '运行中';
  return '未开始';
}

export function getLineNumberAtOffset(sourceText: string, offset: number): number {
  return sourceText.slice(0, offset).split(/\r?\n/u).length;
}

export function getCompletedTaskCount(tasks: readonly { status: AiProseTaskStatus }[]): number {
  return tasks.filter((task) => task.status === 'succeeded').length;
}


export type NormalizationGroup = {
  segmentIndex: number;
  status: AiProseTaskStatus;
  error?: AiProseTaskError;
  lineRange: [number, number] | null;
  blocks: AiProseStatementBlock[];
};

export function groupNormalizationBlocks(draft: DraftSession): NormalizationGroup[] {
  return [...draft.normalization].sort((a, b) => a.segmentIndex - b.segmentIndex).map((task) => {
    const segment = draft.segmentation.segments.find((item) => item.index === task.segmentIndex);
    let blocks: AiProseStatementBlock[] = [];
    if (task.status === 'succeeded' && task.statements.some((statement) => statement.text.trim())) {
      blocks = splitAiProseNormalizationTasks([task]);
    }
    return {
      segmentIndex: task.segmentIndex,
      status: task.status,
      error: task.error,
      lineRange: segment ? [
        getLineNumberAtOffset(draft.sourceText, segment.startOffset),
        getLineNumberAtOffset(draft.sourceText, Math.max(segment.startOffset, segment.endOffset - 1)),
      ] : null,
      blocks,
    };
  });
}

export function countBlocksByKind(blocks: readonly { speaker: string }[]): { all: number; dialogue: number; narration: number } {
  const dialogue = blocks.filter((block) => block.speaker !== '').length;
  return { all: blocks.length, dialogue, narration: blocks.length - dialogue };
}

export function resolveSpeakerColors(speakers: readonly string[], sceneCharacters: SceneMeta['characters']): Map<string, string> {
  const palette = ['character', 'camera', 'environment', 'audio', 'dialogue'];
  const colors = new Map<string, string>();
  for (const speaker of speakers) {
    if (!speaker || colors.has(speaker)) continue;
    const color = sceneCharacters?.find((character) => character.name === speaker && character.color)?.color;
    colors.set(speaker, color || `var(--color-${palette[colors.size % palette.length]})`);
  }
  return colors;
}

export function summarizeTiming(preview: AiProsePreview): {
  dialogueCount: number; narrationCount: number; averageDuration: number; longestDuration: number;
} {
  const counts = countBlocksByKind(preview.statements);
  let total = 0;
  let longest = 0;
  for (const statement of preview.statements) {
    total += statement.durationSeconds;
    longest = Math.max(longest, statement.durationSeconds);
  }
  return {
    dialogueCount: counts.dialogue,
    narrationCount: counts.narration,
    averageDuration: counts.all ? total / counts.all : 0,
    longestDuration: longest,
  };
}

export function estimateReadingSeconds(spokenCount: number, speed: number): number {
  return Number.isFinite(spokenCount) && Number.isFinite(speed) && speed > 0
    ? Math.max(0, spokenCount) / speed : 0;
}
