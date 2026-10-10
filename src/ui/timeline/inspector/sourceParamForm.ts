// Source-param form applicability sets for the inspector (ADR-0022 statement families).
export const SOURCE_PARAM_FORM_SEMANTIC_TYPES = new Set<string>([
  'dialogue',
  'dialogueVisibility',
  'characterPresence',
  'characterTransform',
  'characterPerformance',
  'environmentLayer',
  'audio',
  'graphicLayer',
  'customAnimation',
  'camera',
  'visualStyle',
  'filterAdd',
  'filterChange',
  'filterReset',
  'lighting',
]);

export const SOURCE_PARAM_FORM_CHARACTER_PERFORMANCE_ACTIONS = new Set<string>([
  'playMotion',
  'setExpression',
  'characterLookAt',
  'characterBlink',
  // Raw characterPerformance display actions are ADR-0022 placeholders
  // (uncompiled, empty motion) — the same source-param form lets a human
  // fill the pending motion/expression directly on the block.
  'characterPerformance',
]);
