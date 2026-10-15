/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  TemplatePackageCatalog,
  createLoadedTemplatePackage,
} from '../services/template-package';
import { buildEnhancementCapabilityPorts, useEnhancementCapabilityPorts } from '../ui/hooks/useEnhancementCapabilityPorts';

const document: CurrentSceneDocument = {
  schemaVersion: 5,
  sceneId: 'scene-1',
  meta: {
    title: 'Test scene',
    characters: [{ id: 'char-hero', name: 'Hero', model: 'hero.model3.json' }],
  },
  statements: [],
};

function profilePackage() {
  return createLoadedTemplatePackage({
    manifestSchemaVersion: 2,
    template: {
      id: 'test.profile',
      name: 'Profile Package',
      version: '1.0.0',
      compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
    },
    cameraPresets: [{ id: 'camera.test' }],
    lightingPresets: [{ id: 'lighting.test' }],
    visualRecipes: [{ id: 'recipe.test' }],
    performanceProfiles: [{
      id: 'test.performance',
      name: 'Test Profile',
      schemaVersion: 1,
      characters: [{
        id: 'hero',
        aliases: ['Hero'],
        motions: [{ key: 'hero/wave01', description: 'wave' }],
      }],
    }],
  }, { scope: 'user', packageRoot: '/tmp/test/profile' });
}

describe('buildEnhancementCapabilityPorts', () => {
  it('builds ports from the scene and template package catalog', () => {
    const ports = buildEnhancementCapabilityPorts({
      document,
      templatePackages: new TemplatePackageCatalog([profilePackage()]),
      modelCapabilities: {
        'char-hero': { motions: ['hero/wave01'], expressions: [], ready: true },
      },
    });

    expect(ports.profileProvider).not.toBeNull();
    expect(ports.profileProvider!.resolveCharacter({ id: 'char-hero', name: 'Hero' }).status).toBe('matched');
    expect(ports.modelCapabilityPort.hasModelConfigured('char-hero')).toBe(true);
    expect(ports.modelCapabilityPort.motionsForCharacter('char-hero')).toEqual(['hero/wave01']);
    expect(ports.modelCapabilityPort.capabilitiesReadyForCharacter!('char-hero')).toBe(true);
    expect(ports.cinematicCapabilityPort).toBeTruthy();
  });

  it('excludes disabled template presets and recipes', () => {
    const ports = buildEnhancementCapabilityPorts({ templatePackages: new TemplatePackageCatalog([profilePackage()]), enabledTemplateIds: [] });
    expect(ports.profileProvider).toBeNull();
    expect(ports.cinematicCapabilityPort).toEqual({ cameraPresets: [], lightingPresets: [], visualRecipeIds: [] });
  });

  it('keeps an empty selection distinct from unrestricted access through hook updates', () => {
    const catalog = new TemplatePackageCatalog([profilePackage()]);
    const { result, rerender } = renderHook(({ ids }: { ids: string[] | null }) => useEnhancementCapabilityPorts({ templatePackages: catalog, enabledTemplateIds: ids }), { initialProps: { ids: ['test.profile'] as string[] | null } });
    expect(result.current.profileProvider).not.toBeNull();
    rerender({ ids: [] });
    expect(result.current.profileProvider).toBeNull();
    expect(result.current.cinematicCapabilityPort.cameraPresets).toEqual([]);
    rerender({ ids: null });
    expect(result.current.profileProvider).not.toBeNull();
  });

  it('returns no profile provider when the catalog has no profiles', () => {
    const ports = buildEnhancementCapabilityPorts({
      document,
      templatePackages: new TemplatePackageCatalog([]),
    });

    expect(ports.profileProvider).toBeNull();
  });
});
