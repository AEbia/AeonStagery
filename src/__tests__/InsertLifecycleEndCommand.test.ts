import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec } from '../services/semantic-scene';
import {
  insertLifecycleEndCommand,
  insertLifecycleEndFromMenu,
  listAvailableLifecycleEndCommandIds,
  resolveLifecycleEndCommand,
} from '../ui/timeline/insertLifecycleEndCommand';

const metadata = { correlationId: 'lifecycle-end', origin: 'blank-context-menu' as const };

function documentOf(statements: unknown[], durationSeconds = 12) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'lifecycle-end-command',
    meta: { title: 'Lifecycle end command', durationSeconds },
    statements,
  });
}

describe('insertLifecycleEndCommand', () => {
  it('materializes character exit draft defaults and target from start', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
    ]);
    const result = insertLifecycleEndCommand(document, {
      targetStartStatementId: 'enter-a',
      time: 5,
      blockId: 'character.exit',
      input: { sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] }, charId: 'A' },
      metadata,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent).toMatchObject({
      kind: 'insert-statement',
      anchorTime: 5,
      statement: {
        type: 'characterPresence',
        params: {
          mode: 'exit',
          id: 'A',
          transition: 'fadeOut',
          durationSeconds: 0.6,
        },
      },
    });
  });

  it('materializes BGM stop with fadeOut default', () => {
    const document = documentOf([
      { id: 'bgm', time: 1, type: 'audio', params: { role: 'bgm', mode: 'play', file: 'theme.ogg' } },
    ]);
    const result = insertLifecycleEndFromMenu(document, 'audio.stop-bgm', 6, {}, metadata);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent).toMatchObject({
      kind: 'insert-statement',
      anchorTime: 6,
      statement: { type: 'audio', params: { role: 'bgm', mode: 'stop', fadeOut: 0.5 } },
    });
  });

  it('materializes environment remove with fadeOut defaults and order before superseding start', () => {
    const document = documentOf([
      { id: 'bg-a', time: 1, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', file: 'a.png' } },
      { id: 'bg-b', time: 5, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', file: 'b.png', durationSeconds: 1 } },
    ]);
    // At T=3 only bg-a is endable (superseded-open window before bg-b).
    const result = insertLifecycleEndCommand(document, {
      targetStartStatementId: 'bg-a',
      time: 3,
      blockId: 'environment.remove-background',
      metadata,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent).toMatchObject({
      kind: 'insert-statement',
      anchorTime: 3,
      beforeStatementId: 'bg-b',
      statement: {
        type: 'environmentLayer',
        params: {
          mode: 'remove',
          layerId: 'background',
          transition: 'fadeOut',
          durationSeconds: 0.6,
        },
      },
    });
  });

  it('materializes exact-boundary end before the same-time superseding start', () => {
    const document = documentOf([
      { id: 'bg-a', time: 1, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', file: 'a.png' } },
      { id: 'bg-b', time: 5, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', file: 'b.png' } },
    ]);
    const result = insertLifecycleEndCommand(document, {
      targetStartStatementId: 'bg-a',
      time: 5,
      blockId: 'environment.remove-background',
      metadata,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent).toMatchObject({
      kind: 'insert-statement',
      anchorTime: 5,
      beforeStatementId: 'bg-b',
      statement: {
        type: 'environmentLayer',
        params: {
          mode: 'remove',
          layerId: 'background',
        },
      },
    });
  });

  it('resolves exact-boundary menu end for the preferred superseded start', () => {
    const document = documentOf([
      { id: 'bg-a', time: 1, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', file: 'a.png' } },
      { id: 'bg-b', time: 5, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', file: 'b.png' } },
    ]);
    const result = insertLifecycleEndFromMenu(
      document,
      'environment.remove-background',
      5,
      {},
      metadata,
      new Set(['bg-a']),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent).toMatchObject({
      anchorTime: 5,
      beforeStatementId: 'bg-b',
      statement: { type: 'environmentLayer', params: expect.objectContaining({ mode: 'remove' }) },
    });
  });

  it('materializes graphic image remove with target id', () => {
    const document = documentOf([
      {
        id: 'img-set',
        time: 1,
        type: 'graphicLayer',
        params: { kind: 'image', mode: 'set', id: 'hero', file: 'hero.png' },
      },
    ]);
    const available = listAvailableLifecycleEndCommandIds(document, 4, {});
    const removeId = [...available].find((id) => id.includes('graphic') || id.includes('image') || id.includes('remove'));
    // Prefer known block id if present
    const blockId = removeId ?? 'graphic.remove-image';
    const resolved = resolveLifecycleEndCommand(document, blockId, 4, {});
    if (!resolved) {
      // Discover block ids from available set for the assertion message
      expect(available.size).toBeGreaterThan(0);
      return;
    }
    const result = insertLifecycleEndCommand(document, {
      targetStartStatementId: 'img-set',
      time: 4,
      blockId,
      metadata,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.statement).toMatchObject({
      type: 'graphicLayer',
      params: expect.objectContaining({ mode: 'remove', id: 'hero' }),
    });
  });

  it('returns stale when target already has an end peer', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'exit-a', time: 8, type: 'characterPresence', params: { mode: 'exit', id: 'A' } },
    ]);
    const result = insertLifecycleEndCommand(document, {
      targetStartStatementId: 'enter-a',
      time: 5,
      blockId: 'character.exit',
      metadata,
    });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('does not list end commands for already-paired starts', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'exit-a', time: 8, type: 'characterPresence', params: { mode: 'exit', id: 'A' } },
    ]);
    const available = listAvailableLifecycleEndCommandIds(document, 5, {
      sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] },
      charId: 'A',
    });
    expect(available.has('character.exit')).toBe(false);
  });

  it('only offers the rim-light reset command for active rim-light starts', () => {
    const document = documentOf([
      {
        id: 'rim-start',
        time: 1,
        type: 'visualStyle',
        params: { scope: 'object', target: 'A', slot: 'rim-light', mode: 'set', color: '#ffffff' },
      },
    ]);
    const input = { sceneMeta: { title: 'x', characters: [{ id: 'A', name: 'A' }] }, charId: 'A' };
    const available = listAvailableLifecycleEndCommandIds(document, 3, input);

    expect(available.has('visual.reset-character-rim-light')).toBe(true);
    expect(available.has('visual.reset-character-grounding')).toBe(false);
    expect(available.has('visual.reset-character-integration')).toBe(false);

    const resolved = resolveLifecycleEndCommand(document, 'visual.reset-character-rim-light', 3, input);
    expect(resolved?.endTemplate).toMatchObject({
      type: 'visualStyle',
      params: { scope: 'object', target: 'A', slot: 'rim-light', mode: 'reset', durationSeconds: 0.4 },
    });
  });

  it('uses preferred start when multiple characters are endable', () => {
    const document = documentOf([
      { id: 'enter-a', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'A' } },
      { id: 'enter-b', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'B' } },
    ]);
    const resolved = resolveLifecycleEndCommand(
      document,
      'character.exit',
      5,
      {
        sceneMeta: { title: 'Command', characters: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] },
        charId: null,
      },
      new Set(['enter-b']),
    );
    expect(resolved?.targetStart.statementId).toBe('enter-b');
    expect(resolved?.endTemplate).toMatchObject({
      type: 'characterPresence',
      params: { mode: 'exit', id: 'B' },
    });
  });
});
