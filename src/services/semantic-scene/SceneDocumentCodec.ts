import {
  SCENE_PACE_TIERS,
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
  type CurrentSceneMeta,
  type DialogueCompanion,
  type ScenePaceTier,
  type SceneStatement,
  type StatementFamily,
} from '../../api/types/semantic-scene';
import type { MarkerRole, SceneMarker } from '../../api/types/scene-common';
import type { SceneVisualBlock } from '../../api/types/visual';
import { sceneStatementDefinitionRegistry, type SceneStatementDefinitionRegistry } from './SceneStatementDefinitionRegistry';
import { assertLensFilterStatements } from './LensFilterStatementValidator';
import {
  migrateSceneV3ToV5,
  migrateSceneV4ToV5,
} from './SceneV4ToV5Migration';
import {
  UnknownSceneDiscriminatorError,
  UnknownSceneFieldError,
} from './SceneDocumentContractErrors';
import { projectKnownSceneVisualBlock } from './SceneVisualKnownProjection';

export class SceneDocumentCodec {
  constructor(
    private readonly registry: SceneStatementDefinitionRegistry = sceneStatementDefinitionRegistry,
  ) {}

  parseAndValidateWithWarnings(input: unknown): { document: CurrentSceneDocument; migrationWarnings: readonly string[] } {
    const root = expectRecord(input, 'scene');

    if (root.schemaVersion === 3) {
      this.assertNoLegacyShape(root);
      const { document, warnings } = migrateSceneV3ToV5(root, this);
      return { document: this.parseAndValidateDocument(document), migrationWarnings: warnings };
    }
    if (root.schemaVersion === 4) {
      this.assertNoLegacyShape(root);
      const { document, warnings } = migrateSceneV4ToV5(root, this);
      return { document: this.parseAndValidateDocument(document), migrationWarnings: warnings };
    }
    if (root.schemaVersion !== SCENE_SCHEMA_VERSION) {
      throw new Error(`Unsupported scene schema version: expected ${SCENE_SCHEMA_VERSION}; older scene schemas must be migrated offline`);
    }
    this.assertNoLegacyShape(root);
    return { document: this.parseAndValidateDocument(root), migrationWarnings: [] };
  }

  parseAndValidate(input: unknown): CurrentSceneDocument {
    return this.parseAndValidateWithWarnings(input).document;
  }

  prepareForSave(snapshot: CurrentSceneDocument): CurrentSceneDocument {
    return this.parseAndValidate(cloneJson(snapshot));
  }

  /**
   * Build the understood projection for a compatibility adapter while keeping
   * the ordinary current-version codec strict. The caller retains the complete
   * Compatibility Source; this method only returns fields known to this reader.
   */
  parseKnownProjectionWithDiagnostics(input: unknown): {
    projection: CurrentSceneDocument;
    hasUnknownFields: boolean;
    removedPaths: readonly string[];
  } {
    const working = cloneJson(input);
    const root = expectRecord(working, 'scene');
    const removedPaths = new Set<string>();
    let visualUnknownFields = false;
    if (root.schemaVersion !== SCENE_SCHEMA_VERSION) {
      throw new Error(`Known projection must use scene schema version ${SCENE_SCHEMA_VERSION}`);
    }
    if (root.visual !== undefined) {
      const originalVisual = cloneJson(root.visual);
      root.visual = projectKnownSceneVisualBlock(root.visual);
      // Object key order is not semantically meaningful: compare canonical
      // (key-sorted) trees so a well-formed visual is never flagged purely
      // because its JSON key order differs from the projection order.
      if (canonicalSortedJson(originalVisual) !== canonicalSortedJson(root.visual)) {
        visualUnknownFields = true;
        removedPaths.add('scene.visual');
      }
    }

    while (true) {
      try {
        const projection = this.parseAndValidateDocument(working);
        return {
          projection,
          hasUnknownFields: removedPaths.size > 0 || visualUnknownFields,
          removedPaths: Array.from(removedPaths),
        };
      } catch (error) {
        if (!(error instanceof UnknownSceneFieldError)) throw error;
        if (removedPaths.has(error.path)) {
          throw new Error(`Could not remove unknown field at ${error.path}`);
        }
        removedPaths.add(error.path);
        delete error.record[error.field];
      }
    }
  }

