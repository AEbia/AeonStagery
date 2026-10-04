import type { RuntimeActionType } from '../../api/types/semantic-scene';
import type { SceneVisualBlock } from '../../api/types/visual';

interface VisualSyncScene {
  readonly visual?: Readonly<SceneVisualBlock>;
  readonly actions?: readonly VisualSyncAction[];
  readonly timeline?: readonly VisualSyncAction[];
}

interface VisualSyncAction {
  readonly action: RuntimeActionType | string;
}

const TIMELINE_VISUAL_ACTIONS = new Set<RuntimeActionType>([
  'addLensFilter',
  'changeLensFilter',
  'resetLensFilters',
  'setCompositeRecipe',
  'modulateComposite',
  'resetCompositeRecipe',
]);

export function sceneRequiresVisualSync(scene: VisualSyncScene | null): boolean {
  if (!scene) return false;
  if (scene.visual) return true;
  const timeline = scene.actions ?? scene.timeline ?? [];
  return timeline.some((action) => TIMELINE_VISUAL_ACTIONS.has(action.action as RuntimeActionType));
}
