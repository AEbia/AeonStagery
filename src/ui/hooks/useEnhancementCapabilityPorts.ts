import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { ICharacterAdapter } from '../../api/interfaces';
import type { TemplatePackageCatalog } from '../../services/template-package';
import { createPerformanceProfileProviderFromTemplatePackages } from '../../services/template-package/TemplatePerformanceProfileProvider';
import type { ModelCapabilityPort } from '../../services/ai-authoring/EnhancementProcessorRunner';
import type { CinematicCapabilityPort } from '../../services/ai-authoring/CinematicCapabilityCatalog';
import type { PerformanceProfileProvider } from '../../services/ai-authoring/performance';

export interface LoadedModelCapability {
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
  readonly ready: boolean;
  readonly error?: string;
}

export interface EnhancementCapabilityPortsV1 {
  readonly modelCapabilityPort: ModelCapabilityPort;
  readonly cinematicCapabilityPort: CinematicCapabilityPort;
  readonly profileProvider: PerformanceProfileProvider | null;
}

export interface UseEnhancementCapabilityPortsResult extends EnhancementCapabilityPortsV1 {
  readonly modelCapabilities: Readonly<Record<string, LoadedModelCapability>>;
  readonly loading: boolean;
}

/**
 * Build the enhancement capability ports from a scene document, the character
 * adapter's model data, and the template package catalog. Pure and shared by
 * the formal enhancement panel and the AI prose workbench so both run-time
 * orchestration and draft restore replay use identical port values.
 */
export function buildEnhancementCapabilityPorts(input: {
  readonly document?: CurrentSceneDocument | null;
  readonly modelCapabilities?: Readonly<Record<string, LoadedModelCapability>>;
  readonly templatePackages?: TemplatePackageCatalog | null;
  readonly enabledTemplateIds?: readonly string[] | null;
}): EnhancementCapabilityPortsV1 {
  const document = input.document ?? null;
  const capabilities = input.modelCapabilities ?? {};
  const characters = new Map(
    (document?.meta.characters ?? []).map((character) => [character.id, character] as const),
  );
  const hasModelConfigured = (characterId: string) => Boolean(
    characters.get(characterId)?.model?.trim(),
  );
  const modelCapabilityPort: ModelCapabilityPort = {
    hasModelConfigured,
    motionsForCharacter: (characterId) => capabilities[characterId]?.motions ?? [],
    expressionsForCharacter: (characterId) => capabilities[characterId]?.expressions ?? [],
    capabilitiesReadyForCharacter: (characterId) => (
      !hasModelConfigured(characterId) || capabilities[characterId]?.ready === true
    ),
    capabilityErrorForCharacter: (characterId) => capabilities[characterId]?.error,
  };

  const catalog = input.templatePackages ?? null;
  const summaries = catalog?.getSummaries?.() ?? [];
  const packages = catalog?.getPackages?.() ?? [];
  const idsFromPackages = packages.flatMap((templatePackage) => (
    templatePackage.manifest.visualRecipes ?? []
  )).flatMap((recipe) => typeof recipe.id === 'string' ? [recipe.id] : []);
  const cinematicCapabilityPort: CinematicCapabilityPort = {
    cameraPresets: summaries.flatMap((summary) => (
      (summary.cameraPresets ?? []).map((preset) => preset.id)
    )),
    lightingPresets: summaries.flatMap((summary) => (
      (summary.lightingPresets ?? []).map((preset) => preset.id)
    )),
    visualRecipeIds: idsFromPackages,
  };

  const profileProvider = createPerformanceProfileProviderFromTemplatePackages(
    packages,
    input.enabledTemplateIds ?? undefined,
  );

  return { modelCapabilityPort, cinematicCapabilityPort, profileProvider };
}

/**
 * Memoized capability ports for one scene. Model data is loaded per configured
 * character model path (mirroring the formal panel's loading behavior); ports
 * are rebuilt only when the document, template catalog, or loaded model data
 * changes, so run-time and restore paths share the same port objects.
 */
export function useEnhancementCapabilityPorts(input: {
  readonly document?: CurrentSceneDocument | null;
  readonly characterAdapter?: Pick<ICharacterAdapter, 'getModelDataFromPath'>;
  readonly templatePackages?: TemplatePackageCatalog | null;
  readonly enabledTemplateIds?: readonly string[] | null;
}): UseEnhancementCapabilityPortsResult {
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, LoadedModelCapability>>({});
  const [loading, setLoading] = useState(false);
  const document = input.document ?? null;
  const characterAdapter = input.characterAdapter;
  const templateCatalog = input.templatePackages ?? null;
  const templateRevision = useSyncExternalStore(
    templateCatalog ? (listener) => templateCatalog.subscribe(listener) : () => () => {},
    templateCatalog ? () => templateCatalog.getRevision() : () => 0,
    () => 0,
  );

  const modelCharacterKey = useMemo(
    () => (document?.meta.characters ?? [])
      .map((character) => `${character.id}:${character.model ?? ''}`)
      .join('|'),
    [document],
  );

  useEffect(() => {
    let cancelled = false;
    const modelCharacters = (document?.meta.characters ?? [])
      .filter((character) => typeof character.model === 'string' && character.model.trim() !== '');
    setModelCapabilities({});
    setLoading(modelCharacters.length > 0);
    if (modelCharacters.length === 0 || !characterAdapter) return () => { cancelled = true; };

    void Promise.all(modelCharacters.map(async (character) => {
      try {
        const data = await characterAdapter.getModelDataFromPath(character.model!);
        return [character.id, {
          motions: data.motions,
          expressions: data.expressions,
          ready: true,
        } satisfies LoadedModelCapability] as const;
      } catch (error) {
        return [character.id, {
          motions: [],
          expressions: [],
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies LoadedModelCapability] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setModelCapabilities(Object.fromEntries(entries));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [characterAdapter, document?.meta.characters, document?.sceneId, modelCharacterKey]);

  const enabledTemplateIds = input.enabledTemplateIds ?? null;
  // Stable memo key: project metadata is immutable between changes, but the
  // array identity is not guaranteed across renders.
  const enabledTemplateKey = useMemo(
    () => (enabledTemplateIds ? [...enabledTemplateIds].join('|') : ''),
    [enabledTemplateIds],
  );
  const templateCatalogSnapshot = useMemo(
    () => ({ catalog: templateCatalog, revision: templateRevision }),
    [templateCatalog, templateRevision],
  );

  const ports = useMemo<EnhancementCapabilityPortsV1>(
    () => buildEnhancementCapabilityPorts({
      document,
      modelCapabilities,
      templatePackages: templateCatalogSnapshot.catalog,
      enabledTemplateIds: enabledTemplateKey ? enabledTemplateKey.split('|') : null,
    }),
    [document, modelCapabilities, templateCatalogSnapshot, enabledTemplateKey],
  );

  return { ...ports, modelCapabilities, loading };
}
