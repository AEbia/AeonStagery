import { describe, expect, it } from 'vitest';
import {
  buildAgentWriteToolSchemas,
  validateAgentToolArguments,
  type AgentJsonSchema,
} from '../services/project-agent/ProjectAgentWriteSchemas';
import { sceneStatementDefinitionRegistry } from '../services/semantic-scene';

describe('ProjectAgentWriteSchemas (registry-derived)', () => {
  it('derives the source-identity write schemas from the statement registry', () => {
    const schemas = buildAgentWriteToolSchemas();
    const registryFamilies = sceneStatementDefinitionRegistry
      .list()
      .map((definition) => definition.family)
      .sort();
    expect(Object.keys(schemas).sort()).toEqual(
      [
        'insertStatement', 'insertCompanion', 'updateStatement', 'updateCompanion',
        'deleteSourceItem', 'moveSourceItem', 'reorderCompanions', 'applyAuthoringTransaction',
      ].sort(),
    );
    for (const name of ['insertStatement', 'insertCompanion', 'updateStatement', 'updateCompanion'] as const) {
      const schema = schemas[name] as AgentJsonSchema;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
      const properties = schema.properties as Record<string, { properties?: Record<string, unknown> }> | undefined;
      const statementSchema = properties?.statement ?? properties?.patch;
      const typeSchema = statementSchema?.properties?.type as { enum?: string[] } | undefined;
      if (typeSchema?.enum) {
        expect([...typeSchema.enum].sort()).toEqual(registryFamilies);
      }
    }
  });

  it('accepts valid single-op arguments', () => {
    const schemas = buildAgentWriteToolSchemas();
    const problem = validateAgentToolArguments('insertStatement', {
      time: 0,
      statement: {
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
      },
    }, schemas['insertStatement']);
    expect(problem).toBeNull();
  });

  it('rejects unknown statement families before dispatch', () => {
    const schemas = buildAgentWriteToolSchemas();
    const problem = validateAgentToolArguments('insertStatement', {
      time: 0,
      statement: { type: 'noSuchFamily', params: {} },
    }, schemas['insertStatement']);
    expect(problem).not.toBeNull();
  });

  it('rejects missing required fields and wrong value types', () => {
    const schemas = buildAgentWriteToolSchemas();
    expect(validateAgentToolArguments('updateStatement', { patch: {} }, schemas['updateStatement']))
      .not.toBeNull();
    expect(validateAgentToolArguments('moveSourceItem', { statementId: 1, time: 0 }, schemas['moveSourceItem']))
      .not.toBeNull();
    expect(validateAgentToolArguments('reorderCompanions', {
      parentLine: 1,
      orderedLines: [0],
    }, schemas['reorderCompanions'])).not.toBeNull();
  });

  it('validates applyAuthoringTransaction envelope and operation items', () => {
    const schemas = buildAgentWriteToolSchemas();
    expect(validateAgentToolArguments('applyAuthoringTransaction', {
      version: 1,
      operations: [],
    }, schemas['applyAuthoringTransaction'])).toBeNull();
    expect(validateAgentToolArguments('applyAuthoringTransaction', {
      version: 2,
      operations: [],
    }, schemas['applyAuthoringTransaction'])).not.toBeNull();
    expect(validateAgentToolArguments('applyAuthoringTransaction', {
      version: 1,
      operations: [{ kind: 'notAnOperation' }],
    }, schemas['applyAuthoringTransaction'])).not.toBeNull();
  });

  it('rejects non-object patch payloads at the boundary', () => {
    const schemas = buildAgentWriteToolSchemas();
    expect(validateAgentToolArguments('updateStatement', {
      statementId: 'stmt_1',
      patch: 'nope',
    }, schemas['updateStatement'])).not.toBeNull();
  });

  it('accepts source identifiers and rejects legacy line write locators', () => {
    const schemas = buildAgentWriteToolSchemas();
    expect(validateAgentToolArguments('updateStatement', {
      statementId: 'stmt_1', patch: { params: { text: 'Hello' } },
    }, schemas.updateStatement)).toBeNull();
    expect(validateAgentToolArguments('updateStatement', {
      line: 1, patch: { params: { text: 'Hello' } },
    }, schemas.updateStatement)).not.toBeNull();
    expect(validateAgentToolArguments('insertStatement', {
      time: 0,
      statement: { type: 'camera', params: { mode: 'reset' } },
      beforeLine: 1,
    }, schemas.insertStatement)).not.toBeNull();
  });
});
