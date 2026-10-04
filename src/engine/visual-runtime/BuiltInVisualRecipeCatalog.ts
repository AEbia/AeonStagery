import type {
  CompositeRecipePayload,
  CompositeSlot,
  LensAtmosphereRecipePayload,
  LensGradeRecipePayload,
  LensOpticsRecipePayload,
  LensStyleSlot,
  LensTextureRecipePayload,
  RecipeId,
  SceneVisualBlock,
  StyleRecipeRecord,
  VisualColorOverlayPayload,
} from '../../api/types/visual';

export type BuiltInLensGradeRecipe = LensGradeRecipePayload;
export type BuiltInLensOpticsRecipe = LensOpticsRecipePayload;
export type BuiltInLensAtmosphereRecipe = LensAtmosphereRecipePayload;
export type BuiltInLensTextureRecipe = LensTextureRecipePayload;
export type BuiltInCompositeRecipe = CompositeRecipePayload;

export type LensFilterCategory = LensStyleSlot;

/** @deprecated Lens filter templates are retained for historical scene compatibility. */
export interface LensFilterTemplate {
  readonly recipeId: RecipeId;
  readonly category: LensFilterCategory;
  readonly label?: string;
}

const LENS_GRADE_RECIPES: Record<string, BuiltInLensGradeRecipe> = {
  'builtin:default-grade': {},
  'builtin:cinematic-grade': { contrast: 1.14, saturation: 1.05, brightness: 0.98 },
  'builtin:cinematic-cold': { contrast: 1.14, saturation: 1.02, brightness: 0.97, red: 0.95, green: 0.98, blue: 1.08 },
  'builtin:grade-a': { contrast: 1.05, saturation: 1.02 },
  'builtin:grade-b': { contrast: 1.08, saturation: 0.98, blue: 1.03 },
};

const LENS_OPTICS_RECIPES: Record<string, BuiltInLensOpticsRecipe> = {
  'builtin:soft-bloom-rgb': { bloomScale: 0.1, bloomThreshold: 0.74, rgbSplit: 0.26 },
};

const LENS_ATMOSPHERE_RECIPES: Record<string, BuiltInLensAtmosphereRecipe> = {
  'builtin:haze-godray': {
    bloomScale: 0.07,
    bloomThreshold: 0.74,
    godrayAngle: 28,
    godrayGain: 0.04,
    overlays: [
      { color: '#d7e6f5', intensity: 0.025, mode: 'screen' },
    ],
  },
};

const LENS_TEXTURE_RECIPES: Record<string, BuiltInLensTextureRecipe> = {
  'builtin:film-grain': {
    contrast: 1.08,
    saturation: 0.94,
    overlays: [
      { color: '#120f0c', intensity: 0.05, mode: 'multiply' },
    ],
  },
};

const COMPOSITE_RECIPES: Partial<Record<CompositeSlot, Record<string, BuiltInCompositeRecipe>>> = {
  grounding: {
    'builtin:ground-shadow-soft': {
      shadow: {
        alpha: 0.24,
        blur: 14,
        color: 0x202734,
        distance: 12,
        rotation: 90,
      },
    },
  },
  integration: {
    'builtin:default-integration': {
      adjustment: {
        brightness: 0.985,
        contrast: 0.99,
        saturation: 0.98,
      },
    },
    'builtin:integration-soft': {
      adjustment: {
        brightness: 0.985,
        contrast: 0.99,
        saturation: 0.98,
      },
    },
    'builtin:integration-soft-warm': {
      adjustment: {
        brightness: 0.98,
        contrast: 0.99,
        saturation: 0.97,
        red: 1.07,
        green: 1.01,
        blue: 0.96,
      },
    },
    'builtin:integration-soft-cool': {
      adjustment: {
        brightness: 0.98,
        contrast: 0.99,
        saturation: 0.97,
        red: 0.97,
        green: 0.99,
        blue: 1.07,
      },
    },
  },
  accent: {
    'builtin:accent-pop': {
      adjustment: {
        brightness: 1.08,
        contrast: 1.12,
        saturation: 1.1,
      },
    },
  },
  distortion: {
    'builtin:rgb-blur': {
      blur: 2.2,
      rgbSplit: { x: 1.15, y: 0.45 },
    },
  },
};

export function listBuiltInLensRecipeIds(slot: LensStyleSlot): string[] {
  switch (slot) {
    case 'grade':
      return Object.keys(LENS_GRADE_RECIPES);
    case 'optics':
      return Object.keys(LENS_OPTICS_RECIPES);
    case 'atmosphere':
      return Object.keys(LENS_ATMOSPHERE_RECIPES);
    case 'texture':
      return Object.keys(LENS_TEXTURE_RECIPES);
    default:
      return [];
  }
}

/** @deprecated Resolve historical lens filter categories; new authoring should not call this. */
export function getLensFilterCategory(
  scene: SceneVisualBlock | undefined,
  recipeId?: RecipeId,
): LensFilterCategory | null {
  if (!recipeId) return null;

  const sceneRecord = scene?.recipeOverlay?.[recipeId];
  if (sceneRecord?.stack === 'lens') return sceneRecord.slot;

  for (const slot of ['grade', 'optics', 'atmosphere', 'texture'] as const) {
    if (getBuiltInLensRecipe(slot, recipeId)) return slot;
  }
  return null;
}

