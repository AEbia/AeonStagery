import type { StatementFamily } from '../../api/types/semantic-scene';

export const LEGACY_ACTION_NAMES = [
  'setBackground',
  'removeBackground',
  'setLensRecipe',
  'modulateLens',
  'setCompositeRecipe',
  'modulateComposite',
  'addCharacter',
  'removeCharacter',
  'moveCharacter',
  'transformCharacter',
  'transformBackground',
  'setEnvironmentLayer',
  'transformEnvironmentLayer',
  'removeEnvironmentLayer',
  'characterLookAt',
  'characterBlink',
  'playMotion',
  'setExpression',
  'dialogue',
  'cameraMove',
  'cameraPath',
  'cameraShake',
  'cameraFollow',
  'cameraReset',
  'cameraHitchcock',
  'cameraMotion',
  'setLighting',
  'setBlur',
  'resetBlur',
  'setGodrays',
  'resetGodrays',
  'setPostProcessing',
  'resetPostProcessing',
  'addColorOverlay',
  'removeColorOverlay',
  'clearColorOverlays',
  'clearPointLights',
  'resetLighting',
  'setCharacterRimLight',
  'addPointLight',
  'addImage',
  'transformImage',
  'removeImage',
  'addTextLayer',
  'removeTextLayer',
  'transformTextLayer',
  'playCustomAnimation',
  'playAudio',
  'stopAudio',
  'setBGM',
  'wait',
  'custom',
] as const;

export type LegacyActionName = typeof LEGACY_ACTION_NAMES[number];
export type ActionMigrationConclusion =
  | 'migrate'
  | 'drop'
  | 'runtime-output-only';

export interface LegacyActionMigrationEntry {
  readonly legacyAction: LegacyActionName;
  readonly conclusion: ActionMigrationConclusion;
  readonly statementFamily?: StatementFamily;
  readonly newDiscriminator?: string;
  readonly lowererOutputKeys: readonly string[];
  readonly runtimeActions: readonly LegacyActionName[];
  readonly notes: string;
  readonly blockers?: readonly string[];
}

export type NonActionMigrationConclusion =
  | 'migrate'
  | 'drop'
  | 'version-gate';

export interface NonActionMigrationEntry {
  readonly id: string;
  readonly currentFact: string;
  readonly conclusion: NonActionMigrationConclusion;
  readonly target: string;
  readonly notes: string;
}

function migrate(
  legacyAction: LegacyActionName,
  statementFamily: StatementFamily,
  newDiscriminator: string,
  runtimeActions: readonly LegacyActionName[],
  notes: string,
  blockers?: readonly string[],
): LegacyActionMigrationEntry {
  return migrateWithOutputs(
    legacyAction,
    statementFamily,
    newDiscriminator,
    runtimeActions.map((_action, index) => index === 0 ? 'primary' : `output_${index}`),
    runtimeActions,
    notes,
    blockers,
  );
}

function migrateWithOutputs(
  legacyAction: LegacyActionName,
  statementFamily: StatementFamily,
  newDiscriminator: string,
  lowererOutputKeys: readonly string[],
  runtimeActions: readonly LegacyActionName[],
  notes: string,
  blockers?: readonly string[],
): LegacyActionMigrationEntry {
  return {
    legacyAction,
    conclusion: 'migrate',
    statementFamily,
    newDiscriminator,
    lowererOutputKeys,
    runtimeActions,
    notes,
    ...(blockers ? { blockers } : {}),
  };
}

function drop(
  legacyAction: LegacyActionName,
  notes: string,
): LegacyActionMigrationEntry {
  return {
    legacyAction,
    conclusion: 'drop',
    lowererOutputKeys: [],
    runtimeActions: [],
    notes,
  };
}

function runtimeOnly(
  runtimeAction: LegacyActionName,
  statementFamily: StatementFamily,
  newDiscriminator: string,
  outputKey: string,
  notes: string,
): LegacyActionMigrationEntry {
  return {
    legacyAction: runtimeAction,
    conclusion: 'runtime-output-only',
    statementFamily,
    newDiscriminator,
    lowererOutputKeys: [outputKey],
    runtimeActions: [runtimeAction],
    notes,
  };
}

