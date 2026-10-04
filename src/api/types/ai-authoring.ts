import type { MarkerRole } from './scene-common';

export const AI_SCRIPT_SEGMENT_SCHEMA_VERSION = 1 as const;

export const AI_RHYTHM_PACES = ['snap', 'normal', 'slow', 'hold'] as const;
export type AiRhythmPace = typeof AI_RHYTHM_PACES[number];

export const AI_POSITION_PRESETS = ['left', 'leftCenter', 'center', 'rightCenter', 'right'] as const;
export type AiPositionPreset = typeof AI_POSITION_PRESETS[number];

export const AI_SCRIPT_STEP_KINDS = ['enter', 'dialogue', 'pause', 'exit', 'marker'] as const;
export type AiScriptStepKind = typeof AI_SCRIPT_STEP_KINDS[number];

export interface AiScriptStep {
  kind: AiScriptStepKind;
  characterId: string | null;
  text: string | null;
  pace: AiRhythmPace | null;
  position: AiPositionPreset | null;
  label: string | null;
  markerRole: MarkerRole | null;
}

export interface AiScriptSegmentPlan {
  version: typeof AI_SCRIPT_SEGMENT_SCHEMA_VERSION;
  title: string;
  summary: string;
  steps: AiScriptStep[];
  unresolvedNames: string[];
  notes: string[];
}

const nullableStringEnum = (values: readonly string[]) => ({
  anyOf: [
    { type: 'string', enum: values },
    { type: 'null' },
  ],
});

export const AI_SCRIPT_SEGMENT_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'title', 'summary', 'steps', 'unresolvedNames', 'notes'],
  properties: {
    version: { type: 'number', enum: [AI_SCRIPT_SEGMENT_SCHEMA_VERSION] },
    title: { type: 'string' },
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'characterId', 'text', 'pace', 'position', 'label', 'markerRole'],
        properties: {
          kind: { type: 'string', enum: AI_SCRIPT_STEP_KINDS },
          characterId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          pace: nullableStringEnum(AI_RHYTHM_PACES),
          position: nullableStringEnum(AI_POSITION_PRESETS),
          label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          markerRole: nullableStringEnum(['note', 'beat', 'lens-boundary']),
        },
      },
    },
    unresolvedNames: {
      type: 'array',
      items: { type: 'string' },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

export function isAiScriptSegmentPlan(value: unknown): value is AiScriptSegmentPlan {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AiScriptSegmentPlan>;
  return candidate.version === AI_SCRIPT_SEGMENT_SCHEMA_VERSION &&
    typeof candidate.title === 'string' &&
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.steps) &&
    Array.isArray(candidate.unresolvedNames) &&
    Array.isArray(candidate.notes);
}
