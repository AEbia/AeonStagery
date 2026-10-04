import {
  AI_PROSE_BLOCK_TARGET_VISIBLE_CHARACTERS,
  DEFAULT_SCRIPT_READING_SPEED,
} from '../../api/types/ai-prose-authoring';

export interface AiProseGraphemeSlice {
  value: string;
  start: number;
  end: number;
}

export interface AiProseTimingOptions {
  scriptReadingSpeed?: number;
}

export interface AiProsePunctuationEvent {
  start: number;
  end: number;
  weight: number;
  kind: 'secondary' | 'sentence' | 'ellipsis';
}

const LINE_BREAK_OR_TAB = /[\r\n\t\u000b\f\u0085\u2028\u2029]/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const PUNCTUATION = /^\p{P}+$/u;
const CLOSING_MARKS = /^[\p{Pe}\p{Pf}"'“”‘’「」『』《》〈〉【】〔〕［］｛｝()\[\]{}]+$/u;
const SENTENCE_MARKS = new Set(['。', '.', '!', '?', '！', '？']);
const SECONDARY_MARKS = new Set(['，', ',', '、', '；', ';', '：', ':']);

function getSegmenter(): { segment(value: string): Iterable<{ segment: string; index: number }> } | null {
  const IntlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
      segment(value: string): Iterable<{ segment: string; index: number }>;
    };
  };
  return IntlWithSegmenter.Segmenter
    ? new IntlWithSegmenter.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
}

export function segmentAiProseGraphemes(value: string): AiProseGraphemeSlice[] {
  const segmenter = getSegmenter();
  if (segmenter) {
    const segments = [...segmenter.segment(value)];
    return segments.map((item, index) => ({
      value: item.segment,
      start: item.index,
      end: index + 1 < segments.length ? segments[index + 1].index : value.length,
    }));
  }

  return segmentGraphemesWithoutIntl(value);
}

function segmentGraphemesWithoutIntl(value: string): AiProseGraphemeSlice[] {
  const graphemes: AiProseGraphemeSlice[] = [];
  let offset = 0;
  while (offset < value.length) {
    const start = offset;
    const firstCodePoint = value.codePointAt(offset)!;
    offset = advanceCodePoint(value, offset);

    if (isRegionalIndicator(firstCodePoint)
      && offset < value.length
      && isRegionalIndicator(value.codePointAt(offset)!)) {
      offset = advanceCodePoint(value, offset);
    }

    offset = consumeGraphemeExtensions(value, offset);
    while (offset < value.length && value.codePointAt(offset) === 0x200d) {
      offset = advanceCodePoint(value, offset);
      if (offset >= value.length) break;
      offset = advanceCodePoint(value, offset);
      offset = consumeGraphemeExtensions(value, offset);
    }

    graphemes.push({ value: value.slice(start, offset), start, end: offset });
  }
  return graphemes;
}

function advanceCodePoint(value: string, offset: number): number {
  const codePoint = value.codePointAt(offset)!;
  return offset + (codePoint > 0xffff ? 2 : 1);
}

function consumeGraphemeExtensions(value: string, offset: number): number {
  while (offset < value.length && isGraphemeExtension(value.codePointAt(offset)!)) {
    offset = advanceCodePoint(value, offset);
  }
  return offset;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isGraphemeExtension(codePoint: number): boolean {
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  ) return true;
  return /^\p{M}$/u.test(String.fromCodePoint(codePoint));
}

function isVisibleGrapheme(value: string): boolean {
  if (!value || LINE_BREAK_OR_TAB.test(value)) return false;
  return !Array.from(value).every((character) => CONTROL_OR_FORMAT.test(character));
}

export function visibleCharacterCount(value: string): number {
  return segmentAiProseGraphemes(value).reduce(
    (count, grapheme) => count + (isVisibleGrapheme(grapheme.value) ? 1 : 0),
    0,
  );
}

function isSpokenGrapheme(value: string): boolean {
  if (!isVisibleGrapheme(value) || /^\s+$/u.test(value)) return false;
  return !Array.from(value).every((character) => PUNCTUATION.test(character));
}

export function spokenCharacterCount(value: string): number {
  return segmentAiProseGraphemes(value).reduce(
    (count, grapheme) => count + (isSpokenGrapheme(grapheme.value) ? 1 : 0),
    0,
  );
}

function isEllipsisStart(graphemes: readonly AiProseGraphemeSlice[], index: number): boolean {
  const current = graphemes[index]?.value;
  if (current === '…') return true;
  if (current !== '.') return false;
  return graphemes[index + 1]?.value === '.';
}

function isEllipsisPart(value: string): boolean {
  return value === '…' || value === '.';
}

function punctuationKind(value: string): AiProsePunctuationEvent['kind'] | null {
  if (value === '…') return 'ellipsis';
  if (SENTENCE_MARKS.has(value)) return 'sentence';
  if (SECONDARY_MARKS.has(value)) return 'secondary';
  return null;
}

