import { describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';
import { createSemanticTimelineCommands, selectCreatedTimelineStatements } from '../ui/timeline/semanticTimelineCommands';
import { readSemanticTimelineSnapshot } from '../ui/timeline/useSemanticTimelineSnapshot';

function document(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'commands',
    meta: { title: 'Commands', characters: [{ id: 'alice', name: 'Alice' }] },
    statements: [
      { id: 'first', time: 0, type: 'dialogue', params: { text: 'First', durationSeconds: 2 },
        companions: [{ id: 'performance', type: 'characterPerformance', anchor: 'start', offset: 0,
          params: { target: 'alice', motion: '' } }] },
      { id: 'second', time: 5, type: 'dialogue', params: { text: 'Second', durationSeconds: 2 } },
      { id: 'last', time: 10, type: 'dialogue', params: { text: 'Last', durationSeconds: 2 } },
    ],
  };
}

async function harness() {
  const store = new DocumentStore();
  const project = vi.fn(async () => {});
  const coordinator = new SemanticDocumentCoordinator(store, new SemanticScenePipeline({
    resolveAsset: async (source) => `asset://test/${source}`,
  }), { projectPreparedScene: project });
  await coordinator.applyDocument(document());
  const preferences = { mode: 'manual' as 'auto' | 'manual', offline: false };
  const authoring = new SemanticAuthoringApplicationService(store, coordinator, undefined, undefined, {
    getDialogueFlowMode: () => preferences.mode,
  });
  const select = vi.fn();
  const onError = vi.fn();
  const commands = createSemanticTimelineCommands({
    store, authoring, select, onError, blockOffline: () => preferences.offline,
  });
  const snapshot = () => readSemanticTimelineSnapshot(store);
  const id = (statementId: string, companionId?: string) => snapshot().items.find((item) => (
    item.statementId === statementId && item.companionId === companionId
  ))!.id;
  return { store, authoring, commands, preferences, select, onError, project, snapshot, id };
}

