export * from './WebGalImportTypes';
export * from './WebGalScriptParser';
export * from './WebGalToSceneConverter';
export * from './WebGalVoiceTiming';

// WebGAL dialogue-template import (`Stage/TextBox/textbox.scss` → template
// package). Exported by name rather than `export *`: the syntax and asset
// modules both re-export `BoxSides` / `Paint`, which a star export would treat
// as an ambiguous collision.
export {
  STAGE_SCALE,
  parseBlocks,
  stripComments,
} from './WebGalScssSyntax';
export {
  extractWebGalTextBoxTheme,
  mapWebGalTextboxStyle,
  translateWebGalTextboxScss,
} from './WebGalTextboxScssTranslator';
export { computeWebGalTextboxStyle } from './WebGalComputedStyle';
export type { WebGalComputedElement, WebGalComputedStyle } from './WebGalComputedStyle';
export {
  buildWebGalScssAssetTable,
  rewriteWebGalScssImageParams,
} from './WebGalTextboxScssAssets';
export {
  buildWebGalTextboxTemplatePackage,
  describeWebGalTemplatePackageFiles,
  WEBGAL_PACKAGE_ASSET_ROOT,
} from './WebGalTextboxScssPackage';
export {
  dialogueParamsSignature,
  findWebGalImportConflicts,
  hashImportSource,
  normalizeScssForHashing,
  scssContentHash,
  slugifyWebGalPackageName,
  stableStringify,
  uniquePackageName,
  WEBGAL_IMPORT_RECORD_FILE,
  WEBGAL_PACKAGE_ID_PREFIX,
} from './WebGalScssPackageNaming';
export type { WebGalImportRecord } from './WebGalScssPackageNaming';
export type {
  BoxSides,
  Paint,
  ScssBlocks,
  ScssDeclarations,
} from './WebGalScssSyntax';
export type {
  WebGalDialogueParams,
  WebGalDialogueStyle,
  WebGalPanelDecoration,
  WebGalPanelTheme,
  WebGalScssTranslation,
  WebGalScssTranslationOptions,
  WebGalTextBoxAssetGeometry,
  WebGalTextBoxTheme,
} from './WebGalTextboxScssTranslator';
export type {
  WebGalScssAsset,
  WebGalScssAssetTable,
  WebGalScssDecorationSources,
  WebGalScssPanelDrawSizes,
} from './WebGalTextboxScssAssets';
export type {
  WebGalTemplatePackageBuild,
  WebGalTemplatePackageFile,
  WebGalTemplatePackageFont,
  WebGalTemplatePackageInput,
} from './WebGalTextboxScssPackage';