  parseKnownProjection(input: unknown): CurrentSceneDocument {
    return this.parseKnownProjectionWithDiagnostics(input).projection;
  }

  private assertNoLegacyShape(root: Record<string, unknown>): void {
    if ('timeline' in root) {
      throw new Error('CurrentSceneDocument must use statements, not legacy timeline');
    }
    if ('audio' in root) {
      throw new Error('CurrentSceneDocument must express BGM/SFX as audio statements, not top-level audio');
    }
  }

  private parseAndValidateDocument(input: unknown): CurrentSceneDocument {
    const root = expectRecord(input, 'scene');
    expectKeys(root, 'scene', ['schemaVersion', 'sceneId', 'meta', 'visual', 'statements']);

    const document: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: expectString(root.sceneId, 'scene.sceneId'),
      meta: parseMeta(root.meta, 'scene.meta'),
      ...(root.visual !== undefined ? { visual: cloneJson(root.visual) as SceneVisualBlock } : {}),
      statements: parseStatements(root.statements, this.registry),
    };

    validateDocumentInvariants(document, this.registry);
    assertLensFilterStatements(document);
    return deepFreeze(cloneJson(document));
  }
}

export const sceneDocumentCodec = new SceneDocumentCodec();

function parseStatements(input: unknown, registry: SceneStatementDefinitionRegistry): SceneStatement[] {
  if (!Array.isArray(input)) throw new Error('Expected array at scene.statements');
  return input.map((item, index) => parseRootStatement(item, `scene.statements[${index}]`, registry));
}

function parseRootStatement(
  input: unknown,
  path: string,
  registry: SceneStatementDefinitionRegistry,
): SceneStatement {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['id', 'time', 'type', 'params', 'companions']);
  const type = expectFamily(record.type, `${path}.type`, registry);
  const params = registry.parseParams(
    type,
    normalizeDiagnosticParams(type, record.params),
    `${path}.params`,
  );
  const statement = {
    id: expectString(record.id, `${path}.id`),
    time: expectNonNegativeNumber(record.time, `${path}.time`),
    type,
    params,
    ...(record.companions !== undefined ? {
      companions: parseCompanions(record.companions, path, registry),
    } : {}),
  } as SceneStatement;

  if (statement.companions && statement.type !== 'dialogue') {
    throw new Error(`Only dialogue statements can own companions at ${path}.companions`);
  }
  return statement;
}

function parseCompanions(
  input: unknown,
  parentPath: string,
  registry: SceneStatementDefinitionRegistry,
): DialogueCompanion[] {
  if (!Array.isArray(input)) throw new Error(`Expected array at ${parentPath}.companions`);
  return input.map((item, index) => {
    const path = `${parentPath}.companions[${index}]`;
    const record = expectRecord(item, path);
    expectKeys(record, path, ['id', 'anchor', 'offset', 'type', 'params']);
    const type = expectFamily(record.type, `${path}.type`, registry);
    const params = registry.parseParams(
      type,
      normalizeDiagnosticParams(type, record.params),
      `${path}.params`,
    );
    const companion = {
      id: expectString(record.id, `${path}.id`),
      anchor: expectOneOf(record.anchor, `${path}.anchor`, ['start', 'end']),
      offset: expectFiniteNumber(record.offset, `${path}.offset`),
      type,
      params,
    } as DialogueCompanion;
    if (!registry.isAttachableToDialogue(companion as Pick<SceneStatement, 'type' | 'params'>)) {
      throw new Error(`Statement family ${type} is not attachable to dialogue at ${path}`);
    }
    return companion;
  });
}

