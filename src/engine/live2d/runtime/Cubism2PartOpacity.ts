/**
 * Cubism 2.1 stores opacity on part contexts, exposed by get/setPartsOpacity.
 * The private _$pb array contains PARAMETER IDS, never opacity values. Writing
 * snapshots there destroys name-to-index lookup while leaving parts unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
function exposedOpacities(internalModel: any): number[] | Float32Array | undefined {
  const core = internalModel?.coreModel;
  const candidates = [
    internalModel?.partOpacities,
    internalModel?.getPartOpacities?.(),
    core?.getPartOpacities?.(),
    core?.partsOpacity,
  ];
  return candidates.find(values => values && typeof values.length === 'number'
    && Array.from(values).every(value => typeof value === 'number'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
function partCount(core: any): number | undefined {
  const context = core?.getModelContext?.() ?? core?._$5S;
  return context?._$Hr?.length;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
export function readPartOpacities(internalModel: any): ArrayLike<number> | null {
  const exposed = exposedOpacities(internalModel);
  if (exposed) return exposed;
  const core = internalModel?.coreModel;
  const count = partCount(core);
  if (count === undefined || typeof core?.getPartsOpacity !== 'function') return null;
  return Float32Array.from({ length: count }, (_, index) => core.getPartsOpacity(index));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
export function writePartOpacities(internalModel: any, values: ArrayLike<number>): boolean {
  const exposed = exposedOpacities(internalModel);
  if (exposed) {
    const length = Math.min(exposed.length, values.length);
    for (let i = 0; i < length; i++) exposed[i] = values[i];
    return length > 0;
  }
  const core = internalModel?.coreModel;
  const count = partCount(core);
  if (count === undefined || typeof core?.setPartsOpacity !== 'function') return false;
  const length = Math.min(count, values.length);
  for (let i = 0; i < length; i++) core.setPartsOpacity(i, values[i]);
  return length > 0;
}
