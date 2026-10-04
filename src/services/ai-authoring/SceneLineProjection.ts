import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type {
  SemanticSceneLineAccessV1,
  SemanticSceneLineV1,
  SemanticSceneLineViewV1,
} from '../../api/types/semantic-scene-patch';
import {
  SemanticSceneLineView,
  type SemanticSceneLineViewOptions,
} from '../semantic-scene/SemanticSceneLineView';

/**
 * Deterministic `[Line:n]` story/scene projection helpers for processor prompts.
 * Labels are Agent addressing numbers (not physical text lines, offsets, or UUIDs).
 * Companions appear only in the compact line view via parentLine — never in story text.
 */

export const LINE_TAG_PATTERN = /^\[Line:(\d+)\]$/;

export function formatLineTag(line: number): string {
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`Line tag requires a positive integer line, got ${String(line)}`);
  }
  return `[Line:${line}]`;
}

export function parseLineTag(tag: string): number | undefined {
  const match = LINE_TAG_PATTERN.exec(tag.trim());
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line >= 1 ? line : undefined;
}

export interface SpeakerTextProjectionUnit {
  readonly line: number;
  readonly time: number;
  readonly speakerId?: string;
  readonly speaker?: string;
  readonly text: string;
}

export interface ProjectStoryTextOptions {
  /** Restrict to these root statement lines (core segment). Defaults to all speaker/text roots. */
  readonly lineFilter?: ReadonlySet<number> | readonly number[];
  /** Separator between tagged blocks. Defaults to a blank line. */
  readonly blockSeparator?: string;
}

/**
 * Build ordered speaker/text projection units with stable line numbers matching
 * SemanticSceneLineView root lines for the same document.
 */
export function projectSpeakerTextUnits(
  document: CurrentSceneDocument,
  options: SemanticSceneLineViewOptions = {},
): readonly SpeakerTextProjectionUnit[] {
  const view = new SemanticSceneLineView(document, options);
  const nameById = new Map(
    (document.meta.characters ?? []).map((character) => [character.id, character.name] as const),
  );
  const units: SpeakerTextProjectionUnit[] = [];

  for (const line of view.lines) {
    if (line.kind !== 'statement' || line.type !== 'dialogue') continue;
    const text = line.params.text;
    if (typeof text !== 'string') continue;
    const speakerId = typeof line.params.speakerId === 'string' ? line.params.speakerId : undefined;
    const explicitSpeaker = typeof line.params.speaker === 'string' ? line.params.speaker : undefined;
    const speaker = explicitSpeaker
      ?? (speakerId !== undefined ? nameById.get(speakerId) : undefined);
    units.push({
      line: line.line,
      time: line.time,
      ...(speakerId !== undefined ? { speakerId } : {}),
      ...(speaker !== undefined ? { speaker } : {}),
      text,
    });
  }

  return units;
}

/**
 * Formal-scene story text: each speaker/text root gets a fixed `[Line:n]` tag block.
 * Multi-line dialogue text stays inside one tag block. Companions are omitted.
 * AI prose draft raw story segments must NOT use this helper (no Line tags).
 */
export function projectFormalSceneStoryText(
  document: CurrentSceneDocument,
  options: ProjectStoryTextOptions & SemanticSceneLineViewOptions = {},
): string {
  const filter = normalizeLineFilter(options.lineFilter);
  const separator = options.blockSeparator ?? '\n\n';
  const units = projectSpeakerTextUnits(document, options);
  const blocks: string[] = [];

  for (const unit of units) {
    if (filter && !filter.has(unit.line)) continue;
    const header = formatLineTag(unit.line);
    const speakerLabel = unit.speaker ?? unit.speakerId;
    const body = speakerLabel
      ? `${speakerLabel}: ${unit.text}`
      : unit.text;
    blocks.push(`${header}\n${body}`);
  }

  return blocks.join(separator);
}

function normalizeLineFilter(
  filter: ProjectStoryTextOptions['lineFilter'],
): ReadonlySet<number> | undefined {
  if (!filter) return undefined;
  if (filter instanceof Set) return filter;
  return new Set(filter);
}