/**
 * Operation-dependent missing IDs are source diagnostics, not malformed JSON.
 * Keep direct registry parsing strict for authoring APIs while preserving a
 * placeholder in documents so the normal validation daemon can report the
 * exact statement instead of losing it at the codec boundary.
 */
function normalizeDiagnosticParams(type: StatementFamily, input: unknown): unknown {
  if (type !== 'lighting' || !input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const record = input as Record<string, unknown>;
  const effect = record.effect;
  const mode = record.mode;
  const requiresId = (
    (effect === 'overlay' || effect === 'pointLight')
    && (mode === 'set' || mode === 'modulate' || mode === 'remove')
  );
  // Public codec entries parse detached copies. Retaining this record identity
  // also lets compatibility parsing remove unknown siblings without retrying a
  // freshly reconstructed normalization object.
  if (requiresId && (!Object.prototype.hasOwnProperty.call(record, 'id') || record.id === undefined)) {
    record.id = '';
    return record;
  }
  if (effect === 'preset' && (mode === 'set' || mode === 'modulate')
    && (!Object.prototype.hasOwnProperty.call(record, 'preset') || record.preset === undefined)) {
    record.preset = '';
    return record;
  }
  return input;
}

function validateDocumentInvariants(
  document: CurrentSceneDocument,
  registry: SceneStatementDefinitionRegistry,
): void {
  const statementIds = new Set<string>();
  let lastComputedEnd = 0;

  document.statements.forEach((statement, statementIndex) => {
    if (statementIds.has(statement.id)) {
      throw new Error(`Duplicate statement id "${statement.id}" at scene.statements[${statementIndex}]`);
    }
    statementIds.add(statement.id);
    const statementEnd = statement.time + registry.temporalExtent(statement);
    lastComputedEnd = Math.max(lastComputedEnd, statementEnd);

    const companionIds = new Set<string>();
    statement.companions?.forEach((companion, companionIndex) => {
      const companionPath = `scene.statements[${statementIndex}].companions[${companionIndex}]`;
      if (companionIds.has(companion.id)) {
        throw new Error(`Duplicate companion id "${companion.id}" under statement "${statement.id}"`);
      }
      companionIds.add(companion.id);
      const companionTime = statement.time + (companion.anchor === 'end' ? registry.temporalExtent(statement) : 0) + companion.offset;
      if (companionTime < 0) {
        throw new Error(`Companion time cannot be negative at ${companionPath}`);
      }
      const companionAsStatement = {
        id: companion.id,
        time: companionTime,
        type: companion.type,
        params: companion.params,
      } as SceneStatement;
      lastComputedEnd = Math.max(lastComputedEnd, companionTime + registry.temporalExtent(companionAsStatement));
    });
  });

  if (document.meta.durationSeconds !== undefined && document.meta.durationSeconds < lastComputedEnd) {
    throw new Error(
      `meta.durationSeconds (${document.meta.durationSeconds}) is before computed scene end (${lastComputedEnd})`,
    );
  }
}

function parseMeta(input: unknown, path: string): CurrentSceneMeta {
  const record = expectRecord(input, path);
  expectKeys(record, path, ['title', 'author', 'resolution', 'fps', 'characters', 'markers', 'durationSeconds', 'paceTier']);
  return compact({
    title: expectString(record.title, `${path}.title`),
    author: optionalString(record.author, `${path}.author`),
    resolution: parseResolution(record.resolution, `${path}.resolution`),
    fps: optionalPositiveNumber(record.fps, `${path}.fps`),
    characters: parseCharacters(record.characters, `${path}.characters`),
    markers: parseMarkers(record.markers, `${path}.markers`),
    durationSeconds: optionalNonNegativeNumber(record.durationSeconds, `${path}.durationSeconds`),
    paceTier: optionalPaceTier(record.paceTier, `${path}.paceTier`),
  });
}

function parseResolution(input: unknown, path: string): [number, number] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length !== 2) {
    throw new Error(`Expected [number, number] at ${path}`);
  }
  const width = expectPositiveNumber(input[0], `${path}[0]`);
  const height = expectPositiveNumber(input[1], `${path}[1]`);
  return [width, height];
}

