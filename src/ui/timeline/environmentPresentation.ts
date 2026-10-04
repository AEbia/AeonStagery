import type { TimelineAction, TimelineScene } from './semanticTimelineTypes';
import { BACKGROUND_LAYER_ID, isEnvironmentAction } from '../../engine/environmentLayerModel';

export interface EnvironmentLayerPresentation {
  layerId: string;
  order: number;
  authoredLabel?: string;
  displayLabel: string;
  shortLabel: string;
  isBackground: boolean;
}

function normalizeLayerId(value: unknown): string {
  const layerId = typeof value === 'string' && value.trim() ? value.trim() : BACKGROUND_LAYER_ID;
  return layerId;
}

export function getEnvironmentActionLayerId(action: TimelineAction): string | null {
  if (!isEnvironmentAction(action)) return null;
  return normalizeLayerId(action.params.layerId);
}

function buildFallbackLayerLabel(layerId: string, order: number): string {
  if (layerId === BACKGROUND_LAYER_ID) return '背景';
  return `环境层 ${Math.max(1, order)}`;
}

export function collectEnvironmentLayerPresentations(sceneData: TimelineScene): Map<string, EnvironmentLayerPresentation> {
  const map = new Map<string, EnvironmentLayerPresentation>();
  map.set(BACKGROUND_LAYER_ID, {
    layerId: BACKGROUND_LAYER_ID,
    order: 0,
    displayLabel: '背景',
    shortLabel: '背景',
    isBackground: true,
  });

  let nextEnvironmentOrder = 1;

  for (const action of sceneData.timeline) {
    const layerId = getEnvironmentActionLayerId(action);
    if (!layerId) continue;

    const current = map.get(layerId);
    const authoredLabel =
      typeof action.params.label === 'string' && action.params.label.trim()
        ? action.params.label.trim()
        : current?.authoredLabel;

    const order = current?.order ?? (layerId === BACKGROUND_LAYER_ID ? 0 : nextEnvironmentOrder++);
    const displayLabel = authoredLabel || buildFallbackLayerLabel(layerId, order);

    map.set(layerId, {
      layerId,
      order,
      authoredLabel,
      displayLabel,
      shortLabel: displayLabel,
      isBackground: layerId === BACKGROUND_LAYER_ID,
    });
  }

  return map;
}

export function getEnvironmentLayerPresentation(
  sceneData: TimelineScene,
  layerId: string,
): EnvironmentLayerPresentation {
  const presentations = collectEnvironmentLayerPresentations(sceneData);
  return presentations.get(layerId) ?? {
    layerId,
    order: layerId === BACKGROUND_LAYER_ID ? 0 : presentations.size,
    authoredLabel: undefined,
    displayLabel: buildFallbackLayerLabel(layerId, presentations.size),
    shortLabel: buildFallbackLayerLabel(layerId, presentations.size),
    isBackground: layerId === BACKGROUND_LAYER_ID,
  };
}

export function getEnvironmentTrackLabel(sceneData: TimelineScene, layerId: string): string {
  return getEnvironmentLayerPresentation(sceneData, layerId).displayLabel;
}

export function getEnvironmentTrackKind(trackId: string): string {
  if (trackId === 'environment') return 'environment';
  if (trackId === `env:${BACKGROUND_LAYER_ID}`) return 'background';
  if (trackId.startsWith('env:')) return 'environment';
  if (trackId.startsWith('char:')) return 'character';
  return trackId;
}
