import { describe, expect, it } from 'vitest';
import { sceneDocumentCodec } from '../services/semantic-scene';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';
import type { CurrentSceneDocument, SceneStatement } from '../api/types/semantic-scene';
import {
  PROJECT_AGENT_BENCHMARK_FIXTURE_LINE_COUNT,
  PROJECT_AGENT_BENCHMARK_TASKS,
  createProjectAgentBenchmarkScene,
  hashProjectAgentBenchmarkFixture,
  hashProjectAgentBenchmarkTasks,
} from '../services/project-agent-benchmark/ProjectAgentBenchmarkFixture';
import {
  judgeProjectAgentBenchmarkScene,
} from '../services/project-agent-benchmark/ProjectAgentBenchmarkOracles';

describe('Project Agent benchmark fixture', () => {
  it('builds a deterministic validated scene of the agreed length', () => {
    const first = createProjectAgentBenchmarkScene();
    const second = createProjectAgentBenchmarkScene();
    expect(sceneDocumentCodec.parseAndValidate(first)).toEqual(first);
    expect(new SemanticSceneLineView(first).totalLines).toBe(PROJECT_AGENT_BENCHMARK_FIXTURE_LINE_COUNT);
    expect(first).toEqual(second);
    expect(hashProjectAgentBenchmarkFixture(first)).toBe(hashProjectAgentBenchmarkFixture(second));
    expect(hashProjectAgentBenchmarkTasks()).toMatch(/^sha256:/);
  });
});

describe('Project Agent benchmark oracles', () => {
  it('accepts the four requested mutations and rejects unrequested extras', () => {
    const baseline = createProjectAgentBenchmarkScene();

    const updateOnly = structuredClone(baseline);
    const updateTarget = updateOnly.statements.find((statement) => statement.id === 'dlg_update_target');
    if (updateTarget?.type !== 'dialogue') throw new Error('missing update target');
    updateTarget.params = { ...updateTarget.params, text: PROJECT_AGENT_BENCHMARK_TASKS.singleUpdate.expectedText };

    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'singleUpdate',
      baseline,
      actual: updateOnly,
      documentVersionIncrease: 1,
    }).passed).toBe(true);

    const extra = structuredClone(updateOnly);
    const filler = extra.statements.find((statement) => statement.id === 'dlg_filler_00');
    if (filler?.type !== 'dialogue') throw new Error('missing filler');
    filler.params = { ...filler.params, text: 'unrequested' };
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'singleUpdate',
      baseline,
      actual: extra,
      documentVersionIncrease: 1,
    }).passed).toBe(false);
  });

  it('requires insert-then-update to keep the inserted identity with the final text', () => {
    const baseline = createProjectAgentBenchmarkScene();
    const inserted = structuredClone(baseline);
    inserted.statements.push({
      id: 'dlg_inserted',
      time: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.time,
      type: 'dialogue',
      params: {
        speakerId: 'tomori',
        text: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.expectedText,
        durationSeconds: 2,
      },
    });
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'insertThenUpdate',
      baseline,
      actual: inserted,
      documentVersionIncrease: 2,
    }).passed).toBe(true);
  });

  it('accepts an anchor-placed insert: the new statement may land mid-array', () => {
    const baseline = createProjectAgentBenchmarkScene();
    const actual = structuredClone(baseline);
    const anchorIndex = actual.statements.findIndex((statement) => statement.id === 'dlg_filler_76');
    if (anchorIndex === -1) throw new Error('missing filler anchor');
    actual.statements.splice(anchorIndex, 0, {
      id: 'dlg_generated-uuid',
      time: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.time,
      type: 'dialogue',
      params: {
        speakerId: 'tomori',
        text: PROJECT_AGENT_BENCHMARK_TASKS.insertThenUpdate.expectedText,
        durationSeconds: 2,
      },
    });
    // The inserted statement sits before dlg_filler_76 with a host-generated
    // id; every other statement is untouched. The oracle must not demand a
    // specific array position for the insert.
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'insertThenUpdate',
      baseline,
      actual,
      documentVersionIncrease: 2,
    }).passed).toBe(true);

    // A genuinely wrong insert (wrong text) still fails.
    const wrongText = structuredClone(actual);
    const inserted = wrongText.statements.find((statement) => statement.id === 'dlg_generated-uuid');
    if (inserted?.type !== 'dialogue') throw new Error('missing inserted statement');
    inserted.params = { ...inserted.params, text: 'wrong text' };
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'insertThenUpdate',
      baseline,
      actual: wrongText,
      documentVersionIncrease: 2,
    }).passed).toBe(false);
  });

  it('requires delete-then-update-downstream to remove only the target and update the downstream object', () => {
    const baseline = createProjectAgentBenchmarkScene();
    const mutated = structuredClone(baseline);
    mutated.statements = mutated.statements.filter((statement) => statement.id !== 'cam_delete_target');
    const downstream = mutated.statements.find((statement) => statement.id === 'dlg_downstream');
    if (downstream?.type !== 'dialogue') throw new Error('missing downstream');
    downstream.params = { ...downstream.params, text: PROJECT_AGENT_BENCHMARK_TASKS.deleteThenUpdateDownstream.expectedText };
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'deleteThenUpdateDownstream',
      baseline,
      actual: mutated,
      documentVersionIncrease: 2,
    }).passed).toBe(true);
  });

  it('requires the batch task to apply all requested changes with exactly one version increase', () => {
    const baseline = createProjectAgentBenchmarkScene();
    const batched = structuredClone(baseline);
    const dialogue = batched.statements.find((statement) => statement.id === 'dlg_batch_target');
    if (dialogue?.type !== 'dialogue') throw new Error('missing batch dialogue');
    dialogue.params = { ...dialogue.params, text: PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.expectedText };
    const camera = batched.statements.find((statement) => statement.id === 'cam_batch_target');
    if (camera?.type !== 'camera') throw new Error('missing batch camera');
    camera.time = PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.expectedCameraTime;
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'atomicBatch',
      baseline,
      actual: batched,
      documentVersionIncrease: 1,
    }).passed).toBe(true);
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'atomicBatch',
      baseline,
      actual: batched,
      documentVersionIncrease: 2,
    }).passed).toBe(false);
  });

  it('ignores object key order, matching engine-persisted documents', () => {
    // Engine save normalizes key order (e.g. meta characters/durationSeconds);
    // the oracle must not reject semantically identical documents.
    const baseline = createProjectAgentBenchmarkScene();
    const updateOnly = structuredClone(baseline);
    const updateTarget = updateOnly.statements.find((statement) => statement.id === 'dlg_update_target');
    if (updateTarget?.type !== 'dialogue') throw new Error('missing update target');
    updateTarget.params = { ...updateTarget.params, text: PROJECT_AGENT_BENCHMARK_TASKS.singleUpdate.expectedText };

    const reordered: CurrentSceneDocument = {
      schemaVersion: updateOnly.schemaVersion,
      sceneId: updateOnly.sceneId,
      meta: {
        durationSeconds: updateOnly.meta.durationSeconds,
        title: updateOnly.meta.title,
        characters: updateOnly.meta.characters,
      },
      statements: updateOnly.statements.map((statement) => {
        const { id, time, type, params, ...rest } = statement;
        return { ...rest, params, type, time, id } as SceneStatement;
      }),
    };
    expect(judgeProjectAgentBenchmarkScene({
      taskId: 'singleUpdate',
      baseline,
      actual: reordered,
      documentVersionIncrease: 1,
    }).passed).toBe(true);
  });
});
