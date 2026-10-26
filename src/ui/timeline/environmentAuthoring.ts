import type { TimelineAction, TimelineScene } from './semanticTimelineTypes';
import { isEnvironmentAction } from '../../engine/environmentLayerModel';
import {
  collectEnvironmentLayerPresentations,
  getEnvironmentActionLayerId,
  type EnvironmentLayerPresentation,
} from './environmentPresentation';

export const UNIFIED_ENVIRONMENT_TRACK_ID = 'environment';

const UNIFIED_ENVIRONMENT_ACTIONS = new Set<string>([
  'setBackground',
  'transformBackground',
  'removeBackground',
  'setEnvironmentLayer',
  'transformEnvironmentLayer',
  'removeEnvironmentLayer',
]);

export interface AuthorFacingEnvironmentLayerOption {
  layerId: string;
  displayLabel: string;
  authoredLabel?: string;
  sourceFile?: string;
  isBackground: boolean;
  order: number;
}

export interface EnvironmentLayerSelection {
  layerId: string;
  label?: string;
  isExisting: boolean;
}

function toAuthorFacingEnvironmentOption(
  presentation: EnvironmentLayerPresentation,
): AuthorFacingEnvironmentLayerOption {
  return {
    layerId: presentation.layerId,
    displayLabel: presentation.displayLabel,
    authoredLabel: presentation.authoredLabel,
    sourceFile: presentation.sourceFile,
    isBackground: presentation.isBackground,
    order: presentation.order,
  };
}

function slugifyLayerName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isUnifiedEnvironmentTrackAction(action: TimelineAction): boolean {
  return UNIFIED_ENVIRONMENT_ACTIONS.has(action.action);
}

export function listAuthorFacingEnvironmentLayers(sceneData: TimelineScene): AuthorFacingEnvironmentLayerOption[] {
  return [...collectEnvironmentLayerPresentations(sceneData).values()]
    .sort((a, b) => a.order - b.order)
    .map(toAuthorFacingEnvironmentOption);
}

export function getAuthorFacingEnvironmentLayerLabel(
  _sceneData: TimelineScene,
  layerId: string,
): string {
  return layerId;
}

export function withAuthorFacingEnvironmentLabel(
  sceneData: TimelineScene,
  action: TimelineAction,
): TimelineAction {
  if (!isEnvironmentAction(action)) {
    return action;
  }

  const layerId = getEnvironmentActionLayerId(action);
  if (!layerId || action.params.label === layerId) return action;

  const displayLabel = getAuthorFacingEnvironmentLayerLabel(sceneData, layerId);
  return {
    ...action,
    params: {
      ...action.params,
      label: displayLabel,
    },
  };
}

export function generateEnvironmentLayerId(sceneData: TimelineScene, label: string): string {
  const presentations = collectEnvironmentLayerPresentations(sceneData);
  const existingIds = new Set(presentations.keys());
  const slug = slugifyLayerName(label);

  if (slug) {
    if (!existingIds.has(slug)) {
      return slug;
    }

    let suffix = 2;
    while (existingIds.has(`${slug}-${suffix}`)) {
      suffix += 1;
    }
    return `${slug}-${suffix}`;
  }

  let fallbackIndex = 1;
  while (existingIds.has(`environment-layer-${fallbackIndex}`)) {
    fallbackIndex += 1;
  }
  return `environment-layer-${fallbackIndex}`;
}

export function resolveEnvironmentLayerSelection(
  sceneData: TimelineScene,
  name: string,
): EnvironmentLayerSelection {
  const trimmedName = name.trim();
  const layers = listAuthorFacingEnvironmentLayers(sceneData);
  const existingLayer = layers.find((layer) => layer.layerId === trimmedName);

  if (existingLayer) {
    return {
      layerId: existingLayer.layerId,
      label: existingLayer.isBackground ? undefined : existingLayer.authoredLabel,
      isExisting: true,
    };
  }

  return {
    layerId: generateEnvironmentLayerId(sceneData, trimmedName),
    label: trimmedName,
    isExisting: false,
  };
}
