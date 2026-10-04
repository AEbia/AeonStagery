import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  SceneStatementFactory,
} from '../services/semantic-scene/SceneStatementFactory';
import {
  SemanticScenePatchError,
  applySemanticSceneJsonMergePatch,
  applySemanticScenePatch,
  parseSemanticScenePatch,
} from '../services/semantic-scene/SemanticScenePatch';

function deterministicFactory(ids: readonly string[]): SceneStatementFactory {
  let index = 0;
  return new SceneStatementFactory({
    idGenerator: (prefix) => ids[index++] ?? `${prefix}_${index}`,
  });
}

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_patch',
    meta: {
      title: 'Patch Scene',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'First',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'cmp_a',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
              durationSeconds: 0.2,
            },
          },
          {
            id: 'cmp_b',
            anchor: 'start',
            offset: 0.5,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: { kind: 'resource', key: 'wave' },
            },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 0,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
      {
        id: 'dlg_2',
        time: 3,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Second',
          durationSeconds: 1.5,
        },
      },
    ],
  };
}

describe('SemanticScenePatch', () => {
  it.each([
    {
      operation: { kind: 'updateStatement', line: 5, patch: { params: { durationSeconds: 8 } } },
      expectedEnd: 11,
    },
    {
      operation: { kind: 'moveLine', line: 5, time: 11 },
      expectedEnd: 12.5,
    },
    {
      operation: {
        kind: 'insertStatement', time: 12,
        statement: { type: 'dialogue', params: { text: 'Later', durationSeconds: 2 } },
      },
      expectedEnd: 14,
    },
  ])('extends the explicit scene end for a patch that grows content to $expectedEnd', ({ operation, expectedEnd }) => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [operation],
    });

    expect(result.candidate.meta.durationSeconds).toBe(expectedEnd);
  });

  it('extends the scene end before delegated candidate validation', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'moveLine', line: 5, time: 11 }],
    }, { validateCandidate: false });

    expect(result.candidate.meta.durationSeconds).toBe(12.5);
  });

  it('accepts empty operations as no_change without mutation', () => {
    const document = makeDocument();
    const result = applySemanticScenePatch(document, { version: 1, operations: [] });
    expect(result.status).toBe('no_change');
    expect(result.candidate).toBe(document);
    expect(result.lineMap).toMatchObject({
      refreshRequired: false,
      reason: 'none',
    });
    expect(result.counts.inserted).toBe(0);
  });

  it('parses kind/op/operation discriminators and rejects dual discriminators', () => {
    expect(parseSemanticScenePatch({
      version: 1,
      operations: [{ op: 'deleteLine', line: 1 }],
    }).operations[0]).toMatchObject({ kind: 'deleteLine', line: 1 });

    expect(() => parseSemanticScenePatch({
      version: 1,
      operations: [{ kind: 'deleteLine', op: 'deleteLine', line: 1 }],
    })).toThrow(SemanticScenePatchError);
  });

  it('applies recursive JSON Merge Patch with null deletes and atomic arrays', () => {
    const merged = applySemanticSceneJsonMergePatch(
      { text: 'old', style: 'a', tags: ['x'], nested: { a: 1, b: 2 } },
      { text: 'new', style: null, tags: ['y'], nested: { b: 3, c: 4 } },
    );
    expect(merged).toEqual({
      text: 'new',
      tags: ['y'],
      nested: { a: 1, b: 3, c: 4 },
    });
  });

  it('updates statement params without exposing or requiring statement UUID', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'updateStatement',
        line: 1,
        patch: { params: { text: 'Updated' } },
      }],
    });
    expect(result.status).toBe('changed');
    expect(result.candidate.statements[0].params).toMatchObject({ text: 'Updated', durationSeconds: 2 });
    expect(result.counts.updatedStatements).toBe(1);
    expect(JSON.stringify(result.lineView)).not.toContain('dlg_1');
  });

  it('rejects empty update patches and forbidden time/id/companions paths', () => {
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'updateStatement', line: 1, patch: {} }],
    })).toThrow(/Empty patch/);

    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'updateStatement', line: 1, patch: { time: 9 } }],
    })).toThrow(/cannot patch "time"/);
  });

  it('inserts statements at explicit time with same-time beforeLine source order', () => {
    // Lines: 1 dlg_1, 2 cmp_a, 3 cmp_b, 4 cam_1, 5 dlg_2
    const ordered = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'insertStatement',
        time: 0,
        beforeLine: 4,
        statement: {
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Inserted', durationSeconds: 1 },
        },
      }],
    }, { factory: deterministicFactory(['dlg_new']) });

    expect(ordered.candidate.statements.map((s) => s.id)).toEqual(['dlg_1', 'dlg_new', 'cam_1', 'dlg_2']);
    expect(ordered.lineMap.refreshRequired).toBe(true);
    expect(ordered.lineMap.reason).toBe('insert');
    expect((ordered.candidate.statements[1].params as { text: string }).text).toBe('Inserted');
  });

  it('rejects beforeLine at a different time', () => {
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'insertStatement',
        time: 0,
        beforeLine: 5,
        statement: {
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Bad', durationSeconds: 1 },
        },
      }],
    })).toThrow(/same time/);
  });

  it('inserts companions with optional beforeLine on the same parent', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'insertCompanion',
        parentLine: 1,
        beforeLine: 3,
        companion: {
          anchor: 'start',
          offset: 0.2,
          type: 'camera',
          params: { mode: 'focus', target: 'tomori', durationSeconds: 0.1 },
        },
      }],
    }, { factory: deterministicFactory(['shell', 'cmp_new']) });

    const companions = result.candidate.statements[0].companions!.map((c) => c.id);
    expect(companions).toEqual(['cmp_a', 'cmp_new', 'cmp_b']);
    expect(result.counts.insertedCompanions).toBe(1);
  });

  it('moves roots without reordering source array and moves companions from final parent time', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'moveLine', line: 1, time: 5 },
        { kind: 'moveLine', line: 2, time: 5.25 },
      ],
    });
    expect(result.candidate.statements.map((s) => s.id)).toEqual(['dlg_1', 'cam_1', 'dlg_2']);
    expect(result.candidate.statements[0].time).toBe(5);
    expect(result.candidate.statements[0].companions![0].offset).toBe(0.25);
    expect(result.lineMap.refreshRequired).toBe(false);
  });

  it('deletes roots with companion cascade and invalidates line map', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'deleteLine', line: 1 }],
    });
    expect(result.candidate.statements.map((s) => s.id)).toEqual(['cam_1', 'dlg_2']);
    expect(result.lineMap).toMatchObject({
      refreshRequired: true,
      reason: 'delete',
      invalidatedFromLine: 1,
      validThroughLine: 0,
    });
  });

  it('reorders companions as an exact permutation', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'reorderCompanions',
        parentLine: 1,
        orderedLines: [3, 2],
      }],
    });
    expect(result.candidate.statements[0].companions!.map((c) => c.id)).toEqual(['cmp_b', 'cmp_a']);
    expect(result.lineMap.reason).toBe('reorder');
  });

  it('detects conflicting operations', () => {
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'updateStatement', line: 1, patch: { params: { text: 'A' } } },
        { kind: 'deleteLine', line: 1 },
      ],
    })).toThrow(/Conflicting|Cannot update/);

    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'reorderCompanions', parentLine: 1, orderedLines: [3, 2] },
        {
          kind: 'insertCompanion',
          parentLine: 1,
          companion: {
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: { mode: 'focus', target: 'x', durationSeconds: 0.1 },
          },
        },
      ],
    })).toThrow(/reorderCompanions cannot mix/);

    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'moveLine', line: 2, time: 1 },
        { kind: 'updateCompanion', line: 2, patch: { offset: 0.9 } },
      ],
    })).toThrow(/Companion move conflicts/);
  });

  it('merges independent leaf updates on the same statement and conflicts on the same leaf', () => {
    const merged = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'updateStatement', line: 1, patch: { params: { text: 'A' } } },
        { kind: 'updateStatement', line: 1, patch: { params: { durationSeconds: 4 } } },
      ],
    });
    expect(merged.status).toBe('changed');
    expect(merged.candidate.statements[0].params).toMatchObject({
      text: 'A',
      durationSeconds: 4,
      speakerId: 'tomori',
    });
    expect(merged.counts.updatedStatements).toBe(2);

    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'updateStatement', line: 1, patch: { params: { text: 'A' } } },
        { kind: 'updateStatement', line: 1, patch: { params: { text: 'B' } } },
      ],
    })).toThrow(/Conflicting writes/);
  });

  it('invalidates mid-document insertStatement without beforeLine from the first shifted line', () => {
    // Lines: 1 dlg_1, 2 cmp_a, 3 cmp_b, 4 cam_1 (t=0), 5 dlg_2 (t=3)
    // Insert at t=0 without beforeLine → after last same-time root (cam_1), before dlg_2.
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'insertStatement',
        time: 0,
        statement: {
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Mid', durationSeconds: 1 },
        },
      }],
    }, { factory: deterministicFactory(['dlg_mid']) });

    expect(result.candidate.statements.map((s) => s.id)).toEqual([
      'dlg_1', 'cam_1', 'dlg_mid', 'dlg_2',
    ]);
    expect(result.lineMap).toMatchObject({
      refreshRequired: true,
      reason: 'insert',
      invalidatedFromLine: 5,
      validThroughLine: 4,
    });
  });

  it('supports atomic family replacement and stage policy filtering', () => {
    const replaced = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'updateStatement',
        line: 4,
        patch: {
          type: 'lighting',
          params: { effect: 'preset', mode: 'reset', durationSeconds: 0.5 },
        },
      }],
    });
    expect(replaced.candidate.statements[1].type).toBe('lighting');
    expect(replaced.lineMap.reason).toBe('family-replacement');

    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'deleteLine', line: 4 }],
    }, {
      policy: { allowedOperations: ['updateStatement', 'updateCompanion'] },
    })).toThrow(/not allowed by stage policy/);

    // Target family must be allow-listed even when the op itself is allowed.
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'updateStatement',
        line: 1,
        patch: { params: { text: 'No' } },
      }],
    }, {
      policy: {
        allowedOperations: ['updateStatement'],
        allowedFamilies: ['camera', 'lighting'],
      },
    })).toThrow(/family "dialogue".*not allowed/);

    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'deleteLine', line: 4 }],
    }, {
      policy: {
        allowedOperations: ['deleteLine'],
        allowedFamilies: ['dialogue'],
      },
    })).toThrow(/family "camera".*not allowed/);

    // Family replacement requires both old and new families on the whitelist.
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'updateStatement',
        line: 4,
        patch: {
          type: 'lighting',
          params: { effect: 'preset', mode: 'reset', durationSeconds: 0.5 },
        },
      }],
    }, {
      policy: {
        allowedOperations: ['updateStatement'],
        allowedFamilies: ['lighting'],
      },
    })).toThrow(/family "camera".*not allowed/);
  });

  it('resolves all locators against the fixed snapshot before mutation', () => {
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [
        { kind: 'deleteLine', line: 4 },
        {
          kind: 'updateStatement',
          line: 5,
          patch: { params: { text: 'Still second' } },
        },
      ],
    });
    expect(result.candidate.statements.map((s) => s.id)).toEqual(['dlg_1', 'dlg_2']);
    expect((result.candidate.statements[1].params as { text: string }).text).toBe('Still second');
  });

  it('enforces allowedCompanionFamilies on companion insert operations', () => {
    const policy = {
      allowedOperations: ['insertCompanion'],
      allowedCompanionFamilies: ['camera'],
    } as const;
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'insertCompanion',
        parentLine: 1,
        companion: {
          anchor: 'start',
          offset: 0,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: 'wave' },
        },
      }],
    }, { policy, factory: deterministicFactory(['shell', 'cmp_new']) })).toThrow(
      /Companion family "characterPerformance" is not allowed by stage policy/,
    );
  });

  it('enforces allowedCompanionFamilies on both sides of updateCompanion replacement', () => {
    const policy = {
      allowedOperations: ['updateCompanion'],
      allowedCompanionFamilies: ['camera'],
    } as const;
    // Source camera (line 2) replaced to characterPerformance — replacement family rejected.
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'updateCompanion',
        line: 2,
        patch: {
          type: 'characterPerformance',
          params: { target: 'tomori', motion: 'wave' },
        },
      }],
    }, { policy, factory: deterministicFactory(['shell', 'cmp_new']) })).toThrow(
      /Companion family "characterPerformance" is not allowed by stage policy/,
    );
    // Same-family params update stays allowed.
    const kept = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{
        kind: 'updateCompanion',
        line: 2,
        patch: { params: { durationSeconds: 0.4 } },
      }],
    }, { policy, factory: deterministicFactory(['shell', 'cmp_new']) });
    expect(kept.status).toBe('changed');
  });

  it('enforces allowedCompanionFamilies on deleteLine and moveLine of companions', () => {
    const policy = {
      allowedOperations: ['deleteLine', 'moveLine'],
      allowedFamilies: ['characterPerformance'],
      allowedCompanionFamilies: ['camera'],
    } as const;
    // cmp_b (line 3) is a characterPerformance companion: root family whitelist
    // passes, companion whitelist rejects.
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'deleteLine', line: 3 }],
    }, { policy, factory: deterministicFactory(['shell', 'cmp_new']) })).toThrow(
      /Companion family "characterPerformance" is not allowed by stage policy/,
    );
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'moveLine', line: 3, time: 1 }],
    }, { policy, factory: deterministicFactory(['shell', 'cmp_new']) })).toThrow(
      /Companion family "characterPerformance" is not allowed by stage policy/,
    );
  });

  it('enforces allowedCompanionFamilies across reorderCompanions lists', () => {
    const policy = {
      allowedOperations: ['reorderCompanions'],
      allowedCompanionFamilies: ['camera'],
    } as const;
    // Ordered list covers cmp_a (camera) and cmp_b (characterPerformance) — rejected.
    expect(() => applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'reorderCompanions', parentLine: 1, orderedLines: [3, 2] }],
    }, { policy, factory: deterministicFactory(['shell', 'cmp_new']) })).toThrow(
      /Companion family "characterPerformance" is not allowed by stage policy/,
    );

    const whitelistBoth = {
      allowedOperations: ['reorderCompanions'],
      allowedCompanionFamilies: ['camera', 'characterPerformance'],
    } as const;
    const result = applySemanticScenePatch(makeDocument(), {
      version: 1,
      operations: [{ kind: 'reorderCompanions', parentLine: 1, orderedLines: [3, 2] }],
    }, { policy: whitelistBoth, factory: deterministicFactory(['shell', 'cmp_new']) });
    expect(result.status).toBe('changed');
    expect(result.candidate.statements[0].companions!.map((c) => c.id)).toEqual(['cmp_b', 'cmp_a']);
  });
});