function punctuationWeight(value: string, kind: AiProsePunctuationEvent['kind']): number {
  if (kind === 'ellipsis') return 0.45;
  if (kind === 'sentence') return 0.35;
  if (value === '；' || value === ';' || value === '：' || value === ':') return 0.25;
  return 0.15;
}

export function collectAiProsePunctuationEvents(value: string): AiProsePunctuationEvent[] {
  const graphemes = segmentAiProseGraphemes(value);
  const events: AiProsePunctuationEvent[] = [];

  for (let index = 0; index < graphemes.length; index += 1) {
    const current = graphemes[index];
    if (isEllipsisStart(graphemes, index)) {
      let endIndex = index;
      while (endIndex + 1 < graphemes.length && isEllipsisPart(graphemes[endIndex + 1].value)) {
        endIndex += 1;
      }
      events.push({
        start: current.start,
        end: graphemes[endIndex].end,
        kind: 'ellipsis',
        weight: punctuationWeight(current.value, 'ellipsis'),
      });
      index = endIndex;
      continue;
    }

    const kind = punctuationKind(current.value);
    if (kind) {
      events.push({
        start: current.start,
        end: current.end,
        kind,
        weight: punctuationWeight(current.value, kind),
      });
    }
  }

  return events;
}

function includeClosingMarks(value: string, end: number): number {
  const graphemes = segmentAiProseGraphemes(value);
  const startIndex = graphemes.findIndex((grapheme) => grapheme.start >= end);
  if (startIndex === -1) return end;
  let index = startIndex;
  while (index < graphemes.length && CLOSING_MARKS.test(graphemes[index].value)) {
    index += 1;
  }
  return index === startIndex ? end : graphemes[index - 1].end;
}

function visibleCountThrough(value: string, end: number): number {
  return visibleCharacterCount(value.slice(0, end));
}

function chooseSplitEnd(value: string, target: number): number | null {
  const events = collectAiProsePunctuationEvents(value);
  if (events.length === 0) return null;

  const withinTarget = events.filter((event) => visibleCountThrough(value, event.end) <= target);
  const sentence = withinTarget.filter((event) => event.kind === 'sentence' || event.kind === 'ellipsis');
  const secondary = withinTarget.filter((event) => event.kind === 'secondary');
  const chosen = sentence.at(-1) ?? secondary.at(-1) ?? events.find(
    (event) => visibleCountThrough(value, event.end) > target,
  );
  if (!chosen) return null;

  const end = includeClosingMarks(value, chosen.end);
  return end > 0 && end < value.length ? end : null;
}

export function splitAiProseStatementText(
  value: string,
  targetVisibleCharacters = AI_PROSE_BLOCK_TARGET_VISIBLE_CHARACTERS,
): string[] {
  if (!Number.isFinite(targetVisibleCharacters) || targetVisibleCharacters <= 0) {
    throw new Error('targetVisibleCharacters must be a positive finite number');
  }
  const chunks: string[] = [];
  let remaining = value;

  while (remaining.length > 0) {
    if (visibleCharacterCount(remaining) <= targetVisibleCharacters) {
      chunks.push(remaining);
      break;
    }
    const splitEnd = chooseSplitEnd(remaining, targetVisibleCharacters);
    if (splitEnd === null) {
      chunks.push(remaining);
      break;
    }
    chunks.push(remaining.slice(0, splitEnd));
    remaining = remaining.slice(splitEnd);
  }

  return chunks;
}

function isIgnorableAfterPunctuation(value: string): boolean {
  if (CLOSING_MARKS.test(value)) return true;
  return /^\s+$/u.test(value) || Array.from(value).every((character) => CONTROL_OR_FORMAT.test(character));
}

function findTerminalEvent(events: readonly AiProsePunctuationEvent[], value: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const after = value.slice(events[index].end);
    if (after.length === 0 || segmentAiProseGraphemes(after).every((grapheme) => isIgnorableAfterPunctuation(grapheme.value))) {
      return index;
    }
  }
  return -1;
}

export function internalPunctuationPause(value: string): number {
  const events = collectAiProsePunctuationEvents(value);
  const terminalIndex = findTerminalEvent(events, value);
  return events.reduce((total, event, index) => (
    index === terminalIndex ? total : total + event.weight
  ), 0);
}

export function estimateAiProseDuration(
  value: string,
  options: AiProseTimingOptions = {},
): number {
  const scriptReadingSpeed = options.scriptReadingSpeed ?? DEFAULT_SCRIPT_READING_SPEED;
  if (!Number.isFinite(scriptReadingSpeed) || scriptReadingSpeed <= 0) {
    throw new Error('scriptReadingSpeed must be a positive finite number');
  }
  const duration = Math.max(
    0.9,
    spokenCharacterCount(value) / scriptReadingSpeed + 0.35 + internalPunctuationPause(value),
  );
  return Math.round(duration * 10) / 10;
}
