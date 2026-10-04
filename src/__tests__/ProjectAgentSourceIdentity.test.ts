import { describe, expect, it } from 'vitest';
import { ProjectAgentSourceIdentityFacade } from '../services/project-agent/ProjectAgentSourceIdentity';
import { createProjectAgentBenchmarkScene } from '../services/project-agent-benchmark/ProjectAgentBenchmarkFixture';
import { ProjectAgentTaskState } from '../services/project-agent/ProjectAgentTaskState';
import { ProjectAgentWriteTools } from '../services/project-agent/ProjectAgentWriteTools';
import type { ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';

describe('ProjectAgentSourceIdentityFacade', () => {
  it('projects existing root and parent-local companion identities without creating aliases', () => {
    const facade = new ProjectAgentSourceIdentityFacade(createProjectAgentBenchmarkScene());
    expect(facade.resolveStatement('dlg_update_target')).toMatchObject({ ok: true, statementId: 'dlg_update_target' });
    expect(facade.resolveCompanion('dlg_update_target', 'dlg_update_target_cmp')).toMatchObject({ ok: true, statementId: 'dlg_update_target', companionId: 'dlg_update_target_cmp' });
    expect(facade.resolveCompanion('dlg_downstream', 'dlg_update_target_cmp')).toEqual({ ok: false, code: 'source_identity_not_found' });
  });

  it('derives identities fresh from the source snapshot so deletion ends the identity lifecycle', () => {
    const document = createProjectAgentBenchmarkScene();
    document.statements = document.statements.filter((statement) => statement.id !== 'dlg_update_target');
    const facade = new ProjectAgentSourceIdentityFacade(document);
    expect(facade.resolveStatement('dlg_update_target')).toEqual({ ok: false, code: 'source_identity_not_found' });
    expect(facade.project().some((line) => line.statementId === 'dlg_update_target')).toBe(false);
  });
});

describe('Project Agent root source-identity authoring', () => {
  function createHarness() {
    let document = createProjectAgentBenchmarkScene();
    let version = 1;
    const ports: ProjectAgentWritePorts = {
      scene: { getSnapshot: () => ({ document, version }) },
      validation: { validate: () => [] },
      authoring: {
        commit: (request) => {
          document = request.candidate;
          version += 1;
          return { version };
        },
      },
    };
    const taskState = new ProjectAgentTaskState();
    taskState.bindSceneRead(document, version);
    return {
      document: () => document,
      version: () => version,
      tools: new ProjectAgentWriteTools({ ports, taskState }),
    };
  }

  it('updates a root statement by its existing statementId', async () => {
    const harness = createHarness();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_update_target',
      patch: { params: { text: 'Updated by identity' } },
    });

    expect(result.ok).toBe(true);
    expect(harness.document().statements.find((statement) => statement.id === 'dlg_update_target'))
      .toMatchObject({ params: { text: 'Updated by identity' } });
  });

  it('orders an inserted root by a same-time beforeStatementId and moves roots by absolute time', async () => {
    const harness = createHarness();
    const initial = harness.document();
    const sameTimeAnchor = initial.statements.find((statement) => statement.type === 'dialogue')?.id;
    expect(sameTimeAnchor).toBeDefined();

    const inserted = await harness.tools.insertStatement({
      time: 1,
      beforeStatementId: sameTimeAnchor,
      statement: { type: 'camera', params: { mode: 'reset', durationSeconds: 0 } },
    });
    expect(inserted.ok).toBe(true);
    if (inserted.ok) {
      expect(inserted.data.outcomes).toHaveLength(1);
      expect(inserted.data.outcomes[0]).toMatchObject({ kind: 'inserted' });
      expect((inserted.data.outcomes[0] as { statementId?: string } | undefined)?.statementId)
        .toBeDefined();
    }
    expect(harness.document().statements[1]?.type).toBe('camera');
    expect(harness.document().statements[2]?.id).toBe(sameTimeAnchor);

    const moved = await harness.tools.moveSourceItem({
      statementId: sameTimeAnchor!, time: 9.5,
    });
    expect(moved.ok).toBe(true);
    expect(harness.document().statements.find((statement) => statement.id === sameTimeAnchor)?.time)
      .toBe(9.5);
  });

  it('retains a root identity through family replacement', async () => {
    const harness = createHarness();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_update_target',
      patch: { type: 'camera', params: { mode: 'reset', durationSeconds: 0 } },
    });

    expect(result.ok).toBe(true);
    expect(harness.document().statements.find((statement) => statement.id === 'dlg_update_target'))
      .toMatchObject({ id: 'dlg_update_target', type: 'camera' });
  });

  it('resolves all transaction identities from the initial snapshot', async () => {
    const harness = createHarness();
    const result = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        {
          kind: 'insertStatement',
          time: 0,
          statement: { type: 'camera', params: { mode: 'reset', durationSeconds: 0 } },
        },
        {
          kind: 'updateStatement',
          statementId: 'agent-inserted-id-is-not-an-alias',
          patch: { params: { mode: 'push', zoom: 1.2 } },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'source_identity_not_found', suggestedAction: 'call_readScene' },
    });
    expect(harness.version()).toBe(1);
  });

  it('does not guess when a root statement identity is absent', async () => {
    const harness = createHarness();
    const result = await harness.tools.deleteSourceItem({ statementId: 'missing_statement' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'source_identity_not_found', suggestedAction: 'call_readScene' },
    });
    expect(harness.version()).toBe(1);
  });

  it('authors companions through their composite source identity', async () => {
    const harness = createHarness();
    const inserted = await harness.tools.insertCompanion({
      statementId: 'dlg_update_target',
      beforeCompanionId: 'dlg_update_target_cmp',
      companion: {
        anchor: 'end', offset: 0.25, type: 'characterPerformance',
        params: { target: 'tomori', motion: 'wave' },
      },
    });
    expect(inserted.ok).toBe(true);
    if (inserted.ok) {
      expect(inserted.data.outcomes).toHaveLength(1);
      expect(inserted.data.outcomes[0]).toMatchObject({
        kind: 'inserted',
        statementId: 'dlg_update_target',
      });
      expect(typeof (inserted.data.outcomes[0] as { companionId?: string }).companionId).toBe('string');
    }
    const parent = harness.document().statements.find((statement) => statement.id === 'dlg_update_target')!;
    const insertedCompanion = parent.companions?.find((companion) => (
      companion.type === 'characterPerformance'
        && typeof companion.params.motion === 'object'
        && companion.params.motion.kind === 'resource'
        && companion.params.motion.key === 'wave'
    ));
    expect(insertedCompanion).toBeDefined();

    const updated = await harness.tools.updateCompanion({
      statementId: 'dlg_update_target', companionId: insertedCompanion!.id,
      patch: { params: { motion: 'smile' } },
    });
    expect(updated.ok).toBe(true);

    const moved = await harness.tools.moveSourceItem({
      statementId: 'dlg_update_target', companionId: insertedCompanion!.id,
      anchor: 'start', offset: 0.5,
    });
    expect(moved.ok).toBe(true);
    expect(harness.document().statements.find((statement) => statement.id === 'dlg_update_target')?.companions)
      .toContainEqual(expect.objectContaining({ id: insertedCompanion!.id, anchor: 'start', offset: 0.5 }));
  });

  it('rejects cross-parent and partial companion reorder identities atomically', async () => {
    const harness = createHarness();
    const result = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [{
        kind: 'reorderCompanions',
        statementId: 'dlg_update_target',
        orderedCompanionIds: ['dlg_update_target_cmp', 'dlg_downstream_cmp'],
      }],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'source_identity_not_found' } });
    expect(harness.version()).toBe(1);

    const missing = await harness.tools.updateCompanion({
      statementId: 'dlg_downstream', companionId: 'dlg_update_target_cmp',
      patch: { params: { motion: 'smile' } },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'source_identity_not_found', suggestedAction: 'call_readScene' } });
  });

  it('reorders a complete sibling set and rejects companion timing patches', async () => {
    const harness = createHarness();
    const inserted = await harness.tools.insertCompanion({
      statementId: 'dlg_update_target',
      companion: {
        anchor: 'end', offset: 0.2, type: 'characterPerformance',
        params: { target: 'tomori', motion: 'wave' },
      },
    });
    expect(inserted.ok).toBe(true);
    const parent = harness.document().statements.find((statement) => statement.id === 'dlg_update_target')!;
    const secondCompanionId = parent.companions!.find((companion) => (
      companion.type === 'characterPerformance'
        && typeof companion.params.motion === 'object'
        && companion.params.motion.kind === 'resource'
        && companion.params.motion.key === 'wave'
    ))!.id;

    const reordered = await harness.tools.reorderCompanions({
      statementId: 'dlg_update_target',
      orderedCompanionIds: [secondCompanionId, 'dlg_update_target_cmp'],
    });
    expect(reordered.ok).toBe(true);
    expect(harness.document().statements.find((statement) => statement.id === 'dlg_update_target')?.companions)
      .toMatchObject([{ id: secondCompanionId }, { id: 'dlg_update_target_cmp' }]);

    const timingPatch = await harness.tools.updateCompanion({
      statementId: 'dlg_update_target', companionId: 'dlg_update_target_cmp', patch: { anchor: 'start' },
    });
    expect(timingPatch).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  });
});
