// Pure grouping rules for inspector param keys (General / Transform / State sections).
export function getGroupForParam(at: string, k: string): string {
  const transformKeys = ['position', 'target', 'zoom', 'scale', 'rotation', 'opacity', 'z', 'offsetX', 'offsetY', 'ease', 'delay', 'smoothing', 'x', 'y', 'radius', 'offset'];
  const stateKeys = ['focusX', 'focusY', 'targetPart', 'interval', 'enterDuration', 'exitDuration', 'intensity', 'frequency', 'enabled', 'decay', 'loop', 'yoyo', 'flipX', 'layoutMode', 'tileScaleX', 'tileScaleY', 'tileOffsetX', 'tileOffsetY', 'rgbSplit'];
  const visualKeys = ['slot', 'recipeId', 'targetId', 'mode', 'brightness', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination', 'color', 'colorStops', 'colorBlendMode', 'semanticOverride', 'advancedOverride'];

  if (k === 'durationSeconds') return getGroupForParam(at, 'duration');
  if (k === 'target' && (at === 'setPostProcessing' || at === 'resetPostProcessing')) return 'General';
  if (k === 'duration' && ['setEnvironmentLayer', 'removeEnvironmentLayer'].includes(at)) return 'General';
  if (k === 'duration') {
    if (at === 'modulateComposite') return 'State';
    if (['transformCharacter', 'cameraPath', 'cameraShake', 'cameraReset', 'setBlur', 'setLighting', 'addCharacter', 'setEnvironmentLayer', 'transformEnvironmentLayer'].includes(at)) return 'Transform';
    return 'General';
  }
  if (k === 'layerId' || k === 'label' || k === 'image' || k === 'transition') return 'General';
  if (k === 'position' && at === 'dialogue') return 'General';
  if (visualKeys.includes(k)) return ['intensity', 'brightness', 'warmth', 'bloom', 'blend', 'contamination'].includes(k) ? 'State' : 'General';
  if (transformKeys.includes(k)) return 'Transform';
  if (stateKeys.includes(k)) return 'State';
  return 'General';
}
