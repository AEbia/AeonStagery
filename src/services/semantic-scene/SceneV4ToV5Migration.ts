import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../../api/types/semantic-scene';
import { SceneDocumentCodec, sceneDocumentCodec } from './SceneDocumentCodec';
import { sceneStatementDefinitionRegistry } from './SceneStatementDefinitionRegistry';
import { migrateSceneV3ToV4, repairLegacyV4CustomMotionSegments } from './SceneV3ToV4Migration';

export function migrateSceneV4ToV5(
  input: unknown,
  codec: SceneDocumentCodec = sceneDocumentCodec,
): { document: unknown; warnings: readonly string[] } {
  if (!isRecord(input)) {
    throw new Error('migrateSceneV4ToV5 expects an object input');
  }
  if (input.schemaVersion !== 4) {
    throw new Error(`migrateSceneV4ToV5 expects schemaVersion 4, received ${describeValue(input.schemaVersion)}`);
  }
  if (!Array.isArray(input.statements)) {
    throw new Error('migrateSceneV4ToV5 expects a statements array on schemaVersion 4 scene documents');
  }

  const document = cloneJson(input) as Record<string, unknown>;
  const { document: repaired, warnings } = repairLegacyV4CustomMotionSegments(document);
  const v5Document = repaired as Record<string, unknown>;
  validateV4Stage(v5Document, codec);
  v5Document.schemaVersion = SCENE_SCHEMA_VERSION_V5;

  // Validate detached v5 stage
  validateV5Stage(v5Document, codec);

  return { document: v5Document, warnings };
}

export function migrateSceneV3ToV5(
  input: unknown,
  codec: SceneDocumentCodec = sceneDocumentCodec,
): { document: unknown; warnings: readonly string[] } {
  if (!isRecord(input)) {
    throw new Error('migrateSceneV3ToV5 expects an object input');
  }
  if (input.schemaVersion !== 3) {
    throw new Error(`migrateSceneV3ToV5 expects schemaVersion 3, received ${describeValue(input.schemaVersion)}`);
  }
  if (!Array.isArray(input.statements)) {
    throw new Error('migrateSceneV3ToV5 expects a statements array on schemaVersion 3 scene documents');
  }

  // Stage 1: v3 -> v4
  const v4Result = migrateSceneV3ToV4(input);
  validateV4Stage(v4Result.document, codec);

  // Stage 2: v4 -> v5
  const v5Result = migrateSceneV4ToV5(v4Result.document, codec);

  const warnings = [...v4Result.warnings, ...v5Result.warnings];
  return { document: v5Result.document, warnings };
}

export function validateV4Stage(document: unknown, codec: SceneDocumentCodec): void {
  if (!isRecord(document)) {
    throw new Error('Detached v4 stage validation expects an object');
  }
  // Derive a typed view, then reject families introduced after v4 before
  // upgrading the detached source. Do not backport new families into v4.
  const working = cloneJson(document) as Record<string, unknown>;
  working.schemaVersion = SCENE_SCHEMA_VERSION;
  const projection = codec.parseKnownProjection(working);
  for (const [index, statement] of projection.statements.entries()) {
    const path = `scene.statements[${index}]`;
    sceneStatementDefinitionRegistry.assertSupportedInSchema(statement.type, 4, `${path}.type`);
    for (const [companionIndex, companion] of (statement.companions ?? []).entries()) {
      sceneStatementDefinitionRegistry.assertSupportedInSchema(companion.type, 4, `${path}.companions[${companionIndex}].type`);
    }
  }
}

export function validateV5Stage(document: unknown, codec: SceneDocumentCodec): SceneDocumentV5 {
  if (!isRecord(document)) {
    throw new Error('Detached v5 stage validation expects an object');
  }
  const workingShape = cloneJson(document) as Record<string, unknown>;
  workingShape.schemaVersion = SCENE_SCHEMA_VERSION;
  const projection = codec.parseKnownProjection(workingShape);
  return Object.freeze({
    ...projection,
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Expected a JSON value');
  return JSON.parse(serialized) as T;
}

function describeValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