export const LEGACY_ACTION_MIGRATION_INVENTORY = {
  setBackground: migrate(
    'setBackground',
    'environmentLayer',
    'mode=set layerId=background',
    ['setEnvironmentLayer'],
    'Legacy background sugar becomes the reserved background environment layer.',
  ),
  removeBackground: migrate(
    'removeBackground',
    'environmentLayer',
    'mode=remove layerId=background',
    ['removeEnvironmentLayer'],
    'Legacy background removal becomes reserved background layer removal.',
  ),
  setLensRecipe: drop(
    'setLensRecipe',
    'v3 rejects lens-scoped visualStyle; use an explicit filterAdd statement in authored source.',
  ),
  modulateLens: drop(
    'modulateLens',
    'v3 rejects lens-scoped visualStyle; use an explicit filterChange/filterReset statement in authored source.',
  ),
  setCompositeRecipe: migrate(
    'setCompositeRecipe',
    'visualStyle',
    'scope=object mode=set',
    ['setCompositeRecipe'],
    'Object composite cue becomes object-scoped visualStyle.',
  ),
  modulateComposite: migrate(
    'modulateComposite',
    'visualStyle',
    'scope=object mode=modulate',
    ['modulateComposite'],
    'Object composite envelope becomes object-scoped visualStyle modulation.',
  ),
  addCharacter: migrate(
    'addCharacter',
    'characterPresence',
    'mode=enter',
    ['addCharacter'],
    'Character entrance preserves runtime addCharacter as compiler output.',
  ),
  removeCharacter: migrate(
    'removeCharacter',
    'characterPresence',
    'mode=exit',
    ['removeCharacter'],
    'Character exit preserves runtime removeCharacter as compiler output.',
  ),
  moveCharacter: migrate(
    'moveCharacter',
    'characterTransform',
    'transform partial',
    ['transformCharacter'],
    'moveCharacter is a legacy transform alias; v3 source uses one characterTransform family.',
  ),
  transformCharacter: migrate(
    'transformCharacter',
    'characterTransform',
    'transform partial',
    ['transformCharacter'],
    'Canonical character transform source lowers to the existing runtime transform action.',
  ),
  transformBackground: migrate(
    'transformBackground',
    'environmentLayer',
    'mode=transform layerId=background',
    ['transformEnvironmentLayer'],
    'Legacy background transform becomes reserved background layer transform.',
  ),
  setEnvironmentLayer: migrate(
    'setEnvironmentLayer',
    'environmentLayer',
    'mode=set',
    ['setEnvironmentLayer'],
    'Canonical environment layer set keeps stable layerId.',
  ),
  transformEnvironmentLayer: migrate(
    'transformEnvironmentLayer',
    'environmentLayer',
    'mode=transform',
    ['transformEnvironmentLayer'],
    'Canonical environment layer transform keeps stable layerId.',
  ),
  removeEnvironmentLayer: migrate(
    'removeEnvironmentLayer',
    'environmentLayer',
    'mode=remove',
    ['removeEnvironmentLayer'],
    'Canonical environment layer remove keeps stable layerId.',
  ),
  characterLookAt: migrate(
    'characterLookAt',
    'characterPerformance',
    'lookAt output',
    ['characterLookAt'],
    'Look-at becomes one named output of characterPerformance.',
  ),
  characterBlink: migrate(
    'characterBlink',
    'characterPerformance',
    'blink output',
    ['characterBlink'],
    'Blink becomes one named output of characterPerformance.',
  ),
  playMotion: migrate(
    'playMotion',
    'characterPerformance',
    'motion output',
    ['playMotion'],
    'Motion becomes one named output of characterPerformance.',
  ),
  setExpression: migrate(
    'setExpression',
    'characterPerformance',
    'expression output',
    ['setExpression'],
    'Expression becomes one named output of characterPerformance.',
  ),
  dialogue: migrate(
    'dialogue',
    'dialogue',
    'dialogue root',
    ['dialogue'],
    'Dialogue keeps text/voice duration as source facts and may own companions.',
  ),
  cameraMove: migrate(
    'cameraMove',
    'camera',
    'mode=focus|move',
    ['cameraMotion'],
    'Legacy cameraMove is migrated to semantic camera focus/move before lowering.',
  ),
  cameraPath: migrate(
    'cameraPath',
    'camera',
    'mode=path',
    ['cameraPath'],
    'Path keeps explicit keyframes and duration contribution.',
  ),
  cameraShake: migrate(
    'cameraShake',
    'camera',
    'mode=shake',
    ['cameraShake'],
    'Shake is a finite additive envelope, not transform ownership.',
  ),
  cameraFollow: migrate(
    'cameraFollow',
    'camera',
    'mode=follow operation=start',
    ['cameraFollow'],
    'Legacy indefinite follow must migrate to explicit start/stop lifecycle.',
    ['follow stop/reset validation and seek parity'],
  ),
  cameraReset: migrate(
    'cameraReset',
    'camera',
    'mode=reset',
    ['cameraReset'],
    'Reset releases follow and transform channels in v3 semantics.',
    ['runtime follow release parity'],
  ),
  cameraHitchcock: migrate(
    'cameraHitchcock',
    'camera',
    'mode=hitchcock',
    ['cameraHitchcock'],
    'Hitchcock keeps its dedicated typed camera mode.',
  ),
  cameraMotion: migrate(
    'cameraMotion',
    'camera',
    'mode=focus|move|follow|shake|path|hitchcock',
    ['cameraMotion'],
    'Existing semantic-ish cameraMotion is split by mode and explicit zoom intent.',
    ['absolute-vs-delta zoom migration must inspect move semantics'],
  ),
  setLighting: migrate(
    'setLighting',
    'lighting',
    'effect=preset mode=set',
    ['setLighting'],
    'Lighting preset becomes a typed lighting effect.',
  ),
  setBlur: migrate(
    'setBlur',
    'lighting',
    'effect=blur mode=set',
    ['setBlur'],
    'Blur becomes a typed lighting effect with target state key.',
  ),
  resetBlur: migrate(
    'resetBlur',
    'lighting',
    'effect=blur mode=reset',
    ['resetBlur'],
    'Blur reset becomes explicit lighting reset mode.',
  ),
  setGodrays: migrate(
    'setGodrays',
    'lighting',
    'effect=godrays mode=set',
    ['setGodrays'],
    'Godrays becomes a typed lighting effect.',
  ),
  resetGodrays: migrate(
    'resetGodrays',
    'lighting',
    'effect=godrays mode=reset',
    ['resetGodrays'],
    'Godrays reset becomes explicit lighting reset mode.',
  ),
  setPostProcessing: migrate(
    'setPostProcessing',
    'lighting',
    'effect=post mode=set',
    ['setPostProcessing'],
    'Post-processing fields become a typed lighting post effect; target defaults to panorama and integrated overlay fields are retained.',
  ),
  resetPostProcessing: migrate(
    'resetPostProcessing',
    'lighting',
    'effect=post mode=reset',
    ['resetPostProcessing'],
    'Post-processing reset becomes explicit lighting reset mode; target defaults to panorama and is the only post field besides duration.',
  ),
  addColorOverlay: migrate(
    'addColorOverlay',
    'lighting',
    'effect=overlay mode=set',
    ['addColorOverlay'],
    'Overlay becomes collection lighting effect with stable object id.',
    ['legacy data without overlay id can only migrate to clear-all/report'],
  ),
  removeColorOverlay: migrate(
    'removeColorOverlay',
    'lighting',
    'effect=overlay mode=remove',
    ['removeColorOverlay'],
    'Single overlay removal requires stable object id.',
    ['legacy data without overlay id cannot delete one object'],
  ),
  clearColorOverlays: migrate(
    'clearColorOverlays',
    'lighting',
    'effect=overlay mode=clear',
    ['clearColorOverlays'],
    'Legacy clear-all remains a clear collection operation.',
  ),
  clearPointLights: migrate(
    'clearPointLights',
    'lighting',
    'effect=pointLight mode=clear',
    ['clearPointLights'],
    'Legacy clear-all remains a clear collection operation.',
  ),
  resetLighting: migrate(
    'resetLighting',
    'lighting',
    'effect=preset mode=reset',
    ['resetLighting'],
    'Lighting reset becomes explicit lighting reset mode.',
  ),
  setCharacterRimLight: migrateWithOutputs(
    'setCharacterRimLight',
    'visualStyle',
    'scope=object slot=rim-light mode=set',
    ['rim-light'],
    ['setCharacterRimLight'],
    'Rim light migrates to object visualStyle and keeps the legacy persistent set lifecycle.',
  ),
  addPointLight: migrate(
    'addPointLight',
    'lighting',
    'effect=pointLight mode=set',
    ['addPointLight'],
    'Point light becomes collection lighting effect with stable object id.',
    ['legacy data without point light id can only migrate to clear-all/report'],
  ),
  addImage: migrate(
    'addImage',
    'graphicLayer',
    'kind=image mode=set',
    ['addImage'],
    'Image set keeps a stable layer id and now has transform/remove runtime outputs.',
  ),
  transformImage: runtimeOnly(
    'transformImage',
    'graphicLayer',
    'kind=image mode=transform',
    'primary',
    'Added as v3 compiler/runtime output; not a persistent source action.',
  ),
  removeImage: runtimeOnly(
    'removeImage',
    'graphicLayer',
    'kind=image mode=remove',
    'primary',
    'Added as v3 compiler/runtime output; not a persistent source action.',
  ),
  addTextLayer: migrate(
    'addTextLayer',
    'graphicLayer',
    'kind=text mode=set',
    ['addTextLayer'],
    'Text layer set becomes graphicLayer text set.',
  ),
  removeTextLayer: migrate(
    'removeTextLayer',
    'graphicLayer',
    'kind=text mode=remove',
    ['removeTextLayer'],
    'Text layer remove becomes graphicLayer text remove.',
  ),
  transformTextLayer: migrate(
    'transformTextLayer',
    'graphicLayer',
    'kind=text mode=transform',
    ['transformTextLayer'],
    'Text layer transform becomes graphicLayer text transform.',
  ),
  playCustomAnimation: migrate(
    'playCustomAnimation',
    'customAnimation',
    'animation resource',
    ['playCustomAnimation'],
    'Declarative custom animation remains a typed customAnimation statement.',
  ),
  playAudio: migrate(
    'playAudio',
    'audio',
    'role=sfx mode=play',
    ['playAudio'],
    'SFX play gets stable instance id and interval semantics.',
    ['export AudioMixer must consume play/stop interval model'],
  ),
  stopAudio: migrate(
    'stopAudio',
    'audio',
    'role=sfx|bgm mode=stop',
    ['stopAudio'],
    'Audio stop targets a stable SFX instance or the singleton BGM key.',
    ['export AudioMixer must consume play/stop interval model'],
  ),
  setBGM: migrate(
    'setBGM',
    'audio',
    'role=bgm mode=play',
    ['setBGM'],
    'BGM becomes a singleton audio statement; top-level audio.bgm is removed.',
  ),
  wait: drop(
    'wait',
    'wait is not a v3 statement; trailing pause migrates to meta.durationSeconds and internal gaps become statement times.',
  ),
  custom: drop(
    'custom',
    'custom is removed until a plugin/permission ADR defines signing, sandbox, and versioning.',
  ),
} as const satisfies Record<LegacyActionName, LegacyActionMigrationEntry>;

