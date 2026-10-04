/**
 * Versioned performance profile contracts for ADR-0022.
 * Profiles are declarative capability catalogs only — no prompts or executable rules.
 */

export const PERFORMANCE_PROFILE_SCHEMA_VERSION = 1 as const;

export type PerformanceProfileSchemaVersion = typeof PERFORMANCE_PROFILE_SCHEMA_VERSION;

export type PerformanceProfileDiagnosticCode =
  | 'invalid_profile'
  | 'unsupported_schema_version'
  | 'ambiguous_identity'
  | 'profile_motion_unavailable'
  | 'profile_expression_unavailable'
  | 'performance_capabilities_unavailable'
  | 'no_match';

export interface PerformanceProfileDiagnostic {
  readonly code: PerformanceProfileDiagnosticCode;
  readonly message: string;
  readonly path?: string;
  readonly characterId?: string;
  readonly profileId?: string;
  readonly key?: string;
}

export interface PerformanceProfileKeyEntryV1 {
  /** Local model motion/expression key as written into characterPerformance (e.g. `anon/angry01`). */
  readonly key: string;
  readonly description?: string;
}

export interface PerformanceProfileCharacterV1 {
  /** Template characterPreset.id used for stable id match. */
  readonly id: string;
  /** Exact normalized names accepted when the scene character id differs. */
  readonly aliases?: readonly string[];
  readonly motions?: readonly PerformanceProfileKeyEntryV1[];
  readonly expressions?: readonly PerformanceProfileKeyEntryV1[];
}

/**
 * Declarative profile document (inline in template manifest or loaded from file).
 * Does not carry system prompts, executable rules, or coverage mandates.
 */
export interface PerformanceProfileDocumentV1 {
  readonly schemaVersion: PerformanceProfileSchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly characters: readonly PerformanceProfileCharacterV1[];
}

/** Template manifest declaration of a performance profile. */
export interface PerformanceProfileManifestEntryV1 {
  readonly id: string;
  readonly name: string;
  readonly schemaVersion: PerformanceProfileSchemaVersion;
  /** Inline characters XOR package-relative file path — never both. */
  readonly characters?: readonly PerformanceProfileCharacterV1[];
  readonly file?: string;
}

export interface PerformanceProfileSourceV1 {
  readonly profile: PerformanceProfileDocumentV1;
  /** Higher number wins for same profile.id across enabled templates. */
  readonly priority: number;
  readonly templateId?: string;
}

export interface ResolvedPerformanceCharacterProfileV1 {
  readonly profileId: string;
  readonly profileName: string;
  readonly characterId: string;
  readonly aliases: readonly string[];
  readonly motions: readonly PerformanceProfileKeyEntryV1[];
  readonly expressions: readonly PerformanceProfileKeyEntryV1[];
  readonly matchKind: 'preset_id' | 'alias';
  readonly templateId?: string;
}

export interface SceneCharacterIdentity {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface ModelMotionExpressionKeys {
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
}

export interface IntersectedProfileKeysV1 {
  readonly motions: readonly PerformanceProfileKeyEntryV1[];
  readonly expressions: readonly PerformanceProfileKeyEntryV1[];
  readonly diagnostics: readonly PerformanceProfileDiagnostic[];
}

export interface PerformanceCapabilityCharacterV1 {
  readonly characterId: string;
  readonly name: string;
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
  /** Field-level degrade when no model is configured (not a hard resource error). */
  readonly fieldLevelDegrade: boolean;
  readonly profile?: ResolvedPerformanceCharacterProfileV1;
  readonly intersectedProfile?: IntersectedProfileKeysV1;
}

/**
 * Host-built catalog for one performance processing unit.
 * Motion/expression keys are always from successfully resolved model data.
 */
export interface PerformanceCapabilityCatalogV1 {
  readonly version: 1;
  readonly characters: readonly PerformanceCapabilityCharacterV1[];
  readonly lookAtTargets: readonly string[];
  readonly reactionTargets: readonly string[];
  readonly diagnostics: readonly PerformanceProfileDiagnostic[];
}

export type PerformanceIdentityResolutionV1 =
  | {
      readonly status: 'matched';
      readonly profile: ResolvedPerformanceCharacterProfileV1;
    }
  | {
      readonly status: 'none';
    }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly ResolvedPerformanceCharacterProfileV1[];
      readonly diagnostic: PerformanceProfileDiagnostic;
    };
