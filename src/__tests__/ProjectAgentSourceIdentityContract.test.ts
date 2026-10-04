import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CharacterPerformanceParams,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';
import { ProjectAgentTaskState } from '../services/project-agent/ProjectAgentTaskState';
import { ProjectAgentWriteTools } from '../services/project-agent/ProjectAgentWriteTools';
import { ProjectAgentSourceIdentityFacade } from '../services/project-agent/ProjectAgentSourceIdentity';
import {
  applySemanticScenePatch,
  parseSemanticScenePatch,
} from '../services/semantic-scene/SemanticScenePatch';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../api/types/semantic-scene-patch';

/**
 * Contract inventory (ADR0024): the old line-addressed Project Agent write
 * fields and stale-line behavior are unreachable in the source-identity
 * toolset, while the shared line-based semantic patch contract consumed by
 * acting/cinematic processors remains operational.
 */

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_contract',
    meta: {
      title: 'Contract Scene',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'First', durationSeconds: 2 },
        companions: [
          {
            id: 'cmp_a',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'wave' } },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 0,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
    ],
  };
}

function createRegistry(): ProjectAgentToolRegistry {
  let document = makeDocument();
  let version = 1;
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }),
    },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: ['x'], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({
        exists: true,
        reference,
        scope: 'project',
        bindable: true,
      }),
    },
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
  };
  const writePorts: ProjectAgentWritePorts = {
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
  return new ProjectAgentToolRegistry({ readPorts, writePorts });
}

function createWriteTools() {
  let document = makeDocument();
  let version = 5;
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
  const tools = new ProjectAgentWriteTools({ ports, taskState });
  taskState.bindSceneRead(document, version);
  return { tools, taskState, get document() { return document; } };
}

