import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec } from '../services/semantic-scene';
import {
  buildLifecyclePairTable,
  listActiveLifecycleWindowsAt,
  listEndableLifecyclesAt,
  resolveLifecyclePair,
} from '../ui/timeline/lifecyclePairing';

function parseStatements(statements: unknown[]) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'lifecycle-pairing',
    meta: { title: 'Lifecycle pairing' },
    statements,
  });
}

describe('lifecyclePairing', () => {
  it('pairs explicit enter/exit on the same key', () => {
    const document = parseStatements([
      {
        id: 'enter-a',
        time: 2,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A', durationSeconds: 0.5 },
      },
      {
        id: 'exit-a',
        time: 8,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A', durationSeconds: 1 },
      },
    ]);

    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'enter-a')).toMatchObject({
      status: 'paired',
      peerId: 'exit-a',
      role: 'start',
      typeKey: 'characterPresence:presence',
      stateKey: 'character:id="A"',
    });
    expect(resolveLifecyclePair(table, 'exit-a')).toMatchObject({
      status: 'paired',
      peerId: 'enter-a',
      role: 'end',
    });
  });

  it('marks a lone start as open', () => {
    const document = parseStatements([
      {
        id: 'enter-a',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'enter-a')?.status).toBe('open');
    expect(listEndableLifecyclesAt(table, 5).map((r) => r.statementId)).toEqual(['enter-a']);
  });

  it('marks superseded-open when a later start replaces an unpaired start', () => {
    const document = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'enter-a1')).toMatchObject({
      status: 'superseded-open',
      supersededAt: { statementId: 'enter-a2', time: 5 },
    });
    expect(resolveLifecyclePair(table, 'enter-a2')?.status).toBe('open');

    // Between A1 and A2: both endable? A1 yes, A2 not yet started at T=3... A2 starts at 5
    expect(listEndableLifecyclesAt(table, 3).map((r) => r.statementId)).toEqual(['enter-a1']);
    // At T=6 only A2 (A1 window closed)
    expect(listEndableLifecyclesAt(table, 6).map((r) => r.statementId)).toEqual(['enter-a2']);
    // At supersession time T=5, A1 not endable (strictly before supersession)
    expect(listEndableLifecyclesAt(table, 5).map((r) => r.statementId)).toEqual(['enter-a2']);
  });

  it('pairs an end between two starts with the earlier superseded start', () => {
    const document = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-a1',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    // Order in source is enter1, exit1, enter2 — exit between is explicit.
    // For the superseded case: enter1, enter2, then end between would need times 1,5,3 which sorts to 1,3,5.
    // Here exit at 3 with enter2 at 5: enter1 pairs with exit, enter2 open.
    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'enter-a1')).toMatchObject({
      status: 'paired',
      peerId: 'exit-a1',
    });
    expect(resolveLifecyclePair(table, 'enter-a2')?.status).toBe('open');
  });

  it('pairs end before supersession with the superseded start (replacement window)', () => {
    // Times: A1@1, A2@5, end@3 → sorted 1,3,5 so end pairs with A1 before A2 exists as supersession in stream.
    // To test window after supersession metadata: A1@1, A2@5, end must be between — if end is at 3 it pairs before A2 is seen.
    // Real case for "end after both starts known": build with A1, A2 then end at time between via order:
    // A1@1, A2@5, End@4 — sort order: A1, End@4, A2@5. End pairs A1; A2 open. A1 never gets supersededAt because End consumed it first.
    // Case: A1@1, A2@5 remain open with supersession; then we only list endable.
    // Case where end comes after both starts in order but time between: impossible if sort by time.
    // Equal-time: A1@5 order0, End@5 order1, A2@5 order2
    const document = parseStatements([
      {
        id: 'enter-a1',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-a1',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document, {
      canonicalStatementOrder: ['enter-a1', 'exit-a1', 'enter-a2'],
    });
    expect(resolveLifecyclePair(table, 'enter-a1')).toMatchObject({
      status: 'paired',
      peerId: 'exit-a1',
    });
    expect(resolveLifecyclePair(table, 'enter-a2')?.status).toBe('open');
  });

  it('does not pair an end after supersession with the earlier start', () => {
    const document = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-late',
        time: 8,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);
    const a1 = resolveLifecyclePair(table, 'enter-a1');
    expect(a1?.status).toBe('superseded-open');
    expect(a1?.peerId).toBeUndefined();
    expect(resolveLifecyclePair(table, 'enter-a2')).toMatchObject({
      status: 'paired',
      peerId: 'exit-late',
    });
    expect(resolveLifecyclePair(table, 'exit-late')?.peerId).toBe('enter-a2');
  });

  it('uses insertion-order context for same-time endability before superseding starts', () => {
    const document = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);

    expect(listEndableLifecyclesAt(table, 5).map((r) => r.statementId)).toEqual(['enter-a2']);
    expect(listEndableLifecyclesAt(table, 5, {
      insertionOrder: { beforeStatementId: 'enter-a2' },
    }).map((r) => r.statementId)).toEqual(['enter-a1']);
    expect(listEndableLifecyclesAt(table, 5, {
      insertionOrder: { afterStatementId: 'enter-a2' },
    }).map((r) => r.statementId)).toEqual(['enter-a2']);
  });

  it('pairs same-time ends before superseding starts with the superseded start only', () => {
    const beforeSupersedingDocument = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-a1',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    const beforeTable = buildLifecyclePairTable(beforeSupersedingDocument, {
      canonicalStatementOrder: ['enter-a1', 'exit-a1', 'enter-a2'],
    });
    expect(resolveLifecyclePair(beforeTable, 'enter-a1')).toMatchObject({
      status: 'paired',
      peerId: 'exit-a1',
    });
    expect(resolveLifecyclePair(beforeTable, 'exit-a1')?.peerId).toBe('enter-a1');
    expect(resolveLifecyclePair(beforeTable, 'enter-a2')?.status).toBe('open');

    const afterSupersedingDocument = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-after-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
    ]);
    const afterTable = buildLifecyclePairTable(afterSupersedingDocument, {
      canonicalStatementOrder: ['enter-a1', 'enter-a2', 'exit-after-a2'],
    });
    const enterA1After = resolveLifecyclePair(afterTable, 'enter-a1');
    expect(enterA1After?.status).toBe('superseded-open');
    expect(enterA1After?.peerId).toBeUndefined();
    expect(resolveLifecyclePair(afterTable, 'exit-after-a2')?.peerId).toBe('enter-a2');
  });

  it('marks orphan ends with no start', () => {
    const document = parseStatements([
      {
        id: 'exit-a',
        time: 2,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'exit-a')?.status).toBe('orphan-end');
  });

  it('does not pair across different state keys', () => {
    const document = parseStatements([
      {
        id: 'enter-a',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-b',
        time: 2,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'B' },
      },
    ]);
    const table = buildLifecyclePairTable(document);
    expect(resolveLifecyclePair(table, 'enter-a')?.status).toBe('open');
    expect(resolveLifecyclePair(table, 'exit-b')?.status).toBe('orphan-end');
  });

  it('lists active windows including paired-before-end and excludes them from endable', () => {
    const document = parseStatements([
      {
        id: 'enter-a',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'exit-a',
        time: 10,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);

    expect(listEndableLifecyclesAt(table, 5).map((r) => r.statementId)).toEqual([]);
    expect(listActiveLifecycleWindowsAt(table, 5).map((r) => r.statementId)).toEqual(['enter-a']);
    expect(listActiveLifecycleWindowsAt(table, 10).map((r) => r.statementId)).toEqual([]);
    expect(listActiveLifecycleWindowsAt(table, 0.5).map((r) => r.statementId)).toEqual([]);
    expect(listActiveLifecycleWindowsAt(table, 10, {
      insertionOrder: { beforeStatementId: 'exit-a' },
    }).map((r) => r.statementId)).toEqual(['enter-a']);
  });

  it('active windows include superseded-open before replacement and open after', () => {
    const document = parseStatements([
      {
        id: 'enter-a1',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
      {
        id: 'enter-a2',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A' },
      },
    ]);
    const table = buildLifecyclePairTable(document);
    expect(listActiveLifecycleWindowsAt(table, 3).map((r) => r.statementId)).toEqual(['enter-a1']);
    expect(listActiveLifecycleWindowsAt(table, 5).map((r) => r.statementId)).toEqual(['enter-a2']);
    expect(listActiveLifecycleWindowsAt(table, 5, {
      insertionOrder: { beforeStatementId: 'enter-a2' },
    }).map((r) => r.statementId)).toEqual(['enter-a1']);
    expect(listActiveLifecycleWindowsAt(table, 6).map((r) => r.statementId)).toEqual(['enter-a2']);
  });
});
