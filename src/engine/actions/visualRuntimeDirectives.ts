import type { ActionScheduler } from './types';

export const VISUAL_RUNTIME_DIRECTIVE_ACTIONS = [
  'addLensFilter',
  'changeLensFilter',
  'resetLensFilters',
  'setCompositeRecipe',
  'modulateComposite',
  'resetCompositeRecipe',
] as const;

export type VisualRuntimeDirectiveAction = typeof VISUAL_RUNTIME_DIRECTIVE_ACTIONS[number];

export const scheduleVisualRuntimeDirective: ActionScheduler = () => {};

export const visualRuntimeDirectiveSchedulers = Object.fromEntries(
  VISUAL_RUNTIME_DIRECTIVE_ACTIONS.map((action) => [action, scheduleVisualRuntimeDirective]),
) as Record<VisualRuntimeDirectiveAction, ActionScheduler>;