describe('Project Agent source-identity contract inventory (ADR0024)', () => {
  it('registers the fixed source-identity toolset and no line-addressed write tools', () => {
    const names = new Set(createRegistry().listTools().map((tool) => tool.name));
    expect((['insertStatement', 'insertCompanion', 'updateStatement', 'updateCompanion',
      'deleteSourceItem', 'moveSourceItem', 'reorderCompanions', 'applyAuthoringTransaction'] as const)
      .every((name) => names.has(name))).toBe(true);
    // The legacy line-addressed tools are not part of the type union either.
    expect((names as Set<string>).has('deleteLine')).toBe(false);
    expect((names as Set<string>).has('moveLine')).toBe(false);
    expect((names as Set<string>).has('applySceneOperation')).toBe(false);
  });

  it('rejects line locators in single-tool write arguments at the schema boundary', async () => {
    const registry = createRegistry();
    const read = await registry.call('readScene', { startLine: 1, lineCount: 20 });
    expect(read.ok).toBe(true);

    const lineAddressed = await registry.call('updateStatement', {
      // @ts-expect-error — line locators must not exist in the new toolset
      line: 2,
      patch: { params: { text: 'Nope' } },
    });
    expect(lineAddressed.ok).toBe(false);
    if (!lineAddressed.ok) expect(lineAddressed.error.code).toBe('invalid_arguments');

    const lineDelete = await registry.call('deleteSourceItem', {
      // @ts-expect-error — line locators must not exist in the new toolset
      line: 1,
    });
    expect(lineDelete.ok).toBe(false);
    if (!lineDelete.ok) expect(lineDelete.error.code).toBe('invalid_arguments');

    const lineMove = await registry.call('moveSourceItem', {
      // @ts-expect-error — line locators must not exist in the new toolset
      line: 1,
      time: 5,
    });
    expect(lineMove.ok).toBe(false);
    if (!lineMove.ok) expect(lineMove.error.code).toBe('invalid_arguments');
  });

  it('rejects line locators inside explicit transactions before any resolution', async () => {
    const facade = new ProjectAgentSourceIdentityFacade(makeDocument());
    const resolved = facade.resolveRootOperations([{
      kind: 'updateStatement',
      statementId: 'dlg_1',
      // @ts-expect-error — line locators must not exist in the new toolset
      line: 2,
      patch: { params: { text: 'X' } },
    }]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.diagnostic.code).toBe('invalid_arguments');
  });

  it('never returns stale_line_map; stale identities recover via source_identity_not_found', async () => {
    const { tools } = createWriteTools();
    // Structural delete succeeds...
    const deleted = await tools.deleteSourceItem({ statementId: 'cam_1' });
    expect(deleted.ok).toBe(true);
    // ...then the removed identity is unreachable: retryable source_identity_not_found,
    // never a stale-line map error and never a fuzzy line fallback.
    const stale = await tools.updateStatement({
      statementId: 'cam_1',
      patch: { params: { text: 'Stale' } },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('source_identity_not_found');
      expect(stale.error.retryable).toBe(true);
      expect(stale.error.suggestedAction).toBe('call_readScene');
    }
    // The same holds inside an explicit transaction, which stays uncommitted.
    const tx = await tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'OK' } } },
        { kind: 'deleteSourceItem', statementId: 'cam_1' },
      ],
    });
    expect(tx.ok).toBe(false);
    if (!tx.ok) expect(tx.error.code).toBe('source_identity_not_found');
  });

  it('keeps the shared line-based patch contract operational for acting/cinematic processors', () => {
    const document = makeDocument();
    const view = new SemanticSceneLineView(document);
    const dlgLine = view.lines.findIndex((item) => item.kind === 'statement' && item.type === 'dialogue') + 1;
    const camLine = view.lines.findIndex((item) => item.kind === 'statement' && item.type === 'camera') + 1;
    expect(dlgLine).toBeGreaterThan(0);
    expect(camLine).toBeGreaterThan(0);

    // Acting/cinematic processors still author through the line-based
    // SemanticScenePatchV1 algebra with parentLine/line/orderedLines locators.
    const applied = applySemanticScenePatch(document, parseSemanticScenePatch({
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [
        { kind: 'updateStatement', line: dlgLine, patch: { params: { text: 'Processor edit' } } },
        { kind: 'moveLine', line: camLine, time: 4 },
        { kind: 'reorderCompanions', parentLine: dlgLine, orderedLines: [dlgLine + 1] },
      ],
    }));
    expect(applied.candidate.statements.find((statement) => statement.id === 'dlg_1'))
      .toMatchObject({ params: { text: 'Processor edit' } });
    expect(applied.candidate.statements.find((statement) => statement.id === 'cam_1')?.time).toBe(4);
    expect(applied.candidate.statements.find((statement) => statement.id === 'dlg_1')?.companions)
      .toHaveLength(1);
    expect(applied.lineMap).toBeDefined();
  });

  it('exposes no line map, refresh flag, or document version in model-visible write results', async () => {
    const { tools } = createWriteTools();
    const updated = await tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'Edited' } },
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.data).toMatchObject({
        status: 'committed',
        counts: { updated: 1 },
        outcomes: [{ kind: 'updated' }],
      });
      expect(JSON.stringify(updated.data)).not.toMatch(
        /lineMap|refreshRequired|validThroughLine|invalidatedFromLine|stale_line_map|"version"/,
      );
    }
    const moved = await tools.moveSourceItem({ statementId: 'cam_1', time: 5 });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(JSON.stringify(moved.data)).not.toMatch(/lineMap|"version"/);
    }
  });

  it('keeps an all-no-op write without history, commit, or version growth', async () => {
    let document = makeDocument();
    let version = 5;
    const commits: unknown[] = [];
    const ports: ProjectAgentWritePorts = {
      scene: { getSnapshot: () => ({ document, version }) },
      validation: { validate: () => [] },
      authoring: {
        commit: (request) => {
          commits.push(request);
          document = request.candidate;
          version += 1;
          return { version };
        },
      },
    };
    const taskState = new ProjectAgentTaskState();
    taskState.bindSceneRead(document, version);
    const tools = new ProjectAgentWriteTools({ ports, taskState });

    const noOp = await tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'First' } } },
        { kind: 'moveSourceItem', statementId: 'cam_1', time: 0 },
      ],
    });
    expect(noOp.ok).toBe(true);
    if (noOp.ok) {
      expect(noOp.data.status).toBe('no_change');
      expect(noOp.data.outcomes).toEqual([{ kind: 'no_change' }, { kind: 'no_change' }]);
      expect(noOp.data.counts).toMatchObject({ inserted: 0, updated: 0, deleted: 0, moved: 0 });
    }
    expect(commits).toHaveLength(0);
    expect(version).toBe(5);

    // A mixed transaction commits atomically while retaining the no-op
    // sibling; the counts reflect actual changes, not processed operations.
    const mixed = await tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'First' } } },
        { kind: 'deleteSourceItem', statementId: 'cam_1' },
      ],
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.data.status).toBe('committed');
      expect(mixed.data.outcomes).toEqual([{ kind: 'no_change' }, { kind: 'deleted' }]);
      expect(mixed.data.counts).toMatchObject({ updated: 0, deleted: 1 });
    }
    expect(commits).toHaveLength(1);
    expect(version).toBe(6);
  });

  it('pairs generated insert identities with operations, not final document order', async () => {
    const harness = createWriteTools();
    // Two root inserts whose final document order (by time) is the REVERSE
    // of the operation order: the returned identities must follow the
    // operations, never the candidate array position.
    const inserted = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'insertStatement', time: 20, statement: { type: 'camera', params: { mode: 'reset', durationSeconds: 1 } } },
        { kind: 'insertStatement', time: 5, statement: { type: 'camera', params: { mode: 'move', durationSeconds: 1 } } },
      ],
    });
    expect(inserted.ok).toBe(true);
    if (inserted.ok) {
      expect(inserted.data.outcomes).toHaveLength(2);
      const firstId = (inserted.data.outcomes[0] as { statementId?: string }).statementId;
      const secondId = (inserted.data.outcomes[1] as { statementId?: string }).statementId;
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();
      // The first outcome's identity is the time-20 statement (mode reset).
      const byId = new Map(harness.document.statements.map((statement) => [statement.id, statement]));
      expect(byId.get(firstId!)?.time).toBe(20);
      expect(byId.get(secondId!)?.time).toBe(5);
    }

    // Same for companions: an append followed by a before-sibling insert.
    const companions = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        {
          kind: 'insertCompanion',
          statementId: 'dlg_1',
          companion: {
            anchor: 'start', offset: 0, type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'first-motion' } },
          },
        },
        {
          kind: 'insertCompanion',
          statementId: 'dlg_1',
          beforeCompanionId: 'cmp_a',
          companion: {
            anchor: 'start', offset: 0, type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'second-motion' } },
          },
        },
      ],
    });
    expect(companions.ok).toBe(true);
    if (companions.ok) {
      const first = (companions.data.outcomes[0] as { companionId?: string }).companionId;
      const second = (companions.data.outcomes[1] as { companionId?: string }).companionId;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const parent = harness.document.statements.find((statement) => statement.id === 'dlg_1');
      const byCompanionId = new Map(
        (parent?.companions ?? []).map((companion) => [companion.id, companion]),
      );
      // The FIRST operation appends (motion first-motion); the SECOND inserts
      // before cmp_a (motion second-motion). Identities follow operations.
      expect((byCompanionId.get(first!)?.params as CharacterPerformanceParams).motion)
        .toEqual({ kind: 'resource', key: 'first-motion' });
      expect((byCompanionId.get(second!)?.params as CharacterPerformanceParams).motion)
        .toEqual({ kind: 'resource', key: 'second-motion' });
    }
  });

  it('pairs identities correctly in transactions mixing root and companion inserts', async () => {
    // Statement first, then companion: both must report inserted, each with
    // its own generated identity (never a kind-filtered position desync).
    const harness = createWriteTools();
    const mixed = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'insertStatement', time: 30, statement: { type: 'camera', params: { mode: 'reset', durationSeconds: 1 } } },
        {
          kind: 'insertCompanion',
          statementId: 'dlg_1',
          companion: {
            anchor: 'start', offset: 0, type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'mixed-a' } },
          },
        },
      ],
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.data.outcomes[0]).toMatchObject({ kind: 'inserted' });
      expect(mixed.data.outcomes[1]).toMatchObject({ kind: 'inserted' });
      const statementId = (mixed.data.outcomes[0] as { statementId?: string }).statementId;
      const companionId = (mixed.data.outcomes[1] as { companionId?: string }).companionId;
      expect(harness.document.statements.some((statement) => statement.id === statementId)).toBe(true);
      const parent = harness.document.statements.find((statement) => statement.id === 'dlg_1');
      expect((parent?.companions ?? []).some((companion) => companion.id === companionId)).toBe(true);
      expect(mixed.data.counts.inserted).toBe(2);
      expect(mixed.data.counts.insertedStatements).toBe(1);
      expect(mixed.data.counts.insertedCompanions).toBe(1);
    }

    // Companion first, then statement: same guarantee in the other order.
    const reversed = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        {
          kind: 'insertCompanion',
          statementId: 'dlg_1',
          companion: {
            anchor: 'start', offset: 0, type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'mixed-b' } },
          },
        },
        { kind: 'insertStatement', time: 40, statement: { type: 'camera', params: { mode: 'reset', durationSeconds: 1 } } },
      ],
    });
    expect(reversed.ok).toBe(true);
    if (reversed.ok) {
      expect(reversed.data.outcomes[0]).toMatchObject({ kind: 'inserted' });
      expect(reversed.data.outcomes[1]).toMatchObject({ kind: 'inserted' });
      const companionId = (reversed.data.outcomes[0] as { companionId?: string }).companionId;
      const statementId = (reversed.data.outcomes[1] as { statementId?: string }).statementId;
      expect(harness.document.statements.some((statement) => statement.id === statementId)).toBe(true);
      const parent = harness.document.statements.find((statement) => statement.id === 'dlg_1');
      expect((parent?.companions ?? []).some((companion) => companion.id === companionId)).toBe(true);
      expect(reversed.data.counts.inserted).toBe(2);
    }
  });

  it('returns generated identities for companions bundled in an insertStatement draft', async () => {
    const harness = createWriteTools();
    const inserted = await harness.tools.insertStatement({
      time: 10,
      statement: {
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Bundled', durationSeconds: 1 },
        companions: [
          {
            anchor: 'start', offset: 0, type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'bundled-a' } },
          },
          {
            anchor: 'start', offset: 0, type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'bundled-b' } },
          },
        ],
      },
    });
    expect(inserted.ok).toBe(true);
    if (inserted.ok) {
      expect(inserted.data.outcomes).toHaveLength(1);
      const outcome = inserted.data.outcomes[0] as {
        kind: string;
        statementId?: string;
        insertedCompanionIds?: readonly string[];
      };
      expect(outcome.kind).toBe('inserted');
      const statement = harness.document.statements.find((item) => item.id === outcome.statementId);
      expect(statement?.type).toBe('dialogue');
      expect(outcome.insertedCompanionIds).toHaveLength(2);
      for (const companionId of outcome.insertedCompanionIds ?? []) {
        expect((statement?.companions ?? []).some((companion) => companion.id === companionId))
          .toBe(true);
      }
      expect(inserted.data.counts.insertedStatements).toBe(1);
      expect(inserted.data.counts.insertedCompanions).toBe(2);
    }
  });

  it('never returns Agent line numbers in validateScene diagnostics', async () => {
    let document = makeDocument();
    const readPorts: ProjectAgentReadPorts = {
      overview: {
        getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }),
      },
      files: { listFiles: () => [] },
      text: { readText: () => ({ lines: ['x'], binary: false }) },
      textSearch: { searchText: () => [] },
      resources: { searchResources: () => [] },
      resourceInspect: {
        inspectResource: (reference) => ({
          exists: true,
          reference,
          scope: 'project',
          bindable: true,
        }),
      },
      scene: { getSnapshot: () => ({ document, version: 1 }) },
      validation: {
        validate: () => [{
          gate: 'resource',
          severity: 'error',
          message: 'Background asset is missing',
          code: 'resource_missing',
          source: { statementId: 'dlg_1' },
        }],
      },
    };
    const writePorts: ProjectAgentWritePorts = {
      scene: { getSnapshot: () => ({ document, version: 1 }) },
      validation: { validate: () => [] },
      authoring: {
        commit: (request) => {
          document = request.candidate;
          return { version: 2 };
        },
      },
    };
    const registry = new ProjectAgentToolRegistry({ readPorts, writePorts });
    const result = await registry.call('validateScene', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.diagnostics[0]).toMatchObject({
        gate: 'resource',
        severity: 'error',
        source: { statementId: 'dlg_1' },
      });
      expect(JSON.stringify(result.data)).not.toContain('"line"');
    }
  });
});
