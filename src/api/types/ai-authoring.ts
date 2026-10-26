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
