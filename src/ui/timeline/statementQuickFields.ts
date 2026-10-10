import type { SceneVisualBlock } from '../../api/types/visual';
import type { SemanticTimelineReadModelItem } from './semanticTimelineReadModel';
import { getSemanticInspectorFields } from './semanticInspectorFieldCatalog';

const quickKeys = new Set([
  'id', 'target', 'layerId', 'speakerId', 'text', 'file', 'model', 'recipeId',
  'position', 'to', 'offset', 'screenTarget', 'scale', 'rotation', 'opacity',
  'zoom', 'intensity', 'durationSeconds', 'volume', 'fadeOut', 'motion', 'expression',
]);
export const quickCoordinateKeys = new Set(['position', 'to', 'offset', 'screenTarget']);

/** The fields actually rendered by the row, also used to omit duplicate detail controls. */
export function getStatementQuickFields(item: SemanticTimelineReadModelItem, sceneVisual?: SceneVisualBlock) {
  const source = item.source.params as Record<string, unknown>;
  return getSemanticInspectorFields(item.source.type, source, sceneVisual).filter((field) => {
    if (!quickKeys.has(field.key)) return false;
    // Keep visual targets and recipes in their dedicated detail selectors.
    if (item.source.type === 'visualStyle' && ['target', 'recipeId'].includes(field.key)) return false;
    // Integration overrides replace the top-level values; their editor remains in details.
    if (item.source.type === 'visualStyle' && source.slot === 'integration'
      && field.key === 'intensity' && source.semanticOverride && typeof source.semanticOverride === 'object') return false;
    if (quickCoordinateKeys.has(field.key) || ['text', 'zoom', 'motion'].includes(field.key)) return true;
    const value = source[field.key] === undefined ? field.defaultValue?.(source, sceneVisual) : source[field.key];
    return value === undefined || typeof value === 'string' || typeof value === 'number';
  });
}