function parseCharacters(input: unknown, path: string): CurrentSceneMeta['characters'] {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    expectKeys(record, itemPath, ['id', 'name', 'model', 'color', 'voiceProfileId', 'variants']);
    return compact({
      id: expectString(record.id, `${itemPath}.id`),
      name: expectString(record.name, `${itemPath}.name`),
      model: optionalString(record.model, `${itemPath}.model`),
      color: optionalString(record.color, `${itemPath}.color`),
      voiceProfileId: optionalString(record.voiceProfileId, `${itemPath}.voiceProfileId`),
      variants: parseCharacterVariants(record.variants, `${itemPath}.variants`),
    });
  });
}

function parseCharacterVariants(input: unknown, path: string): Array<{ name: string; model: string }> | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    expectKeys(record, itemPath, ['name', 'model']);
    return {
      name: expectString(record.name, `${itemPath}.name`),
      model: expectString(record.model, `${itemPath}.model`),
    };
  });
}

function parseMarkers(input: unknown, path: string): SceneMarker[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new Error(`Expected array at ${path}`);
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    expectKeys(record, itemPath, ['markerId', 'time', 'label', 'color', 'role']);
    return compact({
      markerId: expectString(record.markerId, `${itemPath}.markerId`),
      time: expectNonNegativeNumber(record.time, `${itemPath}.time`),
      label: expectString(record.label, `${itemPath}.label`),
      color: optionalString(record.color, `${itemPath}.color`),
      role: optionalMarkerRole(record.role, `${itemPath}.role`),
    });
  });
}

function expectFamily(
  input: unknown,
  path: string,
  registry: SceneStatementDefinitionRegistry,
): StatementFamily {
  const value = expectString(input, path);
  if (!registry.has(value)) {
    throw new UnknownSceneDiscriminatorError(
      path,
      value,
      registry.list().map((definition) => definition.family),
      `Unknown statement family at ${path}: "${value}"`,
    );
  }
  return value;
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Expected object at ${path}`);
  }
  return input as Record<string, unknown>;
}

function expectKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new UnknownSceneFieldError(record, key, path);
    }
  }
}

function expectString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`Expected non-empty string at ${path}`);
  }
  return input;
}

function optionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  return expectString(input, path);
}

function expectFiniteNumber(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error(`Expected finite number at ${path}`);
  }
  return input;
}

function expectNonNegativeNumber(input: unknown, path: string): number {
  const value = expectFiniteNumber(input, path);
  if (value < 0) throw new Error(`Expected non-negative number at ${path}`);
  return value;
}

function expectPositiveNumber(input: unknown, path: string): number {
  const value = expectFiniteNumber(input, path);
  if (value <= 0) throw new Error(`Expected positive number at ${path}`);
  return value;
}

function optionalPositiveNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  return expectPositiveNumber(input, path);
}

function optionalNonNegativeNumber(input: unknown, path: string): number | undefined {
  if (input === undefined) return undefined;
  return expectNonNegativeNumber(input, path);
}

function optionalPaceTier(input: unknown, path: string): ScenePaceTier | undefined {
  if (input === undefined) return undefined;
  return expectOneOf(input, path, SCENE_PACE_TIERS);
}

function expectOneOf<const Values extends readonly string[]>(
  input: unknown,
  path: string,
  values: Values,
): Values[number] {
  const value = expectString(input, path);
  if (!values.includes(value)) {
    throw new UnknownSceneDiscriminatorError(path, value, values);
  }
  return value as Values[number];
}

function optionalMarkerRole(input: unknown, path: string): MarkerRole | undefined {
  if (input === undefined) return undefined;
  return expectOneOf(input, path, ['note', 'beat', 'lens-boundary']);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalSortedJson(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function compact<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}
