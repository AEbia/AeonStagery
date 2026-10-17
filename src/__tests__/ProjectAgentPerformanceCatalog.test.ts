import { describe, expect, it } from 'vitest';
import {
  StaticPerformanceProfileProvider,
  buildPerformanceCapabilityCatalog,
} from '../services/ai-authoring/performance/PerformanceProfileProvider';
import type {
  PerformanceCapabilityCatalogV1,
  PerformanceProfileDocumentV1,
} from '../services/ai-authoring/performance/PerformanceProfileTypes';
import {
  PROJECT_AGENT_CAPABILITY_CATALOG_SLOT,
  injectPerformanceCapabilityCatalog,
  projectPerformanceCapabilityCatalogForAgent,
  serializePerformanceCapabilityCatalogForAgent,
  MAX_AGENT_CAPABILITY_CATALOG_BYTES,
} from '../services/project-agent/ProjectAgentPerformanceCatalog';

const FIXTURE_MOTION_CODES = [
  'turn',
  'idle',
  'angry01',
  'angry02',
  'smile01',
  'smile02',
  'sad01',
  'cry01',
  'wink01',
  'thinking01',
] as const;

const FIXTURE_PERFORMANCE_PROFILE_V1: PerformanceProfileDocumentV1 = {
  schemaVersion: 1,
  id: 'fixture.performance',
  name: 'Fixture Performance Profile',
  characters: ['char-a', 'char-b', 'char-c', 'char-d'].map((characterId) => ({
    id: characterId,
    aliases: [characterId],
    motions: FIXTURE_MOTION_CODES.map((code) => ({
      key: `${characterId}/${code}`,
      description: `${characterId} performs ${code}`,
    })),
    expressions: [{ key: 'smile', description: `${characterId} smiles` }],
  })),
};

const CATALOG: PerformanceCapabilityCatalogV1 = {
  version: 1,
  characters: [{
    characterId: 'char-a',
    name: 'CharA',
    fieldLevelDegrade: false,
    motions: ['char-a/turn', 'char-a/unprofiled'],
    expressions: ['smile', 'neutral'],
    profile: {
      profileId: 'fixture.performance',
      profileName: 'Fixture',
      characterId: 'char-a',
      aliases: ['CharA'],
      motions: [{ key: 'char-a/turn', description: 'turns away with restrained discomfort' }],
      expressions: [{ key: 'smile', description: 'a guarded smile' }],
      matchKind: 'preset_id',
      templateId: 'fixture-template',
    },
    intersectedProfile: {
      motions: [{ key: 'char-a/turn', description: 'turns away with restrained discomfort' }],
      expressions: [{ key: 'smile', description: 'a guarded smile' }],
      diagnostics: [{
        code: 'profile_motion_unavailable',
        message: 'The unavailable profile key is not present on this model',
        characterId: 'char-a',
        key: 'char-a/missing',
      }],
    },
  }],
  lookAtTargets: ['char-a', 'char-b'],
  reactionTargets: ['char-b'],
  diagnostics: [{
    code: 'profile_motion_unavailable',
    message: 'The unavailable profile key is not present on this model',
    characterId: 'char-a',
    key: 'char-a/missing',
  }],
};

function buildFullFixtureCatalog(): PerformanceCapabilityCatalogV1 {
  const characters = FIXTURE_PERFORMANCE_PROFILE_V1.characters.map((character) => ({
    identity: { id: character.id, name: character.aliases?.[0] ?? character.id },
    motions: (character.motions ?? []).map((entry) => entry.key),
    expressions: (character.expressions ?? []).map((entry) => entry.key),
  }));
  const targets = characters.map((character) => character.identity.id);
  return buildPerformanceCapabilityCatalog({
    characters,
    lookAtTargets: targets,
    reactionTargets: targets,
    provider: new StaticPerformanceProfileProvider({
      sources: [{ profile: FIXTURE_PERFORMANCE_PROFILE_V1, priority: 1 }],
    }),
  });
}

