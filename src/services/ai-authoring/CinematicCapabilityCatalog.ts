import type { CurrentSceneDocument, StatementFamily } from '../../api/types/semantic-scene';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';

/**
 * Cinematic families observed for segment-start state.
 * Includes historical filter families so existing visual state is visible as read-only context.
 */
const CINEMATIC_STATE_FAMILIES: readonly StatementFamily[] = [
  'camera',
  'lighting',
  'visualStyle',
  'filterAdd',
  'filterChange',
  'filterReset',
];

export interface CinematicExistingStateLineV1 {
  readonly line: number;
  readonly time: number;
  readonly type: StatementFamily;
  readonly params: Readonly<Record<string, unknown>>;
  readonly parentLine?: number;
}

/**
 * Read-only cinematic capability catalog for one processing unit (ADR-0022).
 * Host-built from registry/scene/resources; enters unit input fingerprint.
 */
export interface CinematicCapabilityCatalogV1 {
  readonly version: 1;
  readonly characterTargets: readonly string[];
  readonly characterNames: Readonly<Record<string, string>>;
  /** Existing cinematic lines at/before unit start (segment-leading state). */
  readonly segmentStartState: readonly CinematicExistingStateLineV1[];
  readonly cameraModes: readonly string[];
  readonly cameraPresets: readonly string[];
  readonly lightingPresets: readonly string[];
  readonly visualRecipeIds: readonly string[];
  /** @deprecated Historical capability retained as optional for backwards compatibility; no longer emitted. */
  readonly filterRecipeIds?: readonly string[];
  readonly notes?: readonly string[];
}

export interface CinematicCapabilityPort {
  readonly cameraModes?: readonly string[];
  readonly cameraPresets?: readonly string[];
  readonly lightingPresets?: readonly string[];
  readonly visualRecipeIds?: readonly string[];
  /** @deprecated Historical capability input ignored; filters are deprecated. */
  readonly filterRecipeIds?: readonly string[];
}

export interface BuildCinematicCapabilityCatalogInput {
  readonly document: CurrentSceneDocument;
  /** Absolute scene time at the start of this unit's first group. */
  readonly unitStartTime: number;
  readonly capabilities?: CinematicCapabilityPort;
  readonly extraNotes?: readonly string[];
}

const DEFAULT_CAMERA_MODES = [
  'focus',
  'move',
  'follow',
  'path',
  'shake',
  'hitchcock',
  'reset',
] as const;

/**
 * Minimal host catalog: character targets + segment-start cinematic state.
 * Lighting presets / recipe IDs can be expanded when resource ports are wired.
 */
export function buildCinematicCapabilityCatalog(
  input: BuildCinematicCapabilityCatalogInput,
): CinematicCapabilityCatalogV1 {
  const characters = input.document.meta.characters ?? [];
  const characterTargets = characters.map((character) => character.id);
  const characterNames: Record<string, string> = {};
  for (const character of characters) {
    characterNames[character.id] = character.name;
  }

  const lineView = new SemanticSceneLineView(input.document);
  const segmentStartState: CinematicExistingStateLineV1[] = [];
  for (const line of lineView.lines) {
    if (!CINEMATIC_STATE_FAMILIES.includes(line.type)) continue;
    if (line.time > input.unitStartTime) continue;
    segmentStartState.push({
      line: line.line,
      time: line.time,
      type: line.type,
      params: line.params,
      ...(line.parentLine !== undefined ? { parentLine: line.parentLine } : {}),
    });
  }

  const existingRecipeIds = Object.keys(input.document.visual?.recipeOverlay ?? {});
  const existingLightingPresets = input.document.statements.flatMap((statement) => (
    statement.type === 'lighting' && statement.params.effect === 'preset' && statement.params.preset
      ? [statement.params.preset]
      : []
  ));

  return {
    version: 1,
    characterTargets,
    characterNames,
    segmentStartState,
    cameraModes: [...(input.capabilities?.cameraModes ?? DEFAULT_CAMERA_MODES)],
    cameraPresets: [...(input.capabilities?.cameraPresets ?? [])],
    lightingPresets: uniqueStrings([
      ...(input.capabilities?.lightingPresets ?? []),
      ...existingLightingPresets,
    ]),
    visualRecipeIds: uniqueStrings([
      ...(input.capabilities?.visualRecipeIds ?? []),
      ...existingRecipeIds.filter((recipeId) => input.document.visual?.recipeOverlay?.[recipeId]?.stack === 'composite'),
    ]),
    ...(input.extraNotes && input.extraNotes.length > 0
      ? { notes: [...input.extraNotes] }
      : {}),
  };
}

