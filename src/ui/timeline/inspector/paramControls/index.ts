// Ordered dispatch chain for one inspector param key. The order replicates the
// original if-chain inside ActionInspector.renderParam exactly; each resolver
// returns undefined to fall through, null to hide the key, or a control node.
import { resolveCatalogBooleanParam, resolveCatalogNumberParam } from './catalogFields';
import { resolveCharacterBindParam } from './characters';
import { resolveColorAndOverrideParam } from './colors';
import { resolveCompoundParam } from './compounds';
import { resolveCompositeVisualParam } from './compositeVisual';
import { resolveEnvironmentParam } from './environment';
import { resolveFallbackParam } from './fallback';
import { resolveLightingLensParam } from './lightingLens';
import { resolveMiscSelectParam } from './miscSelects';
import { resolveMotionPickerParam } from './motionPickers';
import { resolveResourceParam } from './resources';
import type { InspectorParamContext, ParamControlBase, ParamControlResolver } from './context';

export type { InspectorParamContext, ParamControlBase, ParamControlResolver } from './context';
export { resolveGuardedParam } from './guards';

const resolvers: readonly ParamControlResolver[] = [
  resolveCompoundParam,
  resolveColorAndOverrideParam,
  resolveCatalogBooleanParam,
  resolveCharacterBindParam,
  resolveEnvironmentParam,
  resolveCompositeVisualParam,
  resolveLightingLensParam,
  resolveCatalogNumberParam,
  resolveMotionPickerParam,
  resolveMiscSelectParam,
  resolveResourceParam,
  resolveFallbackParam,
];

export function resolveParamControl(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | null {
  for (const resolve of resolvers) {
    const out = resolve(ctx, key, base);
    if (out !== undefined) return out;
  }
  return null;
}
