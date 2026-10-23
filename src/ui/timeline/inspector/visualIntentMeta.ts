// Lightweight presentation metadata for the primary-visual quick-adjust panel
// and the rim-light target select. Pure move of IIFEs from ActionInspector body.
// NOTE: `actionParams` here is the inspector's computed params object (source
// params in source-param form), exactly as the original closures captured it.

export interface VisualTargetOption { value: string; label: string; disabled?: boolean; }

export function computeRimLightTargetOptions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inspector controls dispatch heterogeneous semantic parameter schemas by runtime field key; the authoring service validates writes instead of imposing one false common payload.
  actionParams: Record<string, any>,
  characterVisualTargetOptions: VisualTargetOption[],
): VisualTargetOption[] {
  const currentTarget = typeof actionParams.target === 'string' ? actionParams.target : '';
  const hasCurrentCharacter = characterVisualTargetOptions.some((option) => option.value === currentTarget);
  const options: VisualTargetOption[] = [...characterVisualTargetOptions];
  if (currentTarget && !hasCurrentCharacter) {
    options.unshift({ value: currentTarget, label: `当前对象 (${currentTarget})`, disabled: true });
  }
  return options.length > 0
    ? options
    : [{ value: '', label: '未选择角色', disabled: true }];
}

export function computePrimaryVisualQuickKeys(
  isPrimaryVisualIntentBlock: boolean,
  actionType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inspector controls dispatch heterogeneous semantic parameter schemas by runtime field key; the authoring service validates writes instead of imposing one false common payload.
  actionParams: Record<string, any>,
): string[] {
  if (!isPrimaryVisualIntentBlock) return [];
  if (actionType === 'setCompositeRecipe' && actionParams.slot === 'grounding') {
    return ['intensity', 'blend', 'contamination', 'warmth'];
  }
  if (actionType === 'setCompositeRecipe' && actionParams.slot === 'integration') {
    return ['intensity', 'brightness', 'color', 'blend', 'contamination', 'warmth'];
  }
  return [];
}

export function computeVisualTargetLabel(
  actionType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inspector controls dispatch heterogeneous semantic parameter schemas by runtime field key; the authoring service validates writes instead of imposing one false common payload.
  actionParams: Record<string, any>,
  visualTargetOptions: VisualTargetOption[],
): string {
  if (actionType !== 'setCompositeRecipe') return '整张画面';
  const targetId = actionParams.targetId;
  if (!targetId || targetId === 'background') return '背景';
  return visualTargetOptions.find((option) => option.value === targetId)?.label || targetId;
}

export function computePrimaryVisualDescription(
  actionType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inspector controls dispatch heterogeneous semantic parameter schemas by runtime field key; the authoring service validates writes instead of imposing one false common payload.
  actionParams: Record<string, any>,
): string {
  if (actionType === 'setCompositeRecipe' && actionParams.slot === 'grounding') {
    return '先按当前背景给角色压一版贴地和明暗关系，再微调强度、延展和柔和。';
  }
  if (actionType === 'setCompositeRecipe' && actionParams.slot === 'integration') {
    return '先按当前背景给角色做一版色彩融合，再微调染色强度、融入度和冷暖。';
  }
  return '';
}
