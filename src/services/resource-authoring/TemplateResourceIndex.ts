import {
  templateMetadataMatchesId,
  type LoadedTemplatePackage,
  type TemplateAssetEntry,
} from '../template-package/TemplatePackageManifest';
import { parseResourceKey } from './ResourceKeyParser';
import { ResourceIndex } from './ResourceIndex';
import { RESOURCE_KINDS, type ResourceKind } from './ResourceAuthoringTypes';
import { TemplateResourceConventionScanner, type TemplateConventionFileAccess } from './TemplateResourceConventionScanner';

const RESOURCE_KIND_SET = new Set<string>(RESOURCE_KINDS);

export function createTemplateResourceIndex(
  packages: readonly LoadedTemplatePackage[],
  enabledTemplateIds?: readonly string[],
): ResourceIndex {
  const index = new ResourceIndex();
  const enabled = enabledTemplateIds ? new Set(enabledTemplateIds) : undefined;
  for (const templatePackage of packages) {
    if (enabled && ![...enabled].some((id) => templateMetadataMatchesId(templatePackage.manifest.template, id))) continue;
    for (const entry of templatePackage.manifest.assets?.index ?? []) {
      addAssetEntry(index, templatePackage.manifest.template.id, entry);
      for (const alias of templatePackage.manifest.template.aliases ?? []) {
        addAssetEntry(index, alias, entry);
      }
    }
  }
  return index;
}

export async function createScannedTemplateResourceIndex(
  packages: readonly LoadedTemplatePackage[],
  fileAccess: TemplateConventionFileAccess,
  enabledTemplateIds?: readonly string[],
  scanner = new TemplateResourceConventionScanner(fileAccess),
): Promise<ResourceIndex> {
  const enabled = enabledTemplateIds ? new Set(enabledTemplateIds) : undefined;
  const selected = enabled
    ? packages.filter((item) => [...enabled].some((id) => templateMetadataMatchesId(item.manifest.template, id)))
    : packages;
  const index = createTemplateResourceIndex(selected, enabledTemplateIds);
  for (const templatePackage of selected) await scanner.addPackage(index, templatePackage);
  return index;
}

function addAssetEntry(index: ResourceIndex, namespace: string, entry: TemplateAssetEntry): void {
  if (!entry.kind || !RESOURCE_KIND_SET.has(entry.kind)) return;
  const kind = entry.kind as ResourceKind;
  const metadata = { ...(entry.metadata ?? {}), ...(entry.label ? { label: entry.label } : {}) };
  const parsed = parseResourceKey(entry.id, kind);
  const ownerId = stringMetadata(entry, 'ownerId') ?? parsed.ownerId;
  const outfitId = stringMetadata(entry, 'outfitId');
  const key = { ...parsed, namespace, ...(ownerId ? { ownerId } : {}), ...(outfitId ? { outfitId } : {}) };
  index.add({ key, namespace, portablePath: entry.path, source: 'explicit', metadata });
  for (const alias of stringArrayMetadata(entry, 'aliases')) {
    const aliasKey = parseResourceKey(alias, kind);
    index.add({
      key: { ...aliasKey, namespace, ...(aliasKey.ownerId || ownerId ? { ownerId: aliasKey.ownerId ?? ownerId } : {}), ...(outfitId ? { outfitId } : {}) },
      namespace,
      portablePath: entry.path,
      source: 'alias',
      metadata,
    });
  }
}

function stringMetadata(entry: TemplateAssetEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function stringArrayMetadata(entry: TemplateAssetEntry, key: string): string[] {
  const value = entry.metadata?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}