export interface CompactLineViewOptions extends SemanticSceneLineViewOptions {
  /**
   * When true, omit long dialogue `params.text` already carried by story text.
   * Retains line, parentLine, time, type, access, and remaining params needed for patches.
   */
  readonly omitDialogueText?: boolean;
  /** Only include these lines (core + optional read-only context). */
  readonly lineFilter?: ReadonlySet<number> | readonly number[];
  /** Override access for lines outside the writable core set. */
  readonly writableLines?: ReadonlySet<number> | readonly number[];
  /** Families to keep (e.g. cinematic: camera/lighting/visual/filter only). */
  readonly familyFilter?: ReadonlySet<string> | readonly string[];
}

/**
 * Compact model-facing line view. Never includes statement/companion UUIDs.
 * Emitted lines drop UI presentation fields (durationSeconds/category/label/
 * iconKey) that carry no addressing or constraint meaning for the processors.
 */
export function projectCompactLineView(
  document: CurrentSceneDocument,
  options: CompactLineViewOptions = {},
): SemanticSceneLineViewV1 {
  const lineFilter = normalizeLineFilter(options.lineFilter);
  const writable = normalizeLineFilter(options.writableLines);
  const families = options.familyFilter
    ? new Set(
      options.familyFilter instanceof Set
        ? options.familyFilter
        : options.familyFilter,
    )
    : undefined;

  const accessOption = writable
    ? (context: { line: number }): SemanticSceneLineAccessV1 => (
      writable.has(context.line) ? 'writable' : 'read-only'
    )
    : options.access;

  const full = new SemanticSceneLineView(document, {
    registry: options.registry,
    access: accessOption,
  });

  const lines: SemanticSceneLineV1[] = [];
  for (const line of full.lines) {
    if (lineFilter && !lineFilter.has(line.line)) {
      if (line.kind === 'companion' && line.parentLine !== undefined && lineFilter.has(line.parentLine)) {
        // keep companions of included parents unless family-filtered out
      } else {
        continue;
      }
    }
    if (families && !families.has(line.type)) continue;

    lines.push(projectCompactLine(line, {
      ...(options.omitDialogueText ? { omitDialogueText: true } : {}),
    }));
  }

  return {
    lines,
    totalLines: full.totalLines,
  };
}

/**
 * Performance processor line view: full families, optional text omission, access marking.
 */
export function projectPerformanceLineView(
  document: CurrentSceneDocument,
  options: Omit<CompactLineViewOptions, 'familyFilter'> = {},
): SemanticSceneLineViewV1 {
  return projectCompactLineView(document, {
    ...options,
    omitDialogueText: options.omitDialogueText ?? true,
  });
}

export const CINEMATIC_LINE_FAMILIES = [
  'camera',
  'lighting',
  'visualStyle',
  'filterAdd',
  'filterChange',
  'filterReset',
  'dialogue',
  'characterPerformance',
  'characterTransform',
] as const;

/**
 * Project one full line to the compact model-facing shape: presentation fields
 * (durationSeconds/category/label/iconKey) are dropped and dialogue `params.text`
 * may be omitted. Shared by the emission loop and by unit line-view budget
 * accounting so the billed cost always equals the emitted payload.
 */
export function projectCompactLine(
  line: SemanticSceneLineV1,
  options: { readonly omitDialogueText?: boolean } = {},
): SemanticSceneLineV1 {
  let params = line.params;
  if (options.omitDialogueText && line.type === 'dialogue' && 'text' in params) {
    const { text: _omitted, ...rest } = params as Record<string, unknown> & { text?: unknown };
    params = rest;
  }
  return {
    line: line.line,
    ...(line.parentLine !== undefined ? { parentLine: line.parentLine } : {}),
    kind: line.kind,
    time: line.time,
    type: line.type,
    access: line.access,
    params,
  };
}

/**
 * Cinematic processor line view: keep cinematic families plus minimal performance context.
 */
export function projectCinematicLineView(
  document: CurrentSceneDocument,
  options: CompactLineViewOptions = {},
): SemanticSceneLineViewV1 {
  return projectCompactLineView(document, {
    ...options,
    omitDialogueText: options.omitDialogueText ?? true,
    familyFilter: options.familyFilter ?? CINEMATIC_LINE_FAMILIES,
  });
}