export type InventoriedLegacyAction = keyof typeof LEGACY_ACTION_MIGRATION_INVENTORY;
type MissingActionInventory = Exclude<LegacyActionName, InventoriedLegacyAction>;
type ExtraActionInventory = Exclude<InventoriedLegacyAction, LegacyActionName>;
export const LEGACY_ACTION_INVENTORY_IS_EXHAUSTIVE: true =
  true as MissingActionInventory extends never
    ? ExtraActionInventory extends never
      ? true
      : never
    : never;

export const NON_ACTION_MIGRATION_INVENTORY = {
  topLevelBgm: {
    id: 'topLevelBgm',
    currentFact: 'SceneScript.audio.bgm',
    conclusion: 'migrate',
    target: 'audio statement with role=bgm mode=play at time 0',
    notes: 'Removes double-fact precedence between top-level BGM and timeline setBGM.',
  },
  aiPauseStep: {
    id: 'aiPauseStep',
    currentFact: 'AiScriptStep.kind=pause lowers to wait action',
    conclusion: 'migrate',
    target: 'advance draft cursor; trailing pause writes meta.durationSeconds',
    notes: 'AI authoring must stop generating wait as a source action.',
  },
  authoringV1IntentReceipt: {
    id: 'authoringV1IntentReceipt',
    currentFact: 'legacy action-ID authoring intents/receipts',
    conclusion: 'drop',
    target: 'AUTHORING_SCHEMA_VERSION=3 statement/companion locators and stable beforeStatementId insertion',
    notes: 'No v1 authoring contract remains in product code; explicit offline migration owns historical payload conversion.',
  },
  collaborationV1WireState: {
    id: 'collaborationV1WireState',
    currentFact: 'COLLABORATION_SCHEMA_VERSION=1 actionsById/timelineOrder/tombstones.actions',
    conclusion: 'version-gate',
    target: 'COLLABORATION_SCHEMA_VERSION=2 statementsById/statementOrder/companion groups',
    notes: 'Scene schema and collaboration schema remain separate version gates.',
  },
  templateAuthoringCombos: {
    id: 'templateAuthoringCombos',
    currentFact: 'TemplatePackageManifest.authoringCombos.actions: LegacyActionName[]',
    conclusion: 'version-gate',
    target: 'manifestSchemaVersion=2 statementPreset/dialoguePreset/timelineFragment',
    notes: 'Loader should reject legacy action arrays after template migration.',
  },
  visualCompositionContracts: {
    id: 'visualCompositionContracts',
    currentFact: 'Visual composition receipts and cross-visual/timeline plans can reference action ids',
    conclusion: 'version-gate',
    target: 'visual composition plans reference statement/companion locators where timeline facts are involved',
    notes: 'VisualTarget and segment records remain separate records, not timeline JSON blobs.',
  },
} as const satisfies Record<string, NonActionMigrationEntry>;
