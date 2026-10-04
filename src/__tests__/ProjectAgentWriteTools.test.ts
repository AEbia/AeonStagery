import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentTaskState } from '../services/project-agent/ProjectAgentTaskState';
import { ProjectAgentWriteTools } from '../services/project-agent/ProjectAgentWriteTools';
import { SemanticAuthoringGateError } from '../services/timeline-authoring/SemanticAuthoringApplicationService';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_agent',
    meta: {
      title: 'Agent Scene',
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
            type: 'characterPerformance',
            params: { target: 'tomori', motion: '' },
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

function createWriteHarness(options?: {
  validate?: ProjectAgentWritePorts['validation']['validate'];
  commitFail?: Error;
}) {
  let document = makeDocument();
  let version = 5;
  const commits: CurrentSceneDocument[] = [];

  const ports: ProjectAgentWritePorts = {
    scene: {
      getSnapshot: () => ({ document, version }),
    },
    validation: {
      validate: options?.validate ?? (() => []),
    },
    authoring: {
      commit: (request) => {
        if (options?.commitFail) throw options.commitFail;
        if (request.baseVersion !== version) {
          const error = new Error('stale base version');
          (error as Error & { code: string }).code = 'version_conflict';
          throw error;
        }
        document = request.candidate;
        version += 1;
        commits.push(document);
        return { version };
      },
    },
  };

  const taskState = new ProjectAgentTaskState();
  const tools = new ProjectAgentWriteTools({ ports, taskState });
  return {
    tools,
    taskState,
    ports,
    get version() { return version; },
    get document() { return document; },
    commits,
    bind() {
      taskState.bindSceneRead(document, version);
    },
  };
}

describe('ProjectAgentWriteTools', () => {
  it('rejects writes before a successful scene read', async () => {
    const { tools } = createWriteHarness();
    const result = await tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'Changed' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('scene_not_read');
      expect(result.error.suggestedAction).toBe('reread_scene');
    }
  });

  it('returns no_change for empty applyAuthoringTransaction without mutation', async () => {
    const harness = createWriteHarness();
    harness.bind();
    const before = harness.version;
    const result = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('no_change');
    expect(result.data.outcomes).toEqual([]);
    expect(result.data.counts).toMatchObject({ inserted: 0, updated: 0, deleted: 0, moved: 0 });
    expect(JSON.stringify(result.data)).not.toMatch(/version|lineMap/);
    expect(harness.commits).toHaveLength(0);
    expect(harness.version).toBe(before);
  });

  it('applies a single content update and advances version with receipt', async () => {
    const harness = createWriteHarness();
    harness.bind();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'Updated' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcomes).toEqual([{ kind: 'updated' }]);
    expect(result.data.counts.updated).toBeGreaterThan(0);
    expect(JSON.stringify(result.data)).not.toMatch(/version|lineMap|dlg_1|cmp_a/);
    expect(harness.taskState.getSceneBinding()?.version).toBe(6);
    expect(harness.document.statements[0]?.type === 'dialogue'
      && (harness.document.statements[0].params as { text?: string }).text).toBe('Updated');
  });

  it('reports deletion without line-map state', async () => {
    const harness = createWriteHarness();
    harness.bind();
    const result = await harness.tools.deleteSourceItem({ statementId: 'cam_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcomes).toEqual([{ kind: 'deleted' }]);
    expect(result.data.counts.deleted).toBeGreaterThan(0);
    expect(JSON.stringify(result.data)).not.toMatch(/lineMap|version/);
  });

  it('commits multi-op transaction atomically via applyAuthoringTransaction', async () => {
    const harness = createWriteHarness();
    harness.bind();
    const result = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'A' } } },
        { kind: 'moveSourceItem', statementId: 'cam_1', time: 4 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcomes).toEqual([{ kind: 'updated' }, { kind: 'moved' }]);
    expect(harness.commits).toHaveLength(1);
  });

  it('maps validation hard errors to gate error codes without committing', async () => {
    const harness = createWriteHarness({
      validate: () => [{
        gate: 'resource',
        severity: 'error',
        message: 'Missing background',
        code: 'resource_missing',
      }],
    });
    harness.bind();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'Nope' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('resource_validation_failed');
    }
    expect(harness.commits).toHaveLength(0);
  });

  it('surfaces version_conflict from authoring port', async () => {
    const error = new Error('concurrent edit');
    (error as Error & { code: string }).code = 'version_conflict';
    const harness = createWriteHarness({ commitFail: error });
    harness.bind();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'X' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('version_conflict');
      expect(result.error.suggestedAction).toBe('reread_scene');
    }
  });

  it('rejects single-op tools with invalid patch via structured error', async () => {
    const harness = createWriteHarness();
    harness.bind();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_arguments');
    }
  });

  it('passes resolved operation data and change fingerprints into the commit request', async () => {
    const harness = createWriteHarness();
    harness.bind();
    const requests: Array<Parameters<ProjectAgentWritePorts['authoring']['commit']>[0]> = [];
    const original = harness.ports.authoring.commit.bind(harness.ports.authoring);
    harness.ports.authoring.commit = (request) => {
      requests.push(request);
      return original(request);
    };
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'With notes' } },
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.baseVersion).toBe(5);
    expect(request.resolvedOperationsNotes).toContain('dlg_1');
    expect(request.opsFingerprint?.length).toBeGreaterThan(0);
    expect(request.expectedChangeFingerprint?.length).toBeGreaterThan(0);
  });

  it('maps authoritative gate failures to structured gate error codes', async () => {
    const harness = createWriteHarness({
      commitFail: new SemanticAuthoringGateError([
        {
          gate: 'resource',
          severity: 'error',
          message: 'Background asset is missing',
          code: 'resource_missing',
          source: { statementId: 'dlg_1' },
        },
      ]),
    });
    harness.bind();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'Nope' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('resource_validation_failed');
      expect(result.error.diagnostics?.[0]?.message).toBe('Background asset is missing');
      expect(result.error.diagnostics?.[0]?.severity).toBe('error');
      expect(result.error.diagnostics?.[0]?.source).toEqual({ statementId: 'dlg_1' });
    }
    expect(harness.commits).toHaveLength(0);
  });

  it('maps durable pending persistence failures to a structured retryable error', async () => {
    const error = new Error('journal disk full');
    (error as Error & { code: string }).code = 'journal_persist_failed';
    const harness = createWriteHarness({ commitFail: error });
    harness.bind();
    const result = await harness.tools.updateStatement({
      statementId: 'dlg_1',
      patch: { params: { text: 'X' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('journal_persist_failed');
      expect(result.error.retryable).toBe(true);
    }
    expect(harness.commits).toHaveLength(0);
  });

  it('rejects conflicting operations in an explicit transaction as all-or-nothing', async () => {
    const harness = createWriteHarness();
    harness.bind();
    // Same line updated and deleted in one transaction: the patch algebra must
    // reject it without committing anything.
    const result = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'A' } } },
        { kind: 'deleteSourceItem', statementId: 'dlg_1' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflicting_operations');
    }
    expect(harness.commits).toHaveLength(0);
    expect(harness.version).toBe(5);
  });

  it('resolves all lines up front for explicit transactions (no order dependencies)', async () => {
    const harness = createWriteHarness();
    harness.bind();
    // A root update and delete resolve from the same source snapshot and must
    // fail atomically rather than depending on operation order.
    const result = await harness.tools.applyAuthoringTransaction({
      version: 1,
      operations: [
        { kind: 'deleteSourceItem', statementId: 'dlg_1' },
        { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'Changed' } } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflicting_operations');
    }
    expect(harness.commits).toHaveLength(0);
  });
});
