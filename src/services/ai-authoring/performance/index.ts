export {
  PERFORMANCE_PROFILE_SCHEMA_VERSION,
  type IntersectedProfileKeysV1,
  type ModelMotionExpressionKeys,
  type PerformanceCapabilityCatalogV1,
  type PerformanceCapabilityCharacterV1,
  type PerformanceIdentityResolutionV1,
  type PerformanceProfileCharacterV1,
  type PerformanceProfileDiagnostic,
  type PerformanceProfileDiagnosticCode,
  type PerformanceProfileDocumentV1,
  type PerformanceProfileKeyEntryV1,
  type PerformanceProfileManifestEntryV1,
  type PerformanceProfileSchemaVersion,
  type PerformanceProfileSourceV1,
  type ResolvedPerformanceCharacterProfileV1,
  type SceneCharacterIdentity,
} from './PerformanceProfileTypes';

export {
  PerformanceProfileValidationError,
  materializeInlinePerformanceProfile,
  parsePerformanceProfileDocument,
  parsePerformanceProfileManifestEntry,
} from './PerformanceProfileValidation';

export {
  intersectProfileWithModelKeys,
  mergePerformanceProfileSources,
  normalizePerformanceIdentityToken,
  resolvePerformanceIdentity,
} from './PerformanceIdentity';

export {
  StaticPerformanceProfileProvider,
  buildPerformanceCapabilityCatalog,
  type BuildPerformanceCapabilityCatalogInput,
  type PerformanceProfileProvider,
  type StaticPerformanceProfileProviderOptions,
} from './PerformanceProfileProvider';

export {
  assertMonotonicPerformanceCompletion,
  assertMonotonicPerformanceParams,
  isMonotonicPerformanceCompletion,
  isPerformanceFillableValue,
  type PerformanceCompletionViolation,
  type PerformanceCompletionViolationCode,
  type PerformanceStatementSnapshot,
} from './PerformanceCompletionGate';
