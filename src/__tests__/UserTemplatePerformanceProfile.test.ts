import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { TemplatePackageLoader } from '../services/template-package/TemplatePackageLoader';
import { createPerformanceProfileProviderFromTemplatePackages } from '../services/template-package/TemplatePerformanceProfileProvider';
import { buildPerformanceCapabilityCatalog } from '../services/ai-authoring/performance/PerformanceProfileProvider';
import type { LoadedTemplatePackage } from '../services/template-package/TemplatePackageManifest';

/**
 * A user-authored template must keep working on its own: the Live2D motion and
 * expression key descriptions a user writes into a template performance profile
 * file have to survive profile loading, identity resolution and the intersection
 * with the keys the model actually provides.
 *
 * This is the regression guard for the generic `performanceProfiles` mechanism
 * (ADR-0022/0023): no built-in profile package is required for it to function.
 */

const PACKAGE_ROOT = '/project/template/user-pack';
const MANIFEST_PATH = `${PACKAGE_ROOT}/manifest.v2.json`;
const PROFILE_PATH = `${PACKAGE_ROOT}/profiles/performance.json`;
const TEMPLATE_ID = 'user.pack';

/** The profile file deliberately carries stale id/name: the manifest entry wins. */
const PROFILE_FILE = {
  schemaVersion: 1,
  id: 'stale.profile.id',
  name: 'Stale Profile Name',
  characters: [
    {
      id: 'hero',
      aliases: ['主角', 'Hero'],
      motions: [
        { key: 'hero/idle', description: '轻轻点头' },
        { key: 'hero/angry01', description: '压抑的怒意' },
      ],
      expressions: [{ key: 'smile01', description: '淡淡的微笑' }],
    },
  ],
};

const MANIFEST = {
  manifestSchemaVersion: 2,
  template: {
    id: TEMPLATE_ID,
    name: 'User Pack',
    version: '1.0.0',
    compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
  },
  performanceProfiles: [
    {
      id: 'user.performance',
      name: '用户表演档案',
      schemaVersion: 1,
      file: 'profiles/performance.json',
    },
  ],
};

function createMemoryFileAccess(entries: Record<string, string>) {
  const files = new Map(Object.entries(entries));
  return {
    readFile: async (filePath: string) => {
      const data = files.get(filePath);
      if (data === undefined) throw new Error(`ENOENT: ${filePath}`);
      return { data, path: filePath };
    },
    join: async (...parts: string[]) => parts.join('/').replace(/\/{2,}/g, '/'),
    dirname: async (filePath: string) => filePath.slice(0, filePath.lastIndexOf('/')) || '/',
  };
}

async function loadUserPackage(): Promise<LoadedTemplatePackage> {
  const fileAccess = createMemoryFileAccess({
    [MANIFEST_PATH]: JSON.stringify(MANIFEST),
    [PROFILE_PATH]: JSON.stringify(PROFILE_FILE),
  });
  return new TemplatePackageLoader(fileAccess).loadFromPackageRoot('user', PACKAGE_ROOT);
}

describe('user-authored template performance profile', () => {
  it('loads the profile file and keeps every motion/expression key description', async () => {
    const pkg = await loadUserPackage();
    const entry = pkg.manifest.performanceProfiles?.[0];

    // Manifest identity wins over the values inside the file.
    expect(entry?.id).toBe('user.performance');
    expect(entry?.name).toBe('用户表演档案');

    expect(entry?.characters?.[0]).toMatchObject({
      id: 'hero',
      aliases: ['主角', 'Hero'],
      motions: [
        { key: 'hero/idle', description: '轻轻点头' },
        { key: 'hero/angry01', description: '压抑的怒意' },
      ],
      expressions: [{ key: 'smile01', description: '淡淡的微笑' }],
    });
  });

  it('carries the descriptions through alias resolution and model-key intersection', async () => {
    const pkg = await loadUserPackage();
    const provider = createPerformanceProfileProviderFromTemplatePackages([pkg], [TEMPLATE_ID]);
    expect(provider).not.toBeNull();

    const catalog = buildPerformanceCapabilityCatalog({
      provider: provider!,
      characters: [
        {
          // The scene id differs from the profile id, so this also proves that
          // alias-based identity resolution still reaches the described keys.
          identity: { id: 'scene-hero', name: '主角' },
          motions: ['hero/idle'],
          expressions: [],
        },
      ],
      lookAtTargets: ['scene-hero'],
      reactionTargets: [],
    });

    const character = catalog.characters[0]!;
    expect(character.profile?.characterId).toBe('hero');

    // The user's full declared description set stays retrievable from the provider.
    expect(provider!.listProfiles()[0]?.characters[0]?.motions).toEqual([
      { key: 'hero/idle', description: '轻轻点头' },
      { key: 'hero/angry01', description: '压抑的怒意' },
    ]);

    // Only keys that pass the intersection enter the catalog/prompt, and they
    // keep the description the user wrote.
    expect(character.profile?.motions).toEqual([
      { key: 'hero/idle', description: '轻轻点头' },
    ]);
    expect(character.intersectedProfile?.motions).toEqual([
      { key: 'hero/idle', description: '轻轻点头' },
    ]);

    // A key the model does not provide is reported instead of silently kept.
    expect(character.intersectedProfile?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'profile_motion_unavailable', key: 'hero/angry01' }),
      ]),
    );
  });

  it('reports no specialized knowledge while the template is not enabled', async () => {
    const pkg = await loadUserPackage();
    expect(createPerformanceProfileProviderFromTemplatePackages([pkg], ['some.other.pack']))
      .toBeNull();
  });
});
