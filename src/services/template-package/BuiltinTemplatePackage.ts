import defaultSemanticTemplateManifest from '../../templates/default/manifest.v2.json';
import { createBuiltinTemplatePackage, createTemplatePackageView } from './TemplatePackageLoader';
import type { ComboTemplate } from './TemplatePackageManifest';

export const SEMANTIC_BUILTIN_TEMPLATE_PACKAGE = createBuiltinTemplatePackage(
  defaultSemanticTemplateManifest,
  'src/templates/default',
);

export const BUILTIN_TEMPLATE_PACKAGES = [
  SEMANTIC_BUILTIN_TEMPLATE_PACKAGE,
] as const;

export const BUILTIN_TEMPLATE_PACKAGE = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE;

export const AUTHORING_TEMPLATES: ComboTemplate[] = createTemplatePackageView([
  BUILTIN_TEMPLATE_PACKAGE,
]).authoringCombos;
