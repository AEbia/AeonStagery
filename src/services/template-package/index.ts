export {
  TEMPLATE_PACKAGE_SCHEMA_VERSION,
  authoringComboToComboTemplate,
  parseTemplateAuthoringCombo,
  parseTemplatePackageManifest,
  templateMetadataMatchesId,
  type LoadedTemplatePackage,
  type SourcedAuthoringCombo,
  type SourcedSemanticAuthoringCombo,
  type SourcedTemplateAssetEntry,
  type SourcedTemplateCharacterPreset,
  type SourcedTemplateDialogueStyle,
  type SourcedTemplateRecord,
  type SourcedPerformanceProfileDocument,
  type TemplateAuthoringCombo,
  type TemplateAuthoringComboAction,
  type TemplateAuthoringComboPayload,
  type TemplateAssetEntry,
  type TemplateCharacterVariant,
  type TemplateCharacterPreset,
  type TemplateDialogueStyle,
  type TemplatePackageAssets,
  type TemplatePackageManifest,
  type TemplatePackageMetadata,
  type TemplateManifestSchemaVersion,
  type TemplatePackageSourceMetadata,
  type TemplatePackageScope,
  type TemplatePackageSource,
} from './TemplatePackageManifest';
export {
  TemplatePackageLoader,
  createBuiltinTemplatePackage,
  createLoadedTemplatePackage,
  createTemplatePackageView,
  resolveTemplateDefaults,
  type TemplatePackageView,
  type TemplatePackageViewOptions,
} from './TemplatePackageLoader';
export {
  createLazyPerformanceProfileProvider,
  createPerformanceProfileProviderFromTemplatePackages,
} from './TemplatePerformanceProfileProvider';
export {
  TemplatePackageDiscovery,
  type TemplatePackageDiscoveryIssue,
  type TemplatePackageDiscoveryOptions,
  type TemplatePackageDiscoveryResult,
} from './TemplatePackageDiscovery';
export { TemplateAssetResolver } from './TemplateAssetResolver';
export {
  TemplatePerformanceProfileAuthoringService,
  listPerformanceProfileEntries,
  getPerformanceProfileFingerprint,
  getPerformanceProfileTargetIdentity,
  type EditablePerformanceProfileTarget,
  type PerformanceProfileEntryKind,
  type PerformanceProfileTemplateDraft,
  type SavePerformanceProfileTemplateInput,
  type SavePerformanceProfileTemplateResult,
  type TemplatePerformanceProfileAuthoringOptions,
} from './TemplatePerformanceProfileAuthoring';
export {
  TemplatePackageCatalog,
  type ITemplatePackageCatalog,
  type TemplatePackageSummary,
  type TemplateCharacterPresetSummary,
  type TemplateDialogueStyleSummary,
  type TemplateGenericPresetSummary,
} from './TemplatePackageCatalog';
export {
  AUTHORING_TEMPLATES,
  BUILTIN_TEMPLATE_PACKAGE,
  BUILTIN_TEMPLATE_PACKAGES,
  SEMANTIC_BUILTIN_TEMPLATE_PACKAGE,
} from './BuiltinTemplatePackage';
export {
  buildTemplateAuthoringPreview,
  parseTemplateCompanionDraft,
  parseTemplateStatementDraft,
  payloadToSemanticIntent,
  templateAuthoringComboToSemanticIntent,
  validateTemplateCompanionDraft,
  validateTemplateStatementDraft,
  type TemplateAuthoringPreview,
  type TemplateSemanticAuthoringInput,
} from './TemplateSemanticAuthoring';
export {
  createInitialCharactersFromTemplates,
  createTemplateInitializedScene,
  importInitialTemplateCharacterAssets,
} from './TemplateSceneInitializer';
