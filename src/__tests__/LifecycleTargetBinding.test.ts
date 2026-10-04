import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementDefinitionRegistry,
} from '../services/semantic-scene';
import { SEMANTIC_STATEMENT_BLOCKS } from '../ui/timeline/semanticStatementBlocks';
import {
  listAvailableLifecycleTargetBindingCommandIds,
  resolveLifecycleTargetBinding,
} from '../ui/timeline/lifecycleTargetBinding';

function documentOf(statements: unknown[], durationSeconds = 12) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'lifecycle-target-binding',
    meta: { title: 'Lifecycle target binding', durationSeconds },
    statements,
  });
}

describe('lifecycleTargetBinding', () => {
  it('keeps binding commands in parity with registry dependency types', () => {
    const registryTypes = new Set(
      sceneStatementDefinitionRegistry.list()
        .flatMap((definition) => definition.stateSpanDependencies ?? [])
        .map((dependency) => dependency.presentationTypeKey),
    );
    const commandTypes = new Set(
      SEMANTIC_STATEMENT_BLOCKS.flatMap((block) => (
        block.stateSpanDependencyCommand
          ? [block.stateSpanDependencyCommand.presentationTypeKey]
          : []
      )),
    );
    expect(commandTypes).toEqual(registryTypes);
  });

  it('does not offer a rim-light modulation lifecycle command', () => {
    const document = documentOf([
      {
        id: 'rim-start',
        time: 1,
        type: 'visualStyle',
        params: { scope: 'object', target: 'A', slot: 'rim-light', mode: 'set', color: '#ffffff' },
      },
    ]);
    const input = { sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] }, charId: 'A' };
    const available = listAvailableLifecycleTargetBindingCommandIds(document, 2, input);

    expect(available.has('visual.modulate-character-rim-light')).toBe(false);
    expect(available.has('visual.modulate-character-grounding')).toBe(false);
    expect(available.has('visual.modulate-character-integration')).toBe(false);

    const resolved = resolveLifecycleTargetBinding(document, 'visual.modulate-character-rim-light', 2, input);
    expect(resolved).toBeUndefined();
  });

  it('(a) binds transform inside a paired start–end window', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'exit-a', time: 10, type: 'characterPresence', params: { mode: 'exit', id: 'A' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(document, 'character.transform', 4, {
      sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] },
      charId: 'A',
    });
    expect(resolved?.targetStart.statementId).toBe('enter-a');
    expect(resolved?.statement).toMatchObject({
      type: 'characterTransform',
      params: { id: 'A' },
    });
    // Endable list would exclude this, but binding still works
    expect(listAvailableLifecycleTargetBindingCommandIds(document, 4, {
      sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] },
      charId: 'A',
    }).has('character.transform')).toBe(true);
  });

  it('binds transform at a peer-end boundary when inserted before the end', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'exit-a', time: 5, type: 'characterPresence', params: { mode: 'exit', id: 'A' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(
      document,
      'character.transform',
      5,
      { sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] }, charId: 'A' },
      new Set(['enter-a']),
    );
    expect(resolved?.targetStart.statementId).toBe('enter-a');
    expect(resolved?.beforeStatementId).toBe('exit-a');
  });

  it('(b) binds to superseded-open start between two starts', () => {
    const document = documentOf([
      { id: 'enter-a1', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'enter-a2', time: 5, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(document, 'character.transform', 3, {
      sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] },
      charId: 'A',
    });
    expect(resolved?.targetStart.statementId).toBe('enter-a1');
  });

  it('binds transform at a supersession boundary when inserted before the superseding start', () => {
    const document = documentOf([
      { id: 'enter-a1', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'enter-a2', time: 5, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(
      document,
      'character.transform',
      5,
      { sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] }, charId: 'A' },
      new Set(['enter-a1']),
    );
    expect(resolved?.targetStart.statementId).toBe('enter-a1');
    expect(resolved?.beforeStatementId).toBe('enter-a2');
  });

  it('(c) binds to the new start after replacement', () => {
    const document = documentOf([
      { id: 'enter-a1', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'enter-a2', time: 5, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(document, 'character.transform', 6, {
      sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] },
      charId: 'A',
    });
    expect(resolved?.targetStart.statementId).toBe('enter-a2');
  });

  it('(d) still binds when a future end exists (not endable, but active)', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'exit-a', time: 10, type: 'characterPresence', params: { mode: 'exit', id: 'A' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(document, 'character.transform', 5, {
      sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] },
      charId: 'A',
    });
    expect(resolved?.targetStart.statementId).toBe('enter-a');
    expect(resolved?.targetStart.status).toBe('paired');
  });

  it('prefers preferred start when multiple actives match', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'enter-b', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'B' } },
    ]);
    const resolved = resolveLifecycleTargetBinding(
      document,
      'character.transform',
      4,
      { sceneMeta: { title: 'Command', characters: [{ id: 'A', name: 'A' }] }, charId: 'A' },
      new Set(['enter-b']),
    );
    expect(resolved?.targetStart.statementId).toBe('enter-b');
    expect(resolved?.statement).toMatchObject({
      type: 'characterTransform',
      params: { id: 'B' },
    });
  });
});
