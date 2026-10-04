import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { StaticPerformanceProfileProvider } from '../services/ai-authoring/performance/PerformanceProfileProvider';
import type { PerformanceProfileSourceV1 } from '../services/ai-authoring/performance/PerformanceProfileTypes';
import { createProjectAgentPerformanceCatalogResolver } from '../services/project-agent-service/ProjectAgentPerformanceCatalogResolver';
import { serializePerformanceCapabilityCatalogForAgent } from '../services/project-agent/ProjectAgentPerformanceCatalog';

function documentWithCharacters(
  characters: Array<{ id: string; name: string; model?: string; variants?: Array<{ name: string; model: string }> }>,
): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: { title: 'S', characters },
    statements: [],
  };
}

const FIXTURE_PROFILE: PerformanceProfileSourceV1 = {
  priority: 10,
  profile: {
    schemaVersion: 1,
    id: 'fixture.performance',
    name: 'Fixture',
    characters: [
      {
        id: 'soyo',
        aliases: ['soyo', 'Soyo', 'SOYO'],
        motions: [
          { key: 'anon/angry01', description: 'anger' },
          { key: 'anon/absent-model-key', description: 'never on the model' },
          { key: 'anon/variantMotion', description: 'variant-only motion' },
        ],
        expressions: [
          { key: 'angry', description: 'anger face' },
          { key: 'variantFace', description: 'variant-only face' },
        ],
      },
    ],
  },
};

describe('createProjectAgentPerformanceCatalogResolver', () => {
  it('builds the catalog for ALL scene characters from binding + actual model motions', async () => {
    const resolver = createProjectAgentPerformanceCatalogResolver({
      getSceneSnapshot: () => documentWithCharacters([
        { id: 'soyo', name: 'Soyo', model: 'models/soyo.model3.json' },
        { id: 'tomori', name: 'Tomori' },
      ]),
      loadModelCapabilities: async (characters) => Object.fromEntries(
        characters.map((c) => [c.id, { motions: ['anon/angry01'], expressions: ['angry'] }]),
      ),
      profileProvider: new StaticPerformanceProfileProvider({ sources: [FIXTURE_PROFILE] }),
    });
    const result = await resolver.resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { catalog } = result.value;
    expect(catalog.characters.map((c) => c.characterId)).toEqual(['soyo', 'tomori']);
    const soyo = catalog.characters.find((c) => c.characterId === 'soyo')!;
    expect(soyo.motions).toEqual(['anon/angry01']);
    expect(soyo.fieldLevelDegrade).toBe(false);
    // Profile candidates are intersected with ACTUAL model keys.
    expect(soyo.profile?.motions.map((m) => m.key)).toEqual(['anon/angry01']);
    const tomori = catalog.characters.find((c) => c.characterId === 'tomori')!;
    expect(tomori.fieldLevelDegrade).toBe(true);
    expect(tomori.motions).toEqual([]);
    expect(tomori.profile).toBeUndefined();
    expect(catalog.lookAtTargets).toEqual(['soyo', 'tomori']);
  });

  it('changes the fingerprint when the scene character binding changes', async () => {
    let withModel = true;
    const resolver = createProjectAgentPerformanceCatalogResolver({
      getSceneSnapshot: () => documentWithCharacters([
        { id: 'soyo', name: 'Soyo', model: withModel ? 'models/soyo.model3.json' : undefined },
      ]),
      loadModelCapabilities: async () => ({ soyo: { motions: ['anon/angry01'], expressions: [] } }),
      profileProvider: null,
    });
    const first = await resolver.resolve();
    withModel = false;
    const second = await resolver.resolve();
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.fingerprint).not.toBe(first.value.fingerprint);
      expect(second.value.catalog.characters[0]!.fieldLevelDegrade).toBe(true);
    }
  });

  it('returns a structured failure when no scene snapshot is available', async () => {
    const resolver = createProjectAgentPerformanceCatalogResolver({
      getSceneSnapshot: () => null,
      loadModelCapabilities: async () => ({}),
      profileProvider: null,
    });
    const result = await resolver.resolve();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('scene_unavailable');
  });

  it('unions primary + sub-model variant keys but keeps descriptions only for primary-model keys', async () => {
    const resolver = createProjectAgentPerformanceCatalogResolver({
      getSceneSnapshot: () => documentWithCharacters([
        {
          id: 'soyo',
          name: 'Soyo',
          model: 'models/soyo.model3.json',
          variants: [{ name: '副模型1', model: 'models/soyo_variant.model3.json' }],
        },
      ]),
      loadModelCapabilities: async (chars) => Object.fromEntries(
        chars.map((c) => [c.id, {
          // 'anon/angry01' / 'angry' are duplicated on purpose: a loader may
          // emit the union with repeats, and the resolver must collapse them.
          motions: ['anon/angry01', 'anon/angry01', 'anon/variantMotion'],
          expressions: ['angry', 'angry', 'variantFace'],
          // Primary model owns only these; the variant adds 'anon/variantMotion' / 'variantFace'.
          primaryMotions: ['anon/angry01'],
          primaryExpressions: ['angry'],
        }]),
      ),
      profileProvider: new StaticPerformanceProfileProvider({ sources: [FIXTURE_PROFILE] }),
    });
    const result = await resolver.resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { catalog } = result.value;
    const soyo = catalog.characters.find((c) => c.characterId === 'soyo')!;

    // Union: shared keys are not duplicated and variant-only keys are present,
    // so the prompt is neither bloated nor missing capabilities. Even when the
    // loader emits repeated union keys, each key appears exactly once.
    expect(soyo.motions).toEqual(expect.arrayContaining(['anon/angry01', 'anon/variantMotion']));
    expect(soyo.expressions).toEqual(expect.arrayContaining(['angry', 'variantFace']));
    expect(new Set(soyo.motions).size).toBe(soyo.motions.length);
    expect(new Set(soyo.expressions).size).toBe(soyo.expressions.length);

    // Variant-only keys pass the profile intersection (the profile authors
    // them) but their description is authored for the PRIMARY model — the
    // resolver strips it so the catalog never fabricates a description for a
    // sub-model key.
    const variantExpression = soyo.profile?.expressions.find((e) => e.key === 'variantFace');
    expect(variantExpression).toBeDefined();
    expect(variantExpression?.description).toBeUndefined();
    const variantMotion = soyo.profile?.motions.find((m) => m.key === 'anon/variantMotion');
    expect(variantMotion).toBeDefined();
    expect(variantMotion?.description).toBeUndefined();

    // Primary-model keys keep their profile description.
    const primaryExpression = soyo.profile?.expressions.find((e) => e.key === 'angry');
    expect(primaryExpression?.description).toBe('anger face');

    // The Agent-facing projection keeps the same contract: variant-only keys
    // stay raw values (no description field), primary keys keep theirs.
    const projected = JSON.parse(serializePerformanceCapabilityCatalogForAgent(catalog)) as {
      characters: Array<{
        characterId: string;
        motions: Array<{ key: string; description?: string }>;
        expressions: Array<{ key: string; description?: string }>;
      }>;
    };
    const projectedSoyo = projected.characters.find((c) => c.characterId === 'soyo')!;
    expect(projectedSoyo?.motions.find((m) => m.key === 'anon/variantMotion'))
      .toEqual({ key: 'anon/variantMotion' });
    expect(projectedSoyo?.expressions.find((e) => e.key === 'variantFace'))
      .toEqual({ key: 'variantFace' });
    expect(projectedSoyo?.expressions.find((e) => e.key === 'angry'))
      .toEqual({ key: 'angry', description: 'anger face' });
  });
});
