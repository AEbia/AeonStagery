import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../../api/types/semantic-scene';
import {
  CompatibleSceneSession,
  SceneDocumentCodec,
  sceneDocumentCodec,
} from '../semantic-scene';
import type { CompatibilityIssue } from '../compatibility/types';

export type CollaborativeSceneAdmissionIssueCode =
  | 'unknown_fields_present'
  | 'unsupported_schema_version'
  | 'unknown_discriminator'
  | 'malformed_scene';

export interface CollaborativeSceneAdmissionIssue extends CompatibilityIssue {
  readonly code: CollaborativeSceneAdmissionIssueCode;
  readonly message: string;
  readonly path?: string;
  readonly unknownFieldPaths?: readonly string[];
}

export type CollaborativeSceneAdmissionOutcome =
  | {
      readonly ok: true;
      readonly status: 'admitted';
      readonly session: CompatibleSceneSession;
      readonly document: SceneDocumentV5;
    }
  | {
      readonly ok: false;
      readonly status: 'incompatible';
      readonly reason: string;
      readonly issue: CollaborativeSceneAdmissionIssue;
    }
  | {
      readonly ok: false;
      readonly status: 'invalid';
      readonly reason: string;
      readonly issue: CollaborativeSceneAdmissionIssue;
    };

export class CollaborativeSceneAdmissionError extends Error {
  readonly outcome: Extract<CollaborativeSceneAdmissionOutcome, { ok: false }>;

  constructor(
    message: string,
    outcome: Extract<CollaborativeSceneAdmissionOutcome, { ok: false }>,
  ) {
    super(message);
    this.name = 'CollaborativeSceneAdmissionError';
    this.outcome = outcome;
  }
}

export interface CollaborativeSceneAdmissionGateOptions {
  codec?: SceneDocumentCodec;
}

export class CollaborativeSceneAdmissionGate {
  private readonly codec: SceneDocumentCodec;

  constructor(options: CollaborativeSceneAdmissionGateOptions = {}) {
    this.codec = options.codec ?? sceneDocumentCodec;
  }

  checkAdmission(input: unknown): CollaborativeSceneAdmissionOutcome {
    return validateCanonicalV5CollaborationAdmission(input, this.codec);
  }

  assertAdmission(input: unknown): CompatibleSceneSession {
    const outcome = this.checkAdmission(input);
    if (!outcome.ok) {
      throw new CollaborativeSceneAdmissionError(outcome.reason, outcome);
    }
    return outcome.session;
  }

  isCanonicalV5(input: unknown): boolean {
    return this.checkAdmission(input).ok;
  }

  getIncompatibilityReason(input: unknown): string | null {
    const outcome = this.checkAdmission(input);
    return outcome.ok ? null : outcome.reason;
  }
}

