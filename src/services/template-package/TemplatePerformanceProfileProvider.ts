import {
  StaticPerformanceProfileProvider,
  type PerformanceProfileProvider,
  type PerformanceProfileSourceV1,
} from '../ai-authoring/performance';
import type {
  PerformanceIdentityResolutionV1,
  SceneCharacterIdentity,
} from '../ai-authoring/performance/PerformanceProfileTypes';
import type { LoadedTemplatePackage } from './TemplatePackageManifest';
import { createTemplatePackageView } from './TemplatePackageLoader';

/**
 * Build a PerformanceProfileProvider from loaded template packages.
 * Only profiles from packages present in enabledTemplateIds (or all packages when not given)
 * are included. Absence of profiles is a normal "no specialized knowledge" state and returns
 * null (generic performance guidance applies); corrupt packages fail during loading instead.
 */
export function createPerformanceProfileProviderFromTemplatePackages(
  packages: readonly LoadedTemplatePackage[],
  enabledTemplateIds?: readonly string[],
): PerformanceProfileProvider | null {
  const view = createTemplatePackageView(
    [...packages],
    enabledTemplateIds ? { enabledTemplateIds: [...enabledTemplateIds] } : {},
  );
  if (view.performanceProfiles.length === 0) return null;
  const sources: PerformanceProfileSourceV1[] = view.performanceProfiles.map((profile) => ({
    profile: {
      schemaVersion: profile.schemaVersion,
      id: profile.id,
      name: profile.name,
      characters: profile.characters,
    },
    priority: profile.priority,
    templateId: profile.source.templateId,
  }));
  return new StaticPerformanceProfileProvider({ sources });
}

/**
 * Delegating provider whose inner provider (and thus its sources, priority and
 * template enablement) is resolved lazily per access. Used when the caller's
 * template catalog or project configuration changes without recreating the
 * provider, e.g. the project Agent across project switches. When the resolver
 * returns null the delegating provider reports no specialized knowledge.
 */
export function createLazyPerformanceProfileProvider(
  resolve: () => PerformanceProfileProvider | null,
): PerformanceProfileProvider {
  return {
    get version(): string {
      return resolve()?.version ?? 'no-profile-provider';
    },
    resolveCharacter(sceneCharacter: SceneCharacterIdentity): PerformanceIdentityResolutionV1 {
      const provider = resolve();
      return provider ? provider.resolveCharacter(sceneCharacter) : { status: 'none' };
    },
    listProfiles() {
      return resolve()?.listProfiles() ?? [];
    },
  };
}