describe('semantic timeline commands', () => {
  it('selects display roots consistently for compiled and uncompiled statements', async () => {
    const { store, snapshot, id } = await harness();
    const items = snapshot().items;
    const root = items.find((item) => item.statementId === 'first' && !item.companionId)!;
    const companion = items.find((item) => item.companionId === 'performance')!;
    expect(companion.parentItemId).toBe(root.id);
    expect(companion.locator).toEqual({ kind: 'companion', statementId: 'first', companionId: 'performance' });
    expect(selectCreatedTimelineStatements(store, ['first'])).toEqual({ [id('first')]: true });
    expect(selectCreatedTimelineStatements(store, ['first'])).not.toHaveProperty(companion.id);

    const source = store.getCurrentSceneDocumentSnapshot()!;
    store._replaceCurrentSceneDocumentSnapshot({ ...source, statements: [...source.statements,
      { id: 'placeholder', time: 20, type: 'characterPerformance', params: { target: 'alice', motion: '' } },
    ] });
    expect(selectCreatedTimelineStatements(store, ['placeholder'])).toEqual({ placeholder: true });
  });

  it('selects a newly added dialogue once after it is committed', async () => {
    const { commands, store, select } = await harness();
    const receipt = await commands.addDialogue(12.34);
    expect(receipt?.createdStatementIds).toHaveLength(1);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => (
      item.id === receipt!.createdStatementIds[0]
    ))?.time).toBe(12.3);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(selectCreatedTimelineStatements(store, receipt!.createdStatementIds));
  });

  it('duplicates roots with their companions and selects only the created root', async () => {
    const { commands, store, select, id } = await harness();
    const receipt = await commands.duplicate([id('first'), id('first', 'performance')]);
    const created = store.getCurrentSceneDocumentSnapshot()?.statements.find((item) => (
      item.id === receipt!.createdStatementIds[0]
    ));
    expect(created?.companions).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(Object.keys(select.mock.calls[0][0])).toHaveLength(1);
  });

  it('pastes copied semantic roots through the same post-commit selection rule', async () => {
    const { commands, store, select, id } = await harness();
    const copied = commands.copy([id('first')]);
    expect(copied).toHaveLength(1);
    expect(copied[0].companions).toHaveLength(1);
    const receipt = await commands.paste(copied, 15, 'timeline-list-gap');
    expect(receipt?.createdStatementIds).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(selectCreatedTimelineStatements(store, receipt!.createdStatementIds));
  });

  it('merges queued root and companion patches against the latest source params', async () => {
    const { commands, store, id, select, onError } = await harness();
    const rootId = id('first');
    const companionLocator = { kind: 'companion' as const, statementId: 'first', companionId: 'performance' };
    await Promise.all([
      commands.updateSourceParams(rootId, { text: 'Quick edit' }),
      commands.updateSourceParams(rootId, (params) => ({ text: `${params.text} + inspector`, durationSeconds: 3 })),
      commands.updateSourceParams(companionLocator, { expression: 'smile' }),
      commands.updateSourceParams(companionLocator, { motion: { kind: 'resource', key: 'wave' } }),
    ]);
    const first = store.getCurrentSceneDocumentSnapshot()!.statements[0];
    expect(first.params).toMatchObject({ text: 'Quick edit + inspector', durationSeconds: 3 });
    expect(first.companions?.[0].params).toEqual({ target: 'alice', expression: 'smile', motion: { kind: 'resource', key: 'wave' } });
    expect(select).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('merges queued runtime-shaped patches without discarding another edit', async () => {
    const { commands, store, id, onError } = await harness();
    const rootId = id('first');
    await Promise.all([
      commands.updateTimelineParams(rootId, { text: 'Runtime text' }),
      commands.updateTimelineParams(rootId, { duration: 4 }),
    ]);
    expect(store.getCurrentSceneDocumentSnapshot()!.statements[0].params).toMatchObject({ text: 'Runtime text', durationSeconds: 4 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('applies full-form changes relative to the displayed snapshot without reverting queued quick edits', async () => {
    const { commands, store, snapshot, onError } = await harness();
    const root = snapshot().items.find((item) => item.statementId === 'first' && !item.companionId)!;
    const displayed = root.source.params as Record<string, unknown>;
    await Promise.all([
      commands.updateSourceParams(root.locator, { text: 'Quick edit' }),
      commands.replaceSourceParams(root.locator, { ...displayed, durationSeconds: 4 }, displayed),
    ]);
    expect(store.getCurrentSceneDocumentSnapshot()!.statements[0].params).toMatchObject({ text: 'Quick edit', durationSeconds: 4 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('supports replacement and explicit field removal for companions', async () => {
    const { commands, store, id } = await harness();
    const companionId = id('first', 'performance');
    const locator = { kind: 'companion' as const, statementId: 'first', companionId: 'performance' };
    await commands.updateSourceParams(companionId, { target: 'alice', motion: '', expression: 'smile' }, true);
    await commands.updateSourceParams(locator, { expression: undefined });
    expect(store.getCurrentSceneDocumentSnapshot()!.statements[0].companions?.[0].params).toEqual({ target: 'alice', motion: '' });
  });

  it('blocks all mutations offline while still allowing copy', async () => {
    const { commands, authoring, preferences, select, id } = await harness();
    const author = vi.spyOn(authoring, 'author');
    const transaction = vi.spyOn(authoring, 'authorTransaction');
    const rootId = id('first');
    const copied = commands.copy([rootId]);
    preferences.offline = true;
    await commands.addDialogue(12);
    await commands.duplicate([rootId]);
    await commands.paste(copied, 12);
    await commands.insert({ version: AUTHORING_SCHEMA_VERSION, correlationId: 'offline', origin: 'timeline-editor', kind: 'duplicate-statements', statementIds: ['first'] });
    await commands.delete([rootId]);
    await commands.updateSourceParams(rootId, { text: 'Blocked' });
    await commands.updateTimelineParams(rootId, { text: 'Blocked' });
    expect(commands.copy([rootId])).toEqual(copied);
    expect(author).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps source and selection when a mixed deletion transaction fails, then permits retry', async () => {
    const { commands, store, project, id, select, onError } = await harness();
    const before = store.getCurrentSceneDocumentSnapshot();
    const ids = [id('second'), id('first', 'performance')];
    project.mockRejectedValueOnce(new Error('Projection failed'));
    await commands.delete(ids);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(select).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Projection failed' }));
    await commands.delete(ids);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements.map((item) => item.id)).toEqual(['first', 'last']);
    expect(store.getCurrentSceneDocumentSnapshot()?.statements[0].companions ?? []).toHaveLength(0);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({});
  });

  it('retains selection for unavailable and no-op commands', async () => {
    const { commands, select } = await harness();
    await commands.delete(['missing']);
    await commands.duplicate([]);
    await commands.paste([], 0);
    await commands.updateSourceParams('missing', { text: 'Missing' });
    expect(select).not.toHaveBeenCalled();
  });

  it.each(['auto', 'manual'] as const)('uses the commit-time %s preference for single and batch deletion', async (mode) => {
    for (const statementIds of [['first'], ['first', 'second']]) {
      const { commands, preferences, store, id, select } = await harness();
      const pending = commands.delete(statementIds.map((statementId) => id(statementId)));
      // The serial authoring queue has not begun this commit yet.
      preferences.mode = mode;
      await pending;
      const last = store.getCurrentSceneDocumentSnapshot()!.statements.find((item) => item.id === 'last')!;
      expect(last.time).toBe(mode === 'manual' ? 10 : statementIds.length === 1 ? 7.5 : 5);
      expect(select).toHaveBeenCalledTimes(1);
    }
  });
});
