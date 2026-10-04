import type {
  AiProseBoundaryCandidate,
  AiProseStorySegment,
} from '../../api/types/ai-prose-authoring';
import type { AiProseSegmentationResponse } from './AiProseContracts';
import {
  collectAiProsePunctuationEvents,
  visibleCharacterCount,
} from './AiProseTextMetrics';

export interface AiProseLine {
  lineNumber: number;
  start: number;
  contentEnd: number;
  end: number;
  text: string;
}

export interface AiProseSegmentationPlan {
  sourceText: string;
  targetBatchSize: number;
  targetSegmentCount: number;
  lines: AiProseLine[];
  candidates: AiProseBoundaryCandidate[];
  numberedSource: string;
}

export interface AiProseValidatedSegmentation {
  boundaryIds: string[];
  segments: AiProseStorySegment[];
}

export function createAiProseSegmentationFingerprint(
  plan: AiProseSegmentationPlan,
  boundaryIds: readonly string[],
  segments: readonly AiProseStorySegment[],
): string {
  return JSON.stringify({
    sourceText: plan.sourceText,
    targetBatchSize: plan.targetBatchSize,
    targetSegmentCount: plan.targetSegmentCount,
    candidates: plan.candidates,
    boundaryIds: [...boundaryIds],
    segments: [...segments],
  });
}

export function createAiProseSegmentationFingerprintFromState(
  sourceText: string,
  targetBatchSize: number,
  state: Pick<AiProseSegmentationStateLike, 'targetSegmentCount' | 'candidates' | 'boundaryIds' | 'segments'>,
): string {
  return JSON.stringify({
    sourceText,
    targetBatchSize,
    targetSegmentCount: state.targetSegmentCount,
    candidates: state.candidates,
    boundaryIds: [...state.boundaryIds],
    segments: [...state.segments],
  });
}

interface AiProseSegmentationStateLike {
  targetSegmentCount: number;
  candidates: AiProseBoundaryCandidate[];
  boundaryIds: string[];
  segments: AiProseStorySegment[];
}

function padLineNumber(lineNumber: number): string {
  return String(lineNumber).padStart(4, '0');
}

export function splitAiProseLines(sourceText: string): AiProseLine[] {
  const lines: AiProseLine[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  const lineBreakPattern = /\r\n|\r|\n/gu;
  let match: RegExpExecArray | null;

  while ((match = lineBreakPattern.exec(sourceText)) !== null) {
    const contentEnd = match.index;
    const end = match.index + match[0].length;
    lines.push({
      lineNumber,
      start: lineStart,
      contentEnd,
      end,
      text: sourceText.slice(lineStart, contentEnd),
    });
    lineNumber += 1;
    lineStart = end;
  }

  if (lineStart < sourceText.length || lines.length === 0) {
    lines.push({
      lineNumber,
      start: lineStart,
      contentEnd: sourceText.length,
      end: sourceText.length,
      text: sourceText.slice(lineStart),
    });
  }

  return lines;
}

function createLineCandidates(lines: readonly AiProseLine[], sourceLength: number): AiProseBoundaryCandidate[] {
  return lines
    // A line break by itself is not a semantic boundary. Empty lines are
    // retained in the source slices, but exposing every blank line as an
    // Lxxxx candidate makes repeated newlines look like selectable content.
    .filter((line) => line.contentEnd > line.start && line.end < sourceLength)
    .map((line) => ({
      id: `L${padLineNumber(line.lineNumber)}`,
      kind: 'line' as const,
      lineNumber: line.lineNumber,
      position: line.end,
    }));
}

function createLongLineCandidates(
  lines: readonly AiProseLine[],
  existing: readonly AiProseBoundaryCandidate[],
): AiProseBoundaryCandidate[] {
  const candidates = [...existing];
  const existingPositions = new Set(candidates.map((candidate) => candidate.position));

  for (const line of lines) {
    const sentenceEvents = collectAiProsePunctuationEvents(line.text)
      .filter((event) => event.kind === 'sentence' || event.kind === 'ellipsis');
    let sentenceIndex = 0;
    for (const event of sentenceEvents) {
      const position = line.start + event.end;
      if (position <= line.start || position >= line.end || existingPositions.has(position)) continue;
      sentenceIndex += 1;
      candidates.push({
        id: `L${padLineNumber(line.lineNumber)}-S${String(sentenceIndex).padStart(4, '0')}`,
        kind: 'long-line-sentence',
        lineNumber: line.lineNumber,
        position,
      });
      existingPositions.add(position);
    }
  }

  return candidates.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function createAiProseSegmentationPlan(
  sourceText: string,
  targetBatchSize: number,
): AiProseSegmentationPlan {
  if (!Number.isFinite(targetBatchSize) || targetBatchSize <= 0) {
    throw new Error('targetBatchSize must be a positive finite number');
  }

  const lines = splitAiProseLines(sourceText);
  const targetSegmentCount = Math.max(1, Math.round(visibleCharacterCount(sourceText) / targetBatchSize));
  const lineCandidates = createLineCandidates(lines, sourceText.length);
  const hasLongLine = lines.some(
    (line) => visibleCharacterCount(line.text) > targetBatchSize * 1.5,
  );
  const needsLongLineFallback = lineCandidates.length < targetSegmentCount - 1 || hasLongLine;
  const candidates = needsLongLineFallback
    ? createLongLineCandidates(lines, lineCandidates)
    : lineCandidates;

  const numberedSource = lines
    .map((line) => `L${padLineNumber(line.lineNumber)} | ${line.text || '[空行]'}`)
    .join('\n');

  return {
    sourceText,
    targetBatchSize,
    targetSegmentCount,
    lines,
    candidates,
    numberedSource,
  };
}

export function validateAiProseBoundarySelection(
  plan: AiProseSegmentationPlan,
  response: AiProseSegmentationResponse,
): AiProseValidatedSegmentation {
  const candidateById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const selected = response.boundaryIds.map((id) => {
    const candidate = candidateById.get(id);
    if (!candidate) {
      throw new Error(`语义分段返回了不在候选集合中的边界 ID: ${id}`);
    }
    return candidate;
  });

  const minimumSegments = Math.max(1, plan.targetSegmentCount - 1);
  const maximumSegments = plan.targetSegmentCount + 1;
  const minimum = Math.max(0, minimumSegments - 1);
  const maximum = Math.min(maximumSegments - 1, plan.candidates.length);
  if (selected.length < minimum || selected.length > maximum) {
    throw new Error(
      `语义分段边界数量 ${selected.length} 不在允许范围 [${minimum}, ${maximum}] 内`,
    );
  }

  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1].position >= selected[index].position) {
      throw new Error('语义分段边界必须按源正文位置严格递增');
    }
  }

  const segments: AiProseStorySegment[] = [];
  let startOffset = 0;
  let startBoundaryId: string | undefined;
  for (const boundary of selected) {
    segments.push({
      index: segments.length,
      startOffset,
      endOffset: boundary.position,
      sourceText: plan.sourceText.slice(startOffset, boundary.position),
      ...(startBoundaryId ? { startBoundaryId } : {}),
      endBoundaryId: boundary.id,
    });
    startOffset = boundary.position;
    startBoundaryId = boundary.id;
  }
  segments.push({
    index: segments.length,
    startOffset,
    endOffset: plan.sourceText.length,
    sourceText: plan.sourceText.slice(startOffset),
    ...(startBoundaryId ? { startBoundaryId } : {}),
  });

  return {
    boundaryIds: [...response.boundaryIds],
    segments,
  };
}
