// Selectable option lists derived for the inspector's target/recipe/filter pickers.
import React from 'react';
import {
  getLensFilterCategory,
  listLensFilterTemplates,
} from '../../../engine/visual-runtime/BuiltInVisualRecipeCatalog';
import { resolveActiveLensFiltersAtTime } from '../../../services/semantic-scene/LensFilterStatementValidator';
import {
  buildSemanticTimelineReadModel,
  type SemanticTimelineReadModelItem,
} from '../semanticTimelineReadModel';
import { listAuthorFacingEnvironmentLayers } from '../environmentAuthoring';
import { getRecipeDisplayLabel } from '../visualPresentation';
import { LENS_FILTER_CATEGORY_LABELS } from './filterSourceParams';
import { listVisualRecipeIds } from './visualStyleLabels';
import type { TimelineAction, TimelineScene } from '../semanticTimelineTypes';

type InspectorSemanticDocument = Parameters<typeof buildSemanticTimelineReadModel>[0];

export function useInspectorOptions(args: {
  sceneData: TimelineScene;
  action: TimelineAction | undefined;
  timelineActions: TimelineAction[];
  semanticDocument: InspectorSemanticDocument;
  semanticItem: SemanticTimelineReadModelItem | undefined;
}) {
  const { sceneData, action, timelineActions, semanticDocument, semanticItem } = args;

  const environmentLayers = React.useMemo(
    () => listAuthorFacingEnvironmentLayers(sceneData),
    [sceneData],
  );
  const visualTargetOptions = React.useMemo(() => {
    const entries = new Map<string, string>();
    entries.set('background', '背景');

    sceneData.meta.characters?.forEach((char) => {
      entries.set(char.id, `${char.name || char.id} (${char.id})`);
    });

    timelineActions.forEach((candidate) => {
      if (candidate.action === 'addTextLayer' && candidate.params.id) {
        entries.set(candidate.params.id, `文本图层 (${candidate.params.id})`);
      }
      if (candidate.action === 'addImage' && candidate.params.id) {
        entries.set(candidate.params.id, `图片图层 (${candidate.params.id})`);
      }
    });

    Object.entries(sceneData.visual?.visualTargets || {}).forEach(([targetId, record]) => {
      if (!entries.has(targetId)) {
        entries.set(targetId, `${record.targetType} (${targetId})`);
      }
    });

    return [...entries.entries()].map(([value, label]) => ({ value, label }));
  }, [sceneData, timelineActions]);
  const characterVisualTargetOptions = React.useMemo(
    () => (sceneData.meta.characters ?? []).map((character) => ({
      value: character.id,
      label: `${character.name || character.id} (${character.id})`,
    })),
    [sceneData.meta.characters],
  );
  const recipeOptions = React.useMemo(() => {
    if (action?.action === 'setCompositeRecipe' || action?.action === 'modulateComposite') {
      const slot = String(action.params.slot || 'integration');
      return listVisualRecipeIds(sceneData.visual, 'object', slot).map((recipeId) => ({
        value: recipeId,
        label: getRecipeDisplayLabel(sceneData.visual, recipeId),
      }));
    }
    return [];
  }, [action, sceneData.visual]);
  const filterTemplateOptions = React.useMemo(() => (
    listLensFilterTemplates(sceneData.visual).map((template) => ({
      value: template.recipeId,
      label: getRecipeDisplayLabel(sceneData.visual, template.recipeId),
      group: LENS_FILTER_CATEGORY_LABELS[template.category] || template.category,
    }))
  ), [sceneData.visual]);
  const activeFilterTemplateOptions = React.useMemo(() => {
    if (action?.semanticType !== 'filterChange') return [];
    const document = semanticDocument;
    if (!document) return filterTemplateOptions;
    const active = resolveActiveLensFiltersAtTime(
      document,
      action.time || 0,
      semanticItem?.statementId,
    );
    const activeIds = new Set(active.map((entry) => entry.recipeId.toLowerCase()));
    const options = filterTemplateOptions.filter((option) => activeIds.has(option.value.toLowerCase()));
    const currentId = typeof action.sourceParams?.fromRecipeId === 'string'
      ? action.sourceParams.fromRecipeId
      : undefined;
    if (currentId && !options.some((option) => option.value.toLowerCase() === currentId.toLowerCase())) {
      const category = getLensFilterCategory(sceneData.visual, currentId);
      options.unshift({
        value: currentId,
        label: getRecipeDisplayLabel(sceneData.visual, currentId),
        group: category ? LENS_FILTER_CATEGORY_LABELS[category] : '当前值',
      });
    }
    return options.length > 0 ? options : filterTemplateOptions;
  }, [action, filterTemplateOptions, sceneData.visual, semanticDocument, semanticItem?.statementId]);

  return {
    environmentLayers,
    visualTargetOptions,
    characterVisualTargetOptions,
    recipeOptions,
    filterTemplateOptions,
    activeFilterTemplateOptions,
  };
}
