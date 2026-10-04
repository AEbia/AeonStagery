import type { AgentToolError } from '../../api/types/project-agent';
import type { ProjectAgentToolName } from '../../api/types/project-agent';
import {
} from '../../api/types/semantic-scene-patch';
import type { SceneStatementDefinitionRegistry } from '../semantic-scene/SceneStatementDefinitionRegistry';
import { sceneStatementDefinitionRegistry } from '../semantic-scene/SceneStatementDefinitionRegistry';

/** A plain JSON-schema subset used for agent tool arguments. */
export type AgentJsonSchema = Readonly<Record<string, unknown>>;

export type AgentWriteToolSchemaMap = Readonly<
  Record<Extract<ProjectAgentToolName, 'insertStatement' | 'insertCompanion' | 'updateStatement' | 'updateCompanion' | 'deleteSourceItem' | 'moveSourceItem' | 'reorderCompanions' | 'applyAuthoringTransaction'>, AgentJsonSchema>
>;

/**
 * Registry-derived parameter schemas for the fixed agent write tools
 * (ADR0023): the operation algebra and statement family enum come from the
 * authoritative statement registry — no duplicate hand-written schemas.
 * Deep field validation stays in the patch parser and authoring gates.
 */
export function buildAgentWriteToolSchemas(
  registry: SceneStatementDefinitionRegistry = sceneStatementDefinitionRegistry,
): AgentWriteToolSchemaMap {
  const families = registry.list().map((definition) => definition.family);
  const companionFamilies = registry
    .list()
    .filter((definition) => definition.attachableTo?.includes('dialogue'))
    .map((definition) => definition.family);
  const typeEnum = {
    type: 'string',
    enum: [...families],
  } satisfies AgentJsonSchema;
  const companionTypeEnum = {
    type: 'string',
    enum: companionFamilies.length > 0 ? companionFamilies : families,
  } satisfies AgentJsonSchema;

  const statementDraft = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'params'],
    properties: {
      type: typeEnum,
      params: { type: 'object' },
      companions: {
        type: 'array',
        items: companionDraft(),
      },
    },
  } satisfies AgentJsonSchema;

  function companionDraft(): AgentJsonSchema {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['anchor', 'offset', 'type', 'params'],
      properties: {
        anchor: { type: 'string', enum: ['start', 'end'] },
        offset: { type: 'number' },
        type: companionTypeEnum,
        params: { type: 'object' },
      },
    };
  }

  const patch = {
    type: 'object',
    additionalProperties: true,
    properties: {
      type: typeEnum,
      params: {},
    },
  } satisfies AgentJsonSchema;

  const sourceIdentity = { type: 'string', minLength: 1 } satisfies AgentJsonSchema;

  const operationItem = {
    type: 'object',
    additionalProperties: true,
    properties: {
      kind: { type: 'string', enum: ['insertStatement', 'insertCompanion', 'updateStatement', 'updateCompanion', 'deleteSourceItem', 'moveSourceItem', 'reorderCompanions'] },
    },
  } satisfies AgentJsonSchema;

  return {
    insertStatement: {
      type: 'object',
      additionalProperties: false,
      required: ['time', 'statement'],
      properties: {
        time: { type: 'number', minimum: 0 },
        statement: statementDraft,
        beforeStatementId: sourceIdentity,
      },
    },
    insertCompanion: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId', 'companion'],
      properties: {
        statementId: sourceIdentity,
        companion: companionDraft(),
        beforeCompanionId: sourceIdentity,
      },
    },
    updateStatement: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId', 'patch'],
      properties: {
        statementId: sourceIdentity,
        patch,
      },
    },
    updateCompanion: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId', 'companionId', 'patch'],
      properties: {
        statementId: sourceIdentity,
        companionId: sourceIdentity,
        patch,
      },
    },
    deleteSourceItem: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId'],
      properties: { statementId: sourceIdentity, companionId: sourceIdentity },
    },
    moveSourceItem: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId'],
      properties: {
        statementId: sourceIdentity,
        time: { type: 'number', minimum: 0 },
        companionId: sourceIdentity,
        anchor: { type: 'string', enum: ['start', 'end'] },
        offset: { type: 'number' },
      },
    },
    reorderCompanions: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId', 'orderedCompanionIds'],
      properties: {
        statementId: sourceIdentity,
        orderedCompanionIds: { type: 'array', items: sourceIdentity },
      },
    },
    applyAuthoringTransaction: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'operations'],
      properties: {
        version: { type: 'integer', const: 1 },
        operations: { type: 'array', items: operationItem },
      },
    },
  };
}

/**
 * Validate tool arguments against a registered parameter schema BEFORE
 * dispatch (ADR0023). Plain text, user messages or descriptive JSON can never
 * become a command; only a structurally valid native tool call passes.
 */
export function validateAgentToolArguments(
  name: string,
  args: unknown,
  schema: AgentJsonSchema,
): AgentToolError | null {
  const problem = validateValue(args, schema, 'arguments');
  if (problem) {
    return {
      code: 'invalid_arguments',
      message: `Tool ${name} arguments are invalid: ${problem}`,
      retryable: false,
      suggestedAction: 'fix_arguments',
    };
  }
  return null;
}

function validateValue(value: unknown, schema: AgentJsonSchema, path: string): string | null {
  const schemaType = schema.type as string | undefined;

  if (schema.const !== undefined) {
    if (value !== schema.const) return `${path} must be the constant ${JSON.stringify(schema.const)}`;
    return null;
  }
  if (schema.enum !== undefined && value !== undefined && value !== null) {
    if (!(schema.enum as unknown[]).includes(value)) {
      return `${path} must be one of ${(schema.enum as unknown[]).map((item) => JSON.stringify(item)).join(', ')}`;
    }
  }

  if (schemaType === undefined) {
    return null;
  }

  if (schemaType === 'object') {
    if (value === undefined || value === null) {
      return `${path} is required to be an object`;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `${path} must be an object`;
    }
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Readonly<Record<string, AgentJsonSchema>> | undefined;
    const required = (schema.required as readonly string[] | undefined) ?? [];
    for (const key of required) {
      if (record[key] === undefined) {
        return `${path}.${key} is required`;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!properties || !Object.prototype.hasOwnProperty.call(properties, key)) {
          return `${path}.${key} is not an accepted argument`;
        }
      }
    }
    if (properties) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (record[key] === undefined) continue;
        const childProblem = validateValue(record[key], childSchema, `${path}.${key}`);
        if (childProblem) return childProblem;
      }
    }
    return null;
  }

  if (schemaType === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    const items = schema.items as AgentJsonSchema | undefined;
    if (items) {
      for (let i = 0; i < value.length; i += 1) {
        const itemProblem = validateValue(value[i], items, `${path}[${i}]`);
        if (itemProblem) return itemProblem;
      }
    }
    return null;
  }

  if (schemaType === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      return `${path} must be an integer`;
    }
    const minimum = schema.minimum as number | undefined;
    if (minimum !== undefined && value < minimum) return `${path} must be at least ${minimum}`;
    return null;
  }

  if (schemaType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a finite number`;
    const minimum = schema.minimum as number | undefined;
    if (minimum !== undefined && value < minimum) return `${path} must be at least ${minimum}`;
    return null;
  }

  if (schemaType === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    return null;
  }

  if (schemaType === 'boolean') {
    if (typeof value !== 'boolean') return `${path} must be a boolean`;
    return null;
  }

  return null;
}
