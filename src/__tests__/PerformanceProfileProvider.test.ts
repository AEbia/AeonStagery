import { describe, expect, it } from 'vitest';
import {
  StaticPerformanceProfileProvider,
  buildPerformanceCapabilityCatalog,
  intersectProfileWithModelKeys,
  mergePerformanceProfileSources,
  normalizePerformanceIdentityToken,
  parsePerformanceProfileDocument,
  parsePerformanceProfileManifestEntry,
  PerformanceProfileValidationError,
  resolvePerformanceIdentity,
  type PerformanceProfileDocumentV1,
  type PerformanceProfileSourceV1,
} from '../services/ai-authoring/performance';

const FIXTURE_PERFORMANCE_PROFILE_V1: PerformanceProfileDocumentV1 = {
  schemaVersion: 1,
  id: 'fixture.performance',
  name: 'Fixture Performance Profile',
  characters: [
    {
      id: 'char-a',
      aliases: ['角色A', 'CharA'],
      motions: [{ key: 'char-a/turn', description: 'turns away with restrained discomfort' }],
      expressions: [{ key: 'smile', description: 'a guarded smile' }],
    },
    {
      id: 'char-b',
      aliases: ['角色B', 'CharB'],
      motions: [
        { key: 'char-b/angry01', description: 'visible anger' },
        { key: 'char-b/angry02', description: 'suppressed anger' },
      ],
      expressions: [{ key: 'angry', description: 'an angry face' }],
    },
    {
      id: 'char-c',
      aliases: ['角色C', 'CharC'],
      motions: [{ key: 'char-c/smile01', description: 'a small smile' }],
      expressions: [],
    },
  ],
};

function source(
  profile: PerformanceProfileDocumentV1,
  priority: number,
  templateId?: string,
): PerformanceProfileSourceV1 {
  return { profile, priority, ...(templateId ? { templateId } : {}) };
}

describe('Performance profile validation', () => {
  it('accepts ID-only characters without requiring a display name', () => {
    const doc = parsePerformanceProfileDocument({
      schemaVersion: 1,
      id: 'id-only',
      name: 'ID only',
      characters: [{ id: 'hero' }],
    });
    expect(doc.characters).toEqual([{ id: 'hero' }]);
  });

  it('converts legacy names into aliases once and removes the legacy field', () => {
    const doc = parsePerformanceProfileDocument({
      schemaVersion: 1,
      id: 'legacy',
      name: 'Legacy',
      characters: [{ id: 'hero', canonicalName: '主角', aliases: ['主角', 'Hero'] }],
    });
    expect(doc.characters).toEqual([{ id: 'hero', aliases: ['主角', 'Hero'] }]);
    expect(parsePerformanceProfileDocument(doc)).toEqual(doc);

    const edited = { ...doc, characters: [{ ...doc.characters[0], aliases: ['新别名'] }] };
    expect(resolvePerformanceIdentity({ id: 'scene-hero', name: '主角' }, [source(edited, 1)]).status).toBe('none');
    expect(resolvePerformanceIdentity({ id: 'scene-hero', name: '新别名' }, [source(edited, 1)]).status).toBe('matched');
  });

  it('parses a valid versioned profile document', () => {
    const doc = parsePerformanceProfileDocument({
      schemaVersion: 1,
      id: 'demo.performance',
      name: 'Demo',
      characters: [
        {
          id: 'hero',
          canonicalName: 'Hero',
          aliases: ['主角'],
          motions: [{ key: 'hero/idle', description: 'idle' }],
        },
      ],
    });
    expect(doc.id).toBe('demo.performance');
    expect(doc.characters[0]?.motions?.[0]?.key).toBe('hero/idle');
  });

  it('rejects unsupported schema versions as hard failures', () => {
    expect(() => parsePerformanceProfileDocument({
      schemaVersion: 99,
      id: 'x',
      name: 'x',
      characters: [],
    })).toThrow(PerformanceProfileValidationError);

    try {
      parsePerformanceProfileDocument({
        schemaVersion: 99,
        id: 'x',
        name: 'x',
        characters: [],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PerformanceProfileValidationError);
      expect((error as PerformanceProfileValidationError).diagnostics[0]?.code)
        .toBe('unsupported_schema_version');
    }
  });

  it('rejects manifest entries that supply both characters and file', () => {
    expect(() => parsePerformanceProfileManifestEntry({
      schemaVersion: 1,
      id: 'x',
      name: 'x',
      characters: [{ id: 'a', canonicalName: 'A' }],
      file: 'profiles/x.json',
    })).toThrow(/both characters and file/);
  });
});

describe('Performance identity resolution', () => {
  const fixture = source(FIXTURE_PERFORMANCE_PROFILE_V1, 10, 'fixture-template');

  it('matches by characterPreset id first', () => {
    const result = resolvePerformanceIdentity({ id: 'char-b', name: 'Someone Else' }, [fixture]);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.profile.characterId).toBe('char-b');
      expect(result.profile.matchKind).toBe('preset_id');
    }
  });

  it('prefers an exact ID over another character matching the scene name by alias', () => {
    const profile: PerformanceProfileDocumentV1 = {
      schemaVersion: 1,
      id: 'acting',
      name: 'Acting',
      characters: [{ id: 'hero' }, { id: 'other', aliases: ['主角'] }],
    };
    const result = resolvePerformanceIdentity({ id: 'hero', name: '主角' }, [source(profile, 1)]);
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.profile.characterId).toBe('hero');
      expect(result.profile.matchKind).toBe('preset_id');
    }
  });

  it('falls back to exact normalized aliases', () => {
    const byName = resolvePerformanceIdentity({ id: 'c1', name: '角色A' }, [fixture]);
    expect(byName.status).toBe('matched');
    if (byName.status === 'matched') {
      expect(byName.profile.characterId).toBe('char-a');
      expect(byName.profile.matchKind).toBe('alias');
    }

    const byAlias = resolvePerformanceIdentity({ id: 'c2', name: 'CharA' }, [fixture]);
    expect(byAlias.status).toBe('matched');
    if (byAlias.status === 'matched') {
      expect(byAlias.profile.characterId).toBe('char-a');
      expect(byAlias.profile.matchKind).toBe('alias');
    }
  });

  it('does not use fuzzy substring matching', () => {
    const result = resolvePerformanceIdentity({ id: 'c3', name: '角' }, [fixture]);
    expect(result.status).toBe('none');
  });

  it('reports ambiguous_identity only for one scene character with multiple equal candidates', () => {
    const twin: PerformanceProfileDocumentV1 = parsePerformanceProfileDocument({
      schemaVersion: 1,
      id: 'other.performance',
      name: 'Other',
      characters: [
        {
          id: 'char-a-alt',
          canonicalName: '角色A',
          aliases: ['CharA'],
          motions: [{ key: 'x/y' }],
        },
      ],
    });
    const result = resolvePerformanceIdentity(
      { id: 'scene-char-a', name: 'CharA' },
      [fixture, source(twin, 10)],
    );
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.diagnostic.code).toBe('ambiguous_identity');
      expect(result.candidates.length).toBeGreaterThan(1);
    }
  });

  it('allows multiple scene characters to each match without ambiguity', () => {
    const first = resolvePerformanceIdentity({ id: 'char-a', name: 'CharA' }, [fixture]);
    const second = resolvePerformanceIdentity({ id: 'char-b', name: 'CharB' }, [fixture]);
    expect(first.status).toBe('matched');
    expect(second.status).toBe('matched');
  });

  it('merges same profile id by higher priority', () => {
    const low: PerformanceProfileDocumentV1 = parsePerformanceProfileDocument({
      schemaVersion: 1,
      id: 'fixture.performance',
      name: 'Low',
      characters: [{ id: 'char-a', canonicalName: '旧角色A' }],
    });
    const merged = mergePerformanceProfileSources([
      source(low, 1),
      fixture,
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.profile.name).toBe(FIXTURE_PERFORMANCE_PROFILE_V1.name);
  });

  it('normalizes identity tokens with NFKC', () => {
    expect(normalizePerformanceIdentityToken('  ＣｈａｒＡ  ')).toBe(
      normalizePerformanceIdentityToken('CharA'),
    );
  });
});

