import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_reg',
    meta: {
      title: 'Registry Scene',
      characters: [{ id: 'a', name: 'A' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'a', text: 'Hi', durationSeconds: 1 },
      },
    ],
  };
}

function createRegistry(registerReadImage = false): ProjectAgentToolRegistry {
  const ports = createRegistryPorts();
  return new ProjectAgentToolRegistry({
    readPorts: ports.readPorts,
    writePorts: ports.writePorts,
    registerReadImage,
  });
}

function createRegistryPorts(): {
  readPorts: ProjectAgentReadPorts;
  writePorts: ProjectAgentWritePorts;
} {
  let document = makeDocument();
  let version = 1;
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'P',
        projectVersion: 1,
        scenes: [],
        assetRoots: {},
      }),
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
    image: {
      readImage: () => ({
        mimeType: 'image/png',
        bytes: new Uint8Array([0]),
        originalWidth: 1,
        originalHeight: 1,
        deliveredWidth: 1,
        deliveredHeight: 1,
        scaled: false,
        contentFingerprint: 'x',
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
  return { readPorts, writePorts };
}

describe('ProjectAgentToolRegistry', () => {
  it('registers the fixed tool surface without readImage by default', () => {
    const registry = createRegistry(false);
    const names = registry.listTools().map((tool) => tool.name);
    expect(names).toContain('readProjectOverview');
    expect(names).toContain('listProjectFiles');
    expect(names).toContain('readProjectText');
    expect(names).toContain('searchProjectText');
    expect(names).toContain('searchResources');
    expect(names).toContain('inspectResource');
    expect(names).toContain('readScene');
    expect(names).toContain('searchScene');
    expect(names).toContain('validateScene');
    expect(names).toContain('insertStatement');
    expect(names).toContain('insertCompanion');
    expect(names).toContain('updateStatement');
    expect(names).toContain('updateCompanion');
    expect(names).toContain('deleteSourceItem');
    expect(names).toContain('moveSourceItem');
    expect(names).toContain('reorderCompanions');
    expect(names).toContain('applyAuthoringTransaction');
    expect(names).not.toContain('readImage');
    expect(registry.has('readImage')).toBe(false);
  });

  it('keeps the full model surface including writes; hiding is an explicit non-model option', () => {
    const registry = createRegistry(false);
    const readOnlyTools = registry.listTools({ includeWrites: false });

    expect(readOnlyTools).toHaveLength(9);
    expect(readOnlyTools.every((tool) => tool.readOnly)).toBe(true);
    expect(readOnlyTools.map((tool) => tool.name)).toContain('readScene');
    expect(readOnlyTools.map((tool) => tool.name)).not.toContain('updateStatement');
    // The default surface always includes write tools; writes without a bound
    // scene snapshot are blocked BEFORE execution with scene_not_read
    // (ADR0023), so the surface never hides the tools the prompt describes.
    const surface = registry.listTools();
    expect(surface.some((tool) => tool.name === 'updateStatement')).toBe(true);
    expect(surface.some((tool) => tool.name === 'applyAuthoringTransaction')).toBe(true);
  });

  it('keeps tool-specific write semantics while shared rules move to the prompt', () => {
    const descriptions = new Map(
      createRegistry(false).listTools().map((tool) => [tool.name, tool.description]),
    );

    expect(descriptions.get('insertStatement')).toContain('beforeStatementId');
    expect(descriptions.get('insertCompanion')).toContain('anchor=end');
    expect(descriptions.get('updateStatement')).toContain('statementId');
    expect(descriptions.get('updateCompanion')).toContain('cannot change parent');
    expect(descriptions.get('deleteSourceItem')).toContain('also deletes all of its companions');
    expect(descriptions.get('moveSourceItem')).toContain('statementId');
    expect(descriptions.get('reorderCompanions')).toContain('exactly once');
    expect(descriptions.get('applyAuthoringTransaction')).toContain('cannot address objects created earlier');
  });

  it('describes the navigation-only pathPrefix resource browse mode', () => {
    const search = createRegistry(false).listTools().find((tool) => tool.name === 'searchResources');
    expect(search?.description).toContain('pathPrefix');
    expect(search?.description).toContain('navigation-only');
    expect((search?.parameters.properties as Record<string, unknown>).pathPrefix).toEqual({ type: 'string' });
  });

  it('conditionally registers readImage when vision is supported', () => {
    const registry = createRegistry(true);
    expect(registry.has('readImage')).toBe(true);
    expect(registry.listTools().some((tool) => tool.name === 'readImage')).toBe(true);
  });

  it('flips the readImage surface with live eligibility changes', async () => {
    const registry = createRegistry(true);
    expect(registry.listTools().some((tool) => tool.name === 'readImage')).toBe(true);

    registry.setReadImageEligible(false);
    expect(registry.has('readImage')).toBe(false);
    expect(registry.listTools().some((tool) => tool.name === 'readImage')).toBe(false);
    const hidden = await registry.dispatch('readImage', { reference: 'images/x.png' });
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.error.code).toBe('vision_unavailable');

    registry.setReadImageEligible(true);
    expect(registry.has('readImage')).toBe(true);
    expect(registry.listTools().some((tool) => tool.name === 'readImage')).toBe(true);
    const visible = await registry.dispatch('readImage', { reference: 'images/x.png' });
    expect(visible.ok).toBe(true);
  });

  it('registers readImage only when an image port exists', () => {
    const ports = createRegistryPorts();
    const withoutPort = new ProjectAgentToolRegistry({
      readPorts: { ...ports.readPorts, image: undefined },
      writePorts: ports.writePorts,
      registerReadImage: true,
    });
    expect(withoutPort.has('readImage')).toBe(false);
    expect(withoutPort.listTools().some((tool) => tool.name === 'readImage')).toBe(false);
  });

  it('dispatches unknown tools and vision_unavailable for unregistered readImage', async () => {
    const registry = createRegistry(false);
    const unknown = await registry.dispatch('notATool', {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('invalid_arguments');

    const vision = await registry.dispatch('readImage', { reference: 'images/x.png' });
    expect(vision.ok).toBe(false);
    if (!vision.ok) expect(vision.error.code).toBe('vision_unavailable');
  });

  it('dispatches read then write through the shared task state', async () => {
    const registry = createRegistry(false);
    const read = await registry.call('readScene', { startLine: 1, lineCount: 20 });
    expect(read.ok).toBe(true);

    const empty = await registry.call('applyAuthoringTransaction', {
      version: 1,
      operations: [],
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.status).toBe('no_change');

    const write = await registry.call('updateStatement', {
      statementId: 'dlg_1',
      patch: { params: { text: 'Edited' } },
    });
    expect(write.ok).toBe(true);
    if (write.ok) {
      expect(write.data.status).toBe('committed');
      expect(write.data.outcomes).toEqual([{ kind: 'updated' }]);
      // Model-visible receipt never exposes the document version.
      expect(JSON.stringify(write.data)).not.toMatch(/version|lineMap/);
    }
  });

  it('exposes JSON parameter schemas for each registered tool', () => {
    const registry = createRegistry(true);
    for (const tool of registry.listTools()) {
      expect(tool.parameters.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.readOnly).toBe('boolean');
    }
    const readScene = registry.listTools().find((tool) => tool.name === 'readScene');
    expect(readScene?.parameters).toMatchObject({
      properties: { lineCount: { maximum: 500 } },
    });
  });

  it('validates arguments against the registry schema before dispatch', async () => {
    const registry = createRegistry(false);
    const rejected = await registry.dispatch('insertStatement', {
      time: 0,
      statement: { type: 'noSuchFamily', params: {} },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('invalid_arguments');

    const missing = await registry.dispatch('updateStatement', { patch: {} });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('invalid_arguments');

    await registry.dispatch('readScene', { startLine: 1, lineCount: 10 });
    const valid = await registry.dispatch('insertStatement', {
      time: 0,
      statement: {
        type: 'dialogue',
        params: { speakerId: 'a', text: 'Hi', durationSeconds: 1 },
      },
    });
    expect(valid.ok).toBe(true);
  });

  it('surfaces the full allowed field set on a schema-failed write', async () => {
    const registry = createRegistry(false);
    await registry.dispatch('readScene', { startLine: 1, lineCount: 10 });
    const rejected = await registry.dispatch('insertStatement', {
      time: 0,
      statement: {
        type: 'environmentLayer',
        params: { background: '@mount/library/background/x.png' },
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('schema_validation_failed');
      expect(rejected.error.message).toContain('Unknown field at statement.params.background');
      expect(rejected.error.message).toContain('Allowed fields: mode, layerId');
      expect(rejected.error.message).toContain(
        'Consult the statement authoring reference in the system prompt for allowed fields.',
      );
    }
  });

  it('derives write tool schemas from the statement registry without per-family tools', async () => {
    const registry = createRegistry(false);
    const writeTools = registry.listTools().filter((tool) => !tool.readOnly);
    const names = writeTools.map((tool) => tool.name);
    expect(names).toEqual([
      'insertStatement',
      'insertCompanion',
      'updateStatement',
      'updateCompanion',
      'deleteSourceItem',
      'moveSourceItem',
      'reorderCompanions',
      'applyAuthoringTransaction',
    ]);
    // No family-specific write tools are ever registered.
    expect(names.some((name) => name.startsWith('updateDialogue'))).toBe(false);
    for (const tool of writeTools) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});
