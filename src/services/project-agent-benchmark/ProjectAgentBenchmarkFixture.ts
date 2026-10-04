import { createHash } from 'node:crypto';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument, type SceneStatement } from '../../api/types/semantic-scene';

export const PROJECT_AGENT_BENCHMARK_FIXTURE_LINE_COUNT = 650 as const;
export const PROJECT_AGENT_BENCHMARK_PROTOCOL_VERSION = 'line-v1' as const;

export const PROJECT_AGENT_BENCHMARK_TASKS = {
  singleUpdate: {
    id: 'singleUpdate',
    statementId: 'dlg_update_target',
    originalText: 'Update this line.',
    expectedText: 'Updated by benchmark.',
    prompt: 'Update the dialogue whose current text is exactly "Update this line." to "Updated by benchmark." Do not change anything else.',
  },
  insertThenUpdate: {
    id: 'insertThenUpdate',
    time: 80,
    insertedText: 'Inserted draft.',
    expectedText: 'Inserted then updated.',
    prompt: 'Insert a new Tomori dialogue at time 80 with text "Inserted draft.", then update that same newly inserted dialogue to "Inserted then updated." Do not change anything else.',
  },
  deleteThenUpdateDownstream: {
    id: 'deleteThenUpdateDownstream',
    deleteStatementId: 'cam_delete_target',
    downstreamStatementId: 'dlg_downstream',
    originalText: 'Downstream stays until delete.',
    expectedText: 'Downstream after delete.',
    prompt: 'Delete the camera statement that currently sits immediately before the dialogue "Downstream stays until delete." Then update that remaining downstream dialogue to "Downstream after delete." Do not change anything else.',
  },
  atomicBatch: {
    id: 'atomicBatch',
    dialogueStatementId: 'dlg_batch_target',
    cameraStatementId: 'cam_batch_target',
    originalText: 'Batch dialogue.',
    expectedText: 'Batch updated together.',
    expectedCameraTime: 70,
    prompt: 'In one atomic transaction, update the dialogue whose text is exactly "Batch dialogue." to "Batch updated together." and move the camera that currently occurs at the same time as that dialogue to time 70. Do not change anything else.',
  },
} as const;

export type ProjectAgentBenchmarkTaskId = keyof typeof PROJECT_AGENT_BENCHMARK_TASKS;

export function createProjectAgentBenchmarkScene(): CurrentSceneDocument {
  const statements: SceneStatement[] = [
    {
      id: 'char_presence_tomori',
      time: 0,
      type: 'characterPresence',
      params: { mode: 'enter', id: 'tomori' },
    },
    dialogue('dlg_update_target', 1, PROJECT_AGENT_BENCHMARK_TASKS.singleUpdate.originalText),
    {
      id: 'cam_delete_target',
      time: 2,
      type: 'camera',
      params: { mode: 'reset', durationSeconds: 0.2 },
    },
    dialogue('dlg_downstream', 2.1, PROJECT_AGENT_BENCHMARK_TASKS.deleteThenUpdateDownstream.originalText),
    dialogue('dlg_batch_target', 3, PROJECT_AGENT_BENCHMARK_TASKS.atomicBatch.originalText),
    {
      id: 'cam_batch_target',
      time: 3,
      type: 'camera',
      params: { mode: 'reset', durationSeconds: 0.3 },
    },
  ];

  // 10 fixed lines plus 320 dialogue/companion pairs gives a stable 650-line
  // fixture without embedding any user project content in benchmark runs.
  for (let index = 0; index < 320; index += 1) {
    statements.push(dialogue(`dlg_filler_${String(index).padStart(2, '0')}`, 4 + index, `Filler line ${index}.`));
  }
  statements.push({
    id: 'cam_filler_end',
    time: 49,
    type: 'camera',
    params: { mode: 'reset', durationSeconds: 0.2 },
  });

  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'project-agent-benchmark',
    meta: {
      title: 'Project Agent Benchmark Scene',
      durationSeconds: 340,
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements,
  };
}

export function hashProjectAgentBenchmarkFixture(document: CurrentSceneDocument = createProjectAgentBenchmarkScene()): string {
  return sha256(stableStringify(document));
}

export function hashProjectAgentBenchmarkTasks(): string {
  return sha256(stableStringify(PROJECT_AGENT_BENCHMARK_TASKS));
}

export function projectAgentBenchmarkTaskPrompt(taskId: ProjectAgentBenchmarkTaskId): string {
  return PROJECT_AGENT_BENCHMARK_TASKS[taskId].prompt;
}

function dialogue(id: string, time: number, text: string): SceneStatement {
  return {
    id,
    time,
    type: 'dialogue',
    params: {
      speakerId: 'tomori',
      text,
      durationSeconds: 2,
    },
    companions: [
      {
        id: `${id}_cmp`,
        anchor: 'start',
        offset: 0,
        type: 'characterPerformance',
        params: { target: 'tomori', motion: '' },
      },
    ],
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}
