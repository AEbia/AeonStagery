import type { LoadedTemplatePackage, SourcedSemanticAuthoringCombo, TemplatePackageScope } from './TemplatePackageManifest';
import { createTemplatePackageView } from './TemplatePackageLoader';
import { createTemplateResourceIndex, type ResourceIndex } from '../resource-authoring';

export interface ITemplatePackageCatalog {
  getRevision(): number;
  getPackages(): readonly LoadedTemplatePackage[];
  setPackages(packages: readonly LoadedTemplatePackage[]): void;
  setRefreshHandler(handler: () => Promise<void>): void;
  refresh(): Promise<void>;
  getSemanticAuthoringCombos(): SourcedSemanticAuthoringCombo[];
  getSummaries(): TemplatePackageSummary[];
  getIdentityIssues(): string[];
  subscribe(listener: () => void): () => void;
}

export interface TemplatePackageSummary {
  id: string;
  aliases?: string[];
  name: string;
  version: string;
  scope: TemplatePackageScope;
  category?: string;
  description?: string;
  characterPresets?: TemplateCharacterPresetSummary[];
  dialogueStyles?: TemplateDialogueStyleSummary[];
  lightingPresets?: TemplateGenericPresetSummary[];
  cameraPresets?: TemplateGenericPresetSummary[];
  defaults?: Record<string, string | undefined>;
}

export interface TemplateCharacterPresetSummary {
  id: string;
  name: string;
  speakerColor?: string;
  variantCount: number;
}

export interface TemplateDialogueStyleSummary {
  id: string;
  name: string;
  renderer: string;
  params?: Record<string, unknown>;
}

export interface TemplateGenericPresetSummary {
  id: string;
  name: string;
}

export class TemplatePackageCatalog implements ITemplatePackageCatalog {
  private packages: LoadedTemplatePackage[];
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private refreshHandler?: () => Promise<void>;

  constructor(initialPackages: readonly LoadedTemplatePackage[] = []) {
    this.packages = [...initialPackages];
  }

  setPackages(packages: readonly LoadedTemplatePackage[]): void {
    this.packages = [...packages];
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  getRevision(): number {
    return this.revision;
  }

  setRefreshHandler(handler: () => Promise<void>): void {
    this.refreshHandler = handler;
  }

  async refresh(): Promise<void> {
    await this.refreshHandler?.();
  }

  getPackages(): readonly LoadedTemplatePackage[] {
    return this.packages;
  }

  getSemanticAuthoringCombos(): SourcedSemanticAuthoringCombo[] {
    return createTemplatePackageView(this.packages).semanticAuthoringCombos;
  }

  getResourceIndex(enabledTemplateIds?: readonly string[]): ResourceIndex {
    return createTemplateResourceIndex(this.packages, enabledTemplateIds);
  }

  getSummaries(): TemplatePackageSummary[] {
    const effectivePackages = createTemplatePackageView(this.packages).packages;
    const templateIds = [...new Set(effectivePackages.map((templatePackage) => templatePackage.manifest.template.id))];
    return templateIds.map((templateId) => {
      const view = createTemplatePackageView(this.packages, { enabledTemplateIds: [templateId] });
      const templatePackage = view.packages.find((candidate) => candidate.manifest.template.id === templateId)!;
      return {
        id: templateId,
        aliases: [...(templatePackage.manifest.template.aliases ?? [])],
        name: templatePackage.manifest.template.name,
        version: templatePackage.manifest.template.version,
        scope: templatePackage.source.scope,
        category: templatePackage.manifest.template.category,
        description: templatePackage.manifest.template.description,
        defaults: { ...view.defaults },
        characterPresets: view.characterPresets.map((preset) => ({
          id: preset.id,
          name: preset.name,
          speakerColor: preset.speakerColor,
          variantCount: Math.max(preset.variants?.length ?? 0, preset.model ? 1 : 0),
        })),
        dialogueStyles: view.dialogueStyles.map((style) => ({
          id: style.id,
          name: style.name,
          renderer: style.renderer,
          params: style.params ? JSON.parse(JSON.stringify(style.params)) : undefined,
        })),
        lightingPresets: summarizeGenericPresets(view.lightingPresets),
        cameraPresets: summarizeGenericPresets(view.cameraPresets),
      };
    });
  }

  getIdentityIssues(): string[] {
    const seen = new Map<string, string>();
    const issues: string[] = [];
    for (const pkg of this.packages) {
      const metadata = pkg.manifest.template;
      for (const id of [metadata.id, ...(metadata.aliases ?? [])]) {
        const previous = seen.get(id);
        if (previous && previous !== metadata.id) {
          issues.push(`Template identity "${id}" is claimed by both "${previous}" and "${metadata.id}".`);
        } else {
          seen.set(id, metadata.id);
        }
      }
    }
    return issues;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function summarizeGenericPresets(
  presets: Array<Record<string, unknown>> | undefined,
): TemplateGenericPresetSummary[] {
  return (presets ?? [])
    .filter((preset): preset is Record<string, unknown> & { id: string } => typeof preset.id === 'string')
    .map((preset) => ({
      id: preset.id,
      name: typeof preset.name === 'string' ? preset.name : preset.id,
    }));
}
