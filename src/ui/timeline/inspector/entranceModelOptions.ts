// Character entrance model options: resolve the active .model3/.moc path and build the picker options.
import type { TimelineAction, TimelineScene } from '../semanticTimelineTypes';

export function resolveActiveModelPath(
  sceneData: TimelineScene,
  timelineActions: readonly TimelineAction[],
  charId: string,
  atTime: number,
): string | undefined {
  let modelPath: string | undefined;
  for (const item of timelineActions) {
    if ((item.time ?? 0) > atTime) break;
    if (item.action !== 'addCharacter' || item.params.id !== charId) continue;
    if (typeof item.params.model === 'string' && item.params.model) {
      modelPath = item.params.model;
    }
  }
  return modelPath ?? sceneData.meta.characters?.find((character) => character.id === charId)?.model;
}

export function buildCharacterEntranceModelOptions(
  character: NonNullable<TimelineScene['meta']['characters']>[number],
): Array<{
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}> {
  const mainModel = character.model?.trim() || '';
  const options: Array<{
    value: string;
    label: string;
    title?: string;
    disabled?: boolean;
  }> = mainModel ? [{
    value: mainModel,
    label: '主模型',
    title: `主模型: ${mainModel}`,
  }] : [];
  const seenModels = new Set<string>(mainModel ? [mainModel] : []);

  for (const [index, variant] of (character.variants ?? []).entries()) {
    const model = variant.model.trim();
    if (!model || seenModels.has(model)) continue;
    seenModels.add(model);
    options.push({
      value: model,
      label: variant.name || `副模型 ${index + 1}`,
      title: `${variant.name || `副模型 ${index + 1}`}: ${model}`,
    });
  }

  return options;
}
