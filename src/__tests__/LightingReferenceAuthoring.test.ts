import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type LightingParams } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler, sceneStatementDefinitionRegistry, validateSemanticSceneStructure } from '../services/semantic-scene';
import { applyCharacterDirectoryCommandToCurrentSceneDocument } from '../services/character-directory/SemanticCharacterDirectory';
import { deriveLightingSnapshotAtTime } from '../engine/LightingSnapshot';
import { buildSemanticStatementLibraryInsert, prepareSemanticStatementLibraryMenu } from '../ui/timeline/semanticStatementInsertion';

function documentWith(effects: readonly LightingParams[], characterIds = ['hero']) {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'lighting-reference-authoring',
    meta: { title: 'Lighting references', characters: characterIds.map((id) => ({ id, name: id })) },
    statements: [
      { id: 'layer', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'hero', file: 'hero.png' } },
      ...effects.map((params, index) => ({ id: `effect-${index}`, time: index, type: 'lighting', params })),
    ],
  });
}

function lightingIssues(document: ReturnType<typeof documentWith>) {
  return validateSemanticSceneStructure(document).filter((issue) => issue.code?.includes('lighting'));
}

describe('lighting reference authoring contracts', () => {
  it.each([4, 5])('preserves prefixed legacy IDs from v%s through save, validation, compilation and reconstruction', (schemaVersion) => {
    const ids = ['character:hero', 'environmentLayer:hero', 'group:characters', 'group:environmentLayers'];
    const document = documentWith(ids.map((target) => ({ effect: 'post', mode: 'set', target, adjContrast: 2, durationSeconds: 0 })), ['hero', ...ids]);
    const admitted = sceneDocumentCodec.parseAndValidate({ ...document, schemaVersion });
    const reloaded = sceneDocumentCodec.parseAndValidate(JSON.parse(JSON.stringify(sceneDocumentCodec.prepareForSave(admitted))));
    expect(reloaded).toEqual(document);
    expect(lightingIssues(reloaded)).toEqual([]);
    const actions = sceneStatementCompiler.compile(reloaded).actions;
    const snapshot = deriveLightingSnapshotAtTime(10, actions.map((action) => ({ ...action, _id: action.id })));
    expect(Object.keys(snapshot.postProcessingTargets).sort()).toEqual(ids.map((id) => `character:${id}`).sort());
    for (const state of Object.values(snapshot.postProcessingTargets)) expect(state.adjContrast).toBe(2);
  });

  it.each([3, 4])('rejects structured targets in historical scene v%s before migration', (schemaVersion) => {
    const document = documentWith([{ effect: 'blur', mode: 'set', target: { kind: 'character', id: 'hero' } }]);
    expect(() => sceneDocumentCodec.parseAndValidate({ ...document, schemaVersion })).toThrow('Structured lighting targets require scene schemaVersion 5');
  });

  it.each(['blur', 'post'] as const)('renames every scoped %s lifecycle reference and preserves environment/group targets', (effect) => {
    let authoringDocument = documentWith([]);
    const drafts: LightingParams[] = [];
    for (const [index, mode] of (['set', 'modulate', 'reset'] as const).entries()) {
      const result = buildSemanticStatementLibraryInsert({
        blockId: mode === 'set' ? `lighting.${effect}` : `lighting.${mode}-${effect}`,
        document: authoringDocument,
        sceneMeta: authoringDocument.meta,
        anchorTime: index + 1,
        origin: 'timeline-list-gap',
        scope: { kind: 'character', charId: 'hero' },
      });
      if (result.kind !== 'intent' || result.intent.statement.type !== 'lighting') throw new Error('Expected a lighting insertion');
      drafts.push(sceneStatementDefinitionRegistry.parseParams('lighting', result.intent.statement.params, 'inserted.params'));
      authoringDocument = sceneDocumentCodec.parseAndValidate({
        ...authoringDocument,
        statements: [...authoringDocument.statements, { ...result.intent.statement, id: `authored-${index}`, time: index + 1 }],
      });
    }
    const document = documentWith([
      ...drafts,
      { effect, mode: 'set', target: { kind: 'environmentLayer', id: 'hero' } },
      { effect, mode: 'set', target: { kind: 'group', group: 'characters' } },
    ]);
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(document, {
      kind: 'update-character-id', origin: 'workspace-tools-panel', currentCharId: 'hero', nextCharId: 'group:characters',
    });
    expect(result.receipt.affectedStatementIds).toEqual(['effect-0', 'effect-1', 'effect-2']);
    expect(result.document.statements.slice(1, 4).map((statement) => statement.params)).toEqual(
      drafts.map((params) => ({ ...params, target: { kind: 'character', id: 'group:characters' } })),
    );
    expect(result.document.statements.slice(4)).toEqual(document.statements.slice(4));
    expect(lightingIssues(result.document)).toEqual([]);
    expect(document.meta.characters?.[0].id).toBe('hero');
    expect(sceneStatementCompiler.compile(result.document).actions.filter((action) => action.action.includes(effect === 'blur' ? 'Blur' : 'PostProcessing')).slice(0, 3).map((action) => action.params.target))
      .toEqual(Array(3).fill('character:group:characters'));
  });

  it.each(['blur', 'post'] as const)('rewrites a legacy raw %s reference safely when renamed to a reserved scope name', (effect) => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(documentWith([{ effect, mode: 'set', target: 'hero' }]), {
      kind: 'update-character-id', origin: 'workspace-tools-panel', currentCharId: 'hero', nextCharId: 'characters',
    });
    expect(result.document.statements[1].params).toMatchObject({ target: { kind: 'character', id: 'characters' } });
    expect(lightingIssues(result.document)).toEqual([]);
    expect(sceneStatementCompiler.compile(result.document).actions[1].params.target).toBe('character:characters');
  });

  it.each(['blur', 'post'] as const)('uses the row target for both %s availability and insertion despite cross-row selections', (effect) => {
    const document = documentWith([
      { effect, mode: 'set', target: { kind: 'character', id: 'hero' } },
      { effect, mode: 'set', target: { kind: 'character', id: 'friend' } },
    ], ['hero', 'friend']);
    for (const preferred of [new Set(['effect-0']), new Set(['effect-0', 'effect-1'])]) {
      const options = {
        document, sceneMeta: document.meta, anchorTime: 2,
        origin: 'blank-context-menu' as const,
        scope: { kind: 'inferred-character' as const, charId: 'friend', source: 'blank-menu-track' as const },
        preferredLifecycleStartStatementIds: preferred,
      };
      const menu = prepareSemanticStatementLibraryMenu(options);
      for (const mode of ['modulate', 'reset']) {
        const blockId = `lighting.${mode}-${effect}`;
        expect(mode === 'reset' ? menu.availableLifecycleEndCommandIds.has(blockId) : menu.availableLifecycleTargetBindingCommandIds.has(blockId)).toBe(true);
        expect(menu.resolve(blockId)).toMatchObject({ kind: 'intent', intent: { statement: { params: { effect, mode, target: { kind: 'character', id: 'friend' } } } } });
        expect(buildSemanticStatementLibraryInsert({ ...options, blockId })).toMatchObject({ kind: 'intent', intent: { statement: { params: { target: { kind: 'character', id: 'friend' } } } } });
      }
    }
  });

  it.each([
    ['blur', false], ['blur', true], ['post', false], ['post', true],
  ] as const)('preserves selected per-layer %s on the shared environment row (group lifecycle: %s)', (effect, hasGroupLifecycle) => {
    for (const target of ['hero', { kind: 'environmentLayer', id: 'hero' }] as const) {
      const effects: LightingParams[] = [
        { effect, mode: 'set', target: { kind: 'character', id: 'friend' } },
        { effect, mode: 'set', target },
      ];
      if (hasGroupLifecycle) effects.push({ effect, mode: 'set', target: { kind: 'group', group: 'environmentLayers' } });
      const document = documentWith(effects, typeof target === 'string' ? ['friend'] : ['hero', 'friend']);
      const options = {
        document, sceneMeta: document.meta, anchorTime: 3,
        origin: 'blank-context-menu' as const,
        scope: { kind: 'none' as const },
        lightingTarget: { kind: 'group' as const, group: 'environmentLayers' as const },
        preferredLifecycleStartStatementIds: new Set(['effect-0', 'effect-1']),
      };
      const menu = prepareSemanticStatementLibraryMenu(options);
      for (const mode of ['modulate', 'reset']) {
        const blockId = `lighting.${mode}-${effect}`;
        expect(mode === 'reset' ? menu.availableLifecycleEndCommandIds.has(blockId) : menu.availableLifecycleTargetBindingCommandIds.has(blockId)).toBe(true);
        const expected = { kind: 'intent', intent: { statement: { type: 'lighting', params: { effect, mode, target } } } };
        expect(menu.resolve(blockId)).toMatchObject(expected);
        expect(buildSemanticStatementLibraryInsert({ ...options, blockId })).toMatchObject(expected);
      }
    }
  });
});
