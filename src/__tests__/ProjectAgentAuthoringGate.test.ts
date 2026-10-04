import { describe, expect, it } from 'vitest';
import type { AgentInspectResourceResult } from '../api/types/project-agent';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { createProjectAgentAuthoringGate } from '../services/project-agent-service/ProjectAgentAuthoringGate';
import { runProjectAgentSceneValidation } from '../services/project-agent-service/ProjectAgentSceneValidation';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_gate',
    meta: {
      title: 'Gate Scene',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori', model: 'models/tomori.model3.json' }],
    },
    statements: [
      {
        id: 'pres_1',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'tomori', model: 'models/tomori.model3.json', durationSeconds: 1 },
      },
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hi', durationSeconds: 2, voice: 'vocal/hi.ogg' },
        companions: [
          {
            id: 'perf_1',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'smile' } },
          },
        ],
      },
    ],
  };
}

function kindForReference(reference: string): 'live2dModel' | 'voice' {
  return reference.endsWith('.model3.json') ? 'live2dModel' : 'voice';
}

function companionKindForReference(reference: string): 'live2dModel' | 'voice' | 'sfx' {
  if (reference.endsWith('.model3.json')) return 'live2dModel';
  if (reference.endsWith('.wav')) return 'sfx';
  return 'voice';
}

function makeCompanionDocument(file = 'audio/hit.wav'): CurrentSceneDocument {
  const base = makeDocument();
  return {
    ...base,
    statements: [
      base.statements[0],
      {
        ...base.statements[1],
        companions: [
          ...(base.statements[1].companions ?? []),
          {
            id: 'sfx_1',
            anchor: 'start',
            offset: 0,
            type: 'audio',
            params: { role: 'sfx', mode: 'play', instanceId: 'hit', file },
          },
        ],
      },
    ],
  };
}

function inspectResult(overrides: Partial<AgentInspectResourceResult> = {}): AgentInspectResourceResult {
  return {
    exists: true,
    reference: 'models/tomori.model3.json',
    scope: 'project',
    kind: 'live2dModel',
    bindable: true,
    ...overrides,
  };
}

function createGate(inspect: (reference: string) => AgentInspectResourceResult) {
  return createProjectAgentAuthoringGate({
    validateStructure: runProjectAgentSceneValidation,
    inspectResource: async (reference) => inspect(reference),
  });
}

async function validate(gate: ReturnType<typeof createGate>, document: CurrentSceneDocument) {
  return gate(document);
}

describe('ProjectAgentAuthoringGate (strict, per-transaction)', () => {
  it('passes a valid candidate with all references existing and bindable', async () => {
    const gate = createGate((reference) => inspectResult({
      reference,
      kind: kindForReference(reference),
    }));
    const diagnostics = await validate(gate, makeDocument());
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });

  it('reports a missing resource as a strict resource error addressed by source identity', async () => {
    const gate = createGate((reference) => inspectResult({
      reference,
      exists: false,
      bindable: false,
    }));
    const diagnostics = await validate(gate, makeDocument());
    const resourceError = diagnostics.find((d) => d.gate === 'resource' && d.severity === 'error');
    expect(resourceError).toBeDefined();
    // The first strict resource error addresses the first statement's model.
    expect(resourceError?.source).toEqual({ statementId: 'pres_1' });
  });

  it('rejects un-bindable and materialization-required references', async () => {
    const gate = createGate((reference) => {
      if (reference.includes('tomori')) return inspectResult({ reference, bindable: false, materializationRequired: true });
      return inspectResult({ reference, kind: kindForReference(reference) });
    });
    const diagnostics = await validate(gate, makeDocument());
    expect(diagnostics.some((d) => d.gate === 'resource' && d.severity === 'error')).toBe(true);
  });

  it('rejects actual-kind mismatch against the statement asset slot', async () => {
    const gate = createGate((reference) => inspectResult({ reference, kind: 'sfx' as const }));
    const diagnostics = await validate(gate, makeDocument());
    expect(diagnostics.some((d) => d.gate === 'resource' && d.severity === 'error')).toBe(true);
  });

  it('keeps schema/semantic/compiler structure errors from the strict path', async () => {
    const gate = createGate(() => inspectResult());
    const diagnostics = await validate(gate, {
      ...makeDocument(),
      statements: [{
        id: 'bad',
        time: 0,
        type: 'noSuchFamily',
        params: {},
      } as never],
    });
    expect(diagnostics.some((d) => d.gate === 'schema' && d.severity === 'error')).toBe(true);
  });

  it('never uses runtime loose degradation: every reference is re-inspected per transaction', async () => {
    let inspected = 0;
    const gate = createGate((reference) => {
      inspected += 1;
      return inspectResult({ reference, kind: kindForReference(reference) });
    });
    await validate(gate, makeDocument());
    await validate(gate, makeDocument());
    // Two asset references per document (model + voice), revalidated every time.
    expect(inspected).toBe(4);
  });
});

describe('ProjectAgentAuthoringGate companion resource references', () => {
  it('passes a dialogue companion whose referenced audio file exists and matches its slot kind', async () => {
    const gate = createGate((reference) => inspectResult({
      reference,
      kind: companionKindForReference(reference),
    }));
    const diagnostics = await validate(gate, makeCompanionDocument());
    expect(diagnostics.some((d) => d.gate === 'resource' && d.severity === 'error')).toBe(false);
  });

  it('rejects a companion audio file that does not exist, mapped to the companion Agent line', async () => {
    const gate = createGate((reference) => inspectResult({
      reference,
      exists: !reference.endsWith('.wav'),
      kind: companionKindForReference(reference),
    }));
    const diagnostics = await validate(gate, makeCompanionDocument());
    const error = diagnostics.find((d) => d.gate === 'resource' && d.severity === 'error');
    expect(error).toBeDefined();
    expect(error?.message).toContain('audio/hit.wav');
    expect(error?.source).toEqual({ statementId: 'dlg_1', companionId: 'sfx_1' });
  });

  it('rejects a companion audio file whose actual kind mismatches the sfx slot', async () => {
    const gate = createGate((reference) => inspectResult({
      reference,
      kind: reference.endsWith('.wav') ? 'voice' : companionKindForReference(reference),
    }));
    const diagnostics = await validate(gate, makeCompanionDocument());
    const error = diagnostics.find((d) => d.gate === 'resource' && d.severity === 'error');
    expect(error).toBeDefined();
    expect(error?.source).toEqual({ statementId: 'dlg_1', companionId: 'sfx_1' });
  });

  it('rejects a companion audio file that is not bindable', async () => {
    const gate = createGate((reference) => inspectResult({
      reference,
      bindable: !reference.endsWith('.wav'),
      kind: companionKindForReference(reference),
    }));
    const diagnostics = await validate(gate, makeCompanionDocument());
    const error = diagnostics.find((d) => d.gate === 'resource' && d.severity === 'error');
    expect(error).toBeDefined();
    expect(error?.source).toEqual({ statementId: 'dlg_1', companionId: 'sfx_1' });
  });
});