/** @deprecated Lens filter templates are no longer exposed as a new UI entry. */
export function listLensFilterTemplates(scene?: SceneVisualBlock): LensFilterTemplate[] {
  const templates = new Map<string, LensFilterTemplate>();
  for (const category of ['grade', 'optics', 'atmosphere', 'texture'] as const) {
    for (const recipeId of listBuiltInLensRecipeIds(category)) {
      templates.set(recipeId, { recipeId, category });
    }
    for (const recipeId of listSceneRecipeIds(scene, 'lens', category)) {
      templates.set(recipeId, {
        recipeId,
        category,
        label: scene?.recipeOverlay?.[recipeId]?.label,
      });
    }
  }
  return [...templates.values()].sort((left, right) => (
    left.category.localeCompare(right.category) || left.recipeId.localeCompare(right.recipeId)
  ));
}

export function listBuiltInCompositeRecipeIds(slot: CompositeSlot): string[] {
  return Object.keys(COMPOSITE_RECIPES[slot] || {});
}

function cloneOverlayList(overlays?: VisualColorOverlayPayload[]): VisualColorOverlayPayload[] | undefined {
  return overlays?.map((entry) => ({ ...entry }));
}

function mergeRecipePayload<T extends Record<string, any>>(base: T | null, overlay: T | undefined): T | null {
  if (!base && !overlay) return null;
  const next: Record<string, any> = { ...(base || {}) };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      next[key] &&
      typeof next[key] === 'object' &&
      !Array.isArray(next[key])
    ) {
      next[key] = { ...next[key], ...value };
    } else if (Array.isArray(value)) {
      next[key] = value.map((entry) => (typeof entry === 'object' ? { ...entry } : entry));
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function getSceneRecipeRecord(scene: SceneVisualBlock | undefined, recipeId?: RecipeId): StyleRecipeRecord | null {
  if (!scene || !recipeId) return null;
  return scene.recipeOverlay?.[recipeId] ?? null;
}

function resolveSceneRecipePayload<T extends Record<string, any>>(
  scene: SceneVisualBlock | undefined,
  stack: 'lens' | 'composite',
  slot: string,
  recipeId?: RecipeId,
  seen: Set<string> = new Set(),
): T | null {
  if (!scene || !recipeId || seen.has(recipeId)) return null;
  seen.add(recipeId);

  const record = getSceneRecipeRecord(scene, recipeId);
  if (!record || record.stack !== stack || record.slot !== slot) return null;

  const inherited = record.extendsRecipeId?.startsWith('scene:')
    ? resolveSceneRecipePayload<T>(scene, stack, slot, record.extendsRecipeId, seen)
    : stack === 'lens'
      ? getBuiltInLensRecipe(slot as LensStyleSlot, record.extendsRecipeId) as T | null
      : getBuiltInCompositeRecipe(slot as CompositeSlot, record.extendsRecipeId) as T | null;

  return mergeRecipePayload<T>(inherited, record.payload as T | undefined);
}

export function listSceneRecipeIds(
  scene: SceneVisualBlock | undefined,
  stack: 'lens' | 'composite',
  slot: string,
): string[] {
  return Object.entries(scene?.recipeOverlay || {})
    .filter(([, record]) => record.stack === stack && record.slot === slot)
    .map(([recipeId]) => recipeId)
    .sort();
}

export function getBuiltInLensRecipe(slot: LensStyleSlot, recipeId?: string):
  | BuiltInLensGradeRecipe
  | BuiltInLensOpticsRecipe
  | BuiltInLensAtmosphereRecipe
  | BuiltInLensTextureRecipe
  | null {
  if (!recipeId) return null;
  const key = recipeId.toLowerCase();
  switch (slot) {
    case 'grade':
      return LENS_GRADE_RECIPES[key] ?? null;
    case 'optics':
      return LENS_OPTICS_RECIPES[key] ?? null;
    case 'atmosphere':
      return LENS_ATMOSPHERE_RECIPES[key] ?? null;
    case 'texture':
      return LENS_TEXTURE_RECIPES[key] ?? null;
    default:
      return null;
  }
}

export function getBuiltInCompositeRecipe(slot: CompositeSlot, recipeId?: string): BuiltInCompositeRecipe | null {
  if (!recipeId) return null;
  return COMPOSITE_RECIPES[slot]?.[recipeId.toLowerCase()] ?? null;
}

export function resolveLensRecipePayload(
  scene: SceneVisualBlock | undefined,
  slot: LensStyleSlot,
  recipeId?: RecipeId,
):
  | BuiltInLensGradeRecipe
  | BuiltInLensOpticsRecipe
  | BuiltInLensAtmosphereRecipe
  | BuiltInLensTextureRecipe
  | null {
  if (!recipeId) return null;
  if (recipeId.startsWith('scene:')) {
    const resolved = resolveSceneRecipePayload(scene, 'lens', slot, recipeId);
    if (slot === 'atmosphere' && resolved?.overlays) {
      resolved.overlays = cloneOverlayList(resolved.overlays);
    }
    if (slot === 'texture' && resolved?.overlays) {
      resolved.overlays = cloneOverlayList(resolved.overlays);
    }
    return resolved;
  }
  return getBuiltInLensRecipe(slot, recipeId);
}

export function resolveCompositeRecipePayload(
  scene: SceneVisualBlock | undefined,
  slot: CompositeSlot,
  recipeId?: RecipeId,
): BuiltInCompositeRecipe | null {
  if (!recipeId) return null;
  if (recipeId.startsWith('scene:')) {
    return resolveSceneRecipePayload(scene, 'composite', slot, recipeId);
  }
  return getBuiltInCompositeRecipe(slot, recipeId);
}