describe('ProjectAgent performance catalog projection', () => {
  it('summarizes huge model catalogs without a profile instead of injecting every key', () => {
    const catalog: PerformanceCapabilityCatalogV1 = { ...CATALOG, characters: [{
      characterId: 'anon', name: '爱音', fieldLevelDegrade: false,
      motions: Array.from({ length: 7065 }, (_, i) => `other/character/mtn_angry01_C_live_01_${i}`),
      expressions: Array.from({ length: 918 }, (_, i) => `expression_${i}`),
    }] };
    const serialized = serializePerformanceCapabilityCatalogForAgent(catalog);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_AGENT_CAPABILITY_CATALOG_BYTES);
    expect(JSON.parse(serialized)).toMatchObject({ truncated: true, queryTool: 'searchCharacterCapabilities',
      characters: [{ characterId: 'anon', motionCount: 7065, expressionCount: 918, fieldLevelDegrade: false }] });
    expect(serialized).not.toContain('mtn_angry01');
    expect(catalog.characters[0]?.motions).toHaveLength(7065);
  });

  it('bounds even large character directories and diagnostics in the fixed catalog', () => {
    const serialized = serializePerformanceCapabilityCatalogForAgent({ ...CATALOG,
      characters: Array.from({ length: 1000 }, (_, i) => ({ ...CATALOG.characters[0]!, characterId: `char_${i}`, name: '爱'.repeat(1000) })),
      diagnostics: Array.from({ length: 1000 }, () => ({ code: 'profile_motion_unavailable' as const, message: '诊断'.repeat(1000) })),
    });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_AGENT_CAPABILITY_CATALOG_BYTES);
    expect(JSON.parse(serialized)).toMatchObject({ truncated: true, characterCount: 1000, diagnosticCount: 1000 });
  });

  it('summarizes exact namespaces with separate motion/expression counts and bare-key counts', () => {
    const serialized = serializePerformanceCapabilityCatalogForAgent({ ...CATALOG, diagnostics: [], characters: [{
      characterId: 'anon', name: 'Anon', fieldLevelDegrade: false,
      motions: [...Array.from({ length: 396 }, (_, i) => `mygo/anon/mtn_angry01_C_live_01_${i}`),
        ...Array.from({ length: 300 }, (_, i) => `other/role/motion_${i}`), 'idle'],
      expressions: [...Array.from({ length: 36 }, (_, i) => `mygo/anon/exp_${i}`), 'smile'],
    }] });
    expect(JSON.parse(serialized)).toMatchObject({ characters: [{
      characterId: 'anon', namespaceCount: 3, namespacesTruncated: false,
      namespaces: [
        { prefix: '', motionCount: 1, expressionCount: 1 },
        { prefix: 'mygo/anon/', motionCount: 396, expressionCount: 36 },
        { prefix: 'other/role/', motionCount: 300, expressionCount: 0 },
      ],
    }] });
  });

  it('keeps namespace summaries under the fixed byte limit and reports omitted namespaces', () => {
    const serialized = serializePerformanceCapabilityCatalogForAgent({ ...CATALOG, diagnostics: [], characters: [{
      characterId: 'anon', name: 'Anon', fieldLevelDegrade: false,
      motions: Array.from({ length: 1000 }, (_, i) => `mygo/角色_${i}/motion`), expressions: [],
    }] });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_AGENT_CAPABILITY_CATALOG_BYTES);
    expect(JSON.parse(serialized)).toMatchObject({ characters: [{ namespaceCount: 1000, namespacesTruncated: true }] });
  });
  it('preserves usable keys, descriptions, targets, and concise diagnostics once', () => {
    const projection = projectPerformanceCapabilityCatalogForAgent(CATALOG);

    expect(projection).toEqual({
      version: 1,
      characters: [{
        characterId: 'char-a',
        name: 'CharA',
        fieldLevelDegrade: false,
        motions: [
          { key: 'char-a/turn', description: 'turns away with restrained discomfort' },
          { key: 'char-a/unprofiled' },
        ],
        expressions: [
          { key: 'smile', description: 'a guarded smile' },
          { key: 'neutral' },
        ],
      }],
      lookAtTargets: ['char-a', 'char-b'],
      reactionTargets: ['char-b'],
      diagnostics: [{
        code: 'profile_motion_unavailable',
        message: 'The unavailable profile key is not present on this model',
        characterId: 'char-a',
        key: 'char-a/missing',
      }],
    });
  });

  it('removes duplicated provenance records from the model projection', () => {
    const raw = JSON.stringify(CATALOG);
    const compact = serializePerformanceCapabilityCatalogForAgent(CATALOG);

    expect(compact.length).toBeLessThan(raw.length);
    expect(compact).not.toContain('intersectedProfile');
    expect(compact).not.toContain('profileId');
    expect(compact).not.toContain('templateId');
    expect(compact).toContain('turns away with restrained discomfort');
  });

  it('injects only the compact projection into the system prompt', () => {
    const prompt = injectPerformanceCapabilityCatalog(
      `base\n${PROJECT_AGENT_CAPABILITY_CATALOG_SLOT}`,
      CATALOG,
    );

    expect(prompt).toContain('char-a/unprofiled');
    expect(prompt).toContain('a guarded smile');
    expect(prompt).not.toContain('intersectedProfile');
    expect(prompt).not.toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);
  });

  it('keeps every standard profile key and description while materially reducing prompt payload', () => {
    const catalog = buildFullFixtureCatalog();
    const projection = projectPerformanceCapabilityCatalogForAgent(catalog);
    const rawChars = JSON.stringify(catalog).length;
    const compactChars = JSON.stringify(projection).length;

    expect(compactChars).toBeLessThan(rawChars / 2);
    expect(projection.lookAtTargets).toEqual(catalog.lookAtTargets);
    expect(projection.reactionTargets).toEqual(catalog.reactionTargets);
    for (const character of catalog.characters) {
      const projected = projection.characters.find(
        (entry) => entry.characterId === character.characterId,
      );
      expect(projected?.motions.map((entry) => entry.key)).toEqual(character.motions);
      expect(projected?.expressions.map((entry) => entry.key)).toEqual(character.expressions);
      for (const profileKey of character.profile?.motions ?? []) {
        expect(projected?.motions.find((entry) => entry.key === profileKey.key))
          .toMatchObject({ key: profileKey.key, description: profileKey.description });
      }
      for (const profileKey of character.profile?.expressions ?? []) {
        expect(projected?.expressions.find((entry) => entry.key === profileKey.key))
          .toMatchObject({ key: profileKey.key, description: profileKey.description });
      }
    }
  });
});