export interface CinematicCapabilityResourceDiagnostic {
  readonly gate: 'resource';
  readonly severity: 'error';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export function validateCinematicResourceCapabilities(
  document: CurrentSceneDocument,
  catalog: CinematicCapabilityCatalogV1,
): readonly CinematicCapabilityResourceDiagnostic[] {
  const diagnostics: CinematicCapabilityResourceDiagnostic[] = [];
  const characterTargets = new Set(catalog.characterTargets);

  for (const statement of document.statements) {
    validateCinematicStatement({
      type: statement.type,
      params: statement.params as unknown as Record<string, unknown>,
      path: `statement:${statement.id}.params`,
      speakerId: statement.type === 'dialogue' && typeof statement.params.speakerId === 'string'
        ? statement.params.speakerId
        : undefined,
      catalog,
      characterTargets,
      diagnostics,
    });
    if (statement.type !== 'dialogue' || !statement.companions) continue;
    const speakerId = typeof statement.params.speakerId === 'string'
      ? statement.params.speakerId
      : undefined;
    for (const companion of statement.companions) {
      validateCinematicStatement({
        type: companion.type,
        params: companion.params as unknown as Record<string, unknown>,
        path: `statement:${statement.id}.companion:${companion.id}.params`,
        speakerId,
        catalog,
        characterTargets,
        diagnostics,
      });
    }
  }

  return diagnostics;
}

function validateCinematicStatement(input: {
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly path: string;
  readonly speakerId?: string;
  readonly catalog: CinematicCapabilityCatalogV1;
  readonly characterTargets: ReadonlySet<string>;
  readonly diagnostics: CinematicCapabilityResourceDiagnostic[];
}): void {
  if (input.type === 'camera') {
    const mode = readString(input.params.mode);
    if (mode && !input.catalog.cameraModes.includes(mode)) {
      pushCinematicDiagnostic(input, 'camera_mode_unavailable', `Camera mode "${mode}" is not in the host catalog`, `${input.path}.mode`);
    }
    const target = readString(input.params.target);
    const targetId = target === '$speaker' ? input.speakerId : target;
    if (targetId && !input.characterTargets.has(targetId)) {
      pushCinematicDiagnostic(input, 'camera_target_unavailable', `Camera target "${targetId}" is not present in the scene character directory`, `${input.path}.target`);
    }
  }

  if (input.type === 'lighting' && input.params.effect === 'preset') {
    const preset = readString(input.params.preset);
    if (preset && !input.catalog.lightingPresets.includes(preset)) {
      pushCinematicDiagnostic(input, 'lighting_preset_unavailable', `Lighting preset "${preset}" is not in the host catalog`, `${input.path}.preset`);
    }
  }

  if (input.type === 'visualStyle') {
    const recipeId = readString(input.params.recipeId);
    if (recipeId && !input.catalog.visualRecipeIds.includes(recipeId)) {
      pushCinematicDiagnostic(input, 'visual_recipe_unavailable', `Visual recipe "${recipeId}" is not in the host catalog`, `${input.path}.recipeId`);
    }
  }
}

function pushCinematicDiagnostic(
  input: { diagnostics: CinematicCapabilityResourceDiagnostic[] },
  code: string,
  message: string,
  path: string,
): void {
  input.diagnostics.push({ gate: 'resource', severity: 'error', code, message, path });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}