export function validateCanonicalV5CollaborationAdmission(
  input: unknown,
  codec: SceneDocumentCodec = sceneDocumentCodec,
): CollaborativeSceneAdmissionOutcome {
  if (input === null || input === undefined) {
    const reason = 'Malformed scene document: expected an object or CompatibleSceneSession';
    return {
      ok: false,
      status: 'invalid',
      reason,
      issue: {
        code: 'malformed_scene',
        message: reason,
      },
    };
  }

  if (input instanceof CompatibleSceneSession) {
    if (input.projection.schemaVersion !== SCENE_SCHEMA_VERSION_V5) {
      const reason = `Unsupported scene schema epoch ${input.projection.schemaVersion}; exact-version collaboration requires canonical scene v5`;
      return {
        ok: false,
        status: 'incompatible',
        reason,
        issue: {
          code: 'unsupported_schema_version',
          path: 'scene.schemaVersion',
          message: reason,
        },
      };
    }

    if (input.hasUnknownFields) {
      const source = input.serialize();
      const unknownFieldPaths = extractUnknownFieldPaths(source, codec);
      const pathDetail = unknownFieldPaths.length > 0 ? ` (at ${unknownFieldPaths.join(', ')})` : '';
      const reason = `Scene contains unknown fields${pathDetail}; scenes with unknown fields cannot enter exact-version collaboration until wire compatibility is supported`;
      return {
        ok: false,
        status: 'incompatible',
        reason,
        issue: {
          code: 'unknown_fields_present',
          message: reason,
          unknownFieldPaths,
        },
      };
    }

    return {
      ok: true,
      status: 'admitted',
      session: input,
      document: input.projection,
    };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    const reason = 'Expected object at scene';
    return {
      ok: false,
      status: 'invalid',
      reason,
      issue: {
        code: 'malformed_scene',
        message: reason,
      },
    };
  }

  const record = input as Record<string, unknown>;

  if (record.schemaVersion === undefined || !('schemaVersion' in record)) {
    const reason = 'Scene document is missing schemaVersion; unversioned or legacy scenes require offline migration';
    return {
      ok: false,
      status: 'invalid',
      reason,
      issue: {
        code: 'malformed_scene',
        path: 'scene.schemaVersion',
        message: reason,
      },
    };
  }

  if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion) || record.schemaVersion <= 0) {
    const reason = 'Expected a positive integer at scene.schemaVersion';
    return {
      ok: false,
      status: 'invalid',
      reason,
      issue: {
        code: 'malformed_scene',
        path: 'scene.schemaVersion',
        message: reason,
      },
    };
  }

  if (record.schemaVersion === 1 || record.schemaVersion === 2) {
    const reason = `Scene schema version ${record.schemaVersion} requires offline migration before entering collaboration`;
    return {
      ok: false,
      status: 'incompatible',
      reason,
      issue: {
        code: 'unsupported_schema_version',
        path: 'scene.schemaVersion',
        message: reason,
      },
    };
  }

  if (record.schemaVersion === 3 || record.schemaVersion === 4) {
    const reason = `Scene schema version ${record.schemaVersion} requires migration to canonical v5 before entering collaboration`;
    return {
      ok: false,
      status: 'incompatible',
      reason,
      issue: {
        code: 'unsupported_schema_version',
        path: 'scene.schemaVersion',
        message: reason,
      },
    };
  }

  if (record.schemaVersion > SCENE_SCHEMA_VERSION_V5) {
    const reason = `Unsupported scene schema epoch ${record.schemaVersion}; expected ${SCENE_SCHEMA_VERSION_V5}`;
    return {
      ok: false,
      status: 'incompatible',
      reason,
      issue: {
        code: 'unsupported_schema_version',
        path: 'scene.schemaVersion',
        message: reason,
      },
    };
  }

  // schemaVersion === 5
  const sessionOutcome = CompatibleSceneSession.open(input, codec);

  if (sessionOutcome.status === 'invalid') {
    return {
      ok: false,
      status: 'invalid',
      reason: sessionOutcome.issue.message,
      issue: {
        code: 'malformed_scene',
        path: sessionOutcome.issue.path,
        message: sessionOutcome.issue.message,
      },
    };
  }

  if (sessionOutcome.status === 'incompatible') {
    const isDiscriminator = sessionOutcome.issue.code === 'unknown_discriminator';
    return {
      ok: false,
      status: 'incompatible',
      reason: sessionOutcome.issue.message,
      issue: {
        code: isDiscriminator ? 'unknown_discriminator' : 'unsupported_schema_version',
        path: sessionOutcome.issue.path,
        message: sessionOutcome.issue.message,
      },
    };
  }

  if (sessionOutcome.status === 'migration_required') {
    const reason = `Scene schema version ${record.schemaVersion} requires migration to canonical v5 before entering collaboration`;
    return {
      ok: false,
      status: 'incompatible',
      reason,
      issue: {
        code: 'unsupported_schema_version',
        message: reason,
      },
    };
  }

  const session = sessionOutcome.session;
  if (session.hasUnknownFields) {
    const source = session.serialize();
    const unknownFieldPaths = extractUnknownFieldPaths(source, codec);
    const pathDetail = unknownFieldPaths.length > 0 ? ` (at ${unknownFieldPaths.join(', ')})` : '';
    const reason = `Scene contains unknown fields${pathDetail}; scenes with unknown fields cannot enter exact-version collaboration until wire compatibility is supported`;
    return {
      ok: false,
      status: 'incompatible',
      reason,
      issue: {
        code: 'unknown_fields_present',
        message: reason,
        unknownFieldPaths,
      },
    };
  }

  return {
    ok: true,
    status: 'admitted',
    session,
    document: session.projection,
  };
}

function extractUnknownFieldPaths(
  source: unknown,
  codec: SceneDocumentCodec,
): readonly string[] {
  try {
    const currentShape = cloneJson(source);
    if (!currentShape || typeof currentShape !== 'object') return [];
    (currentShape as any).schemaVersion = SCENE_SCHEMA_VERSION;
    const diag = codec.parseKnownProjectionWithDiagnostics(currentShape);
    return diag.removedPaths;
  } catch {
    return [];
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