describe('Capability catalog intersection', () => {
  it('intersects profile keys and emits profile_motion_unavailable warnings', () => {
    const provider = new StaticPerformanceProfileProvider({
      sources: [source(FIXTURE_PERFORMANCE_PROFILE_V1, 1)],
    });
    const catalog = buildPerformanceCapabilityCatalog({
      provider,
      characters: [
        {
          identity: { id: 'char-b', name: 'CharB' },
          motions: ['char-b/angry01', 'char-b/custom99'],
          expressions: [],
        },
      ],
      lookAtTargets: ['char-b', 'char-a'],
      reactionTargets: ['char-a'],
    });

    const character = catalog.characters[0]!;
    expect(character.profile?.characterId).toBe('char-b');
    expect(character.motions).toEqual(['char-b/angry01', 'char-b/custom99']);
    expect(character.intersectedProfile?.motions.some((m) => m.key === 'char-b/angry01')).toBe(true);
    expect(character.intersectedProfile?.motions.some((m) => m.key === 'char-b/custom99')).toBe(false);
    expect(
      catalog.diagnostics.some((d) => d.code === 'profile_motion_unavailable' && d.key === 'char-b/angry02'),
    ).toBe(true);
  });

  it('keeps field-level degrade without inventing motion keys', () => {
    const provider = new StaticPerformanceProfileProvider({
      sources: [source(FIXTURE_PERFORMANCE_PROFILE_V1, 1)],
    });
    const catalog = buildPerformanceCapabilityCatalog({
      provider,
      characters: [
        {
          identity: { id: 'char-c', name: 'CharC' },
          motions: [],
          expressions: [],
          fieldLevelDegrade: true,
        },
      ],
    });
    expect(catalog.characters[0]?.fieldLevelDegrade).toBe(true);
    expect(catalog.characters[0]?.motions).toEqual([]);
    expect(catalog.characters[0]?.intersectedProfile).toBeUndefined();
  });

  it('records performance_capabilities_unavailable for field-level degraded characters only', () => {
    const catalog = buildPerformanceCapabilityCatalog({
      characters: [
        {
          identity: { id: 'no-model', name: 'No Model' },
          motions: [],
          expressions: [],
          fieldLevelDegrade: true,
        },
        {
          identity: { id: 'with-model', name: 'With Model' },
          motions: ['idle'],
          expressions: [],
          fieldLevelDegrade: false,
        },
      ],
    });

    const warnings = catalog.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'performance_capabilities_unavailable',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.characterId).toBe('no-model');
    expect(warnings[0]?.message).toContain('no-model');
  });

  it('intersects keys independently of the provider', () => {
    const resolution = resolvePerformanceIdentity(
      { id: 'char-c', name: 'CharC' },
      [source(FIXTURE_PERFORMANCE_PROFILE_V1, 1)],
    );
    expect(resolution.status).toBe('matched');
    if (resolution.status !== 'matched') return;
    const intersection = intersectProfileWithModelKeys(resolution.profile, {
      motions: ['char-c/smile01'],
      expressions: [],
    });
    expect(intersection.motions.map((m) => m.key)).toEqual(['char-c/smile01']);
    expect(intersection.diagnostics.every((d) => d.code === 'profile_motion_unavailable')).toBe(true);
  });
});
