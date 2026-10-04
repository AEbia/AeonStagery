import type {
  AgentToolResult,
  ProjectAgentHostWriteReceipt,
  ProjectAgentToolArgsByName,
  ProjectAgentToolName,
  ProjectAgentToolResultByName,
} from '../../api/types/project-agent';
import {
  buildAgentWriteToolSchemas,
  validateAgentToolArguments,
} from './ProjectAgentWriteSchemas';
import type {
  ProjectAgentReadPorts,
  ProjectAgentSceneSnapshot,
  ProjectAgentTerminalPort,
  ProjectAgentWritePorts,
} from './ProjectAgentPorts';
import { ProjectAgentReadTools } from './ProjectAgentReadTools';
import { ProjectAgentTaskState } from './ProjectAgentTaskState';
import { ProjectAgentWriteTools } from './ProjectAgentWriteTools';
import { toolFail } from './ProjectAgentPathRules';
import type { ProjectAgentImageSessionCache } from './ProjectAgentImageSessionCache';
import { ProjectAgentTerminalTools } from './ProjectAgentTerminalTools';

export interface ProjectAgentToolDefinition {
  readonly name: ProjectAgentToolName;
  readonly description: string;
  readonly readOnly: boolean;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ProjectAgentToolRegistryOptions {
  readonly readPorts: ProjectAgentReadPorts;
  readonly writePorts: ProjectAgentWritePorts;
  readonly taskState?: ProjectAgentTaskState;
  /**
   * Initial readImage eligibility: true only when the exact endpoint + model
   * reports imageInput as explicitly supported (ADR0023). Eligibility is
   * mutable via setReadImageEligible so a model switch on continue can flip
   * the surface; unsupported/unknown models never see the tool definition.
   */
  readonly registerReadImage?: boolean;
  /** Live-memory image payload cache for the current task session. */
  readonly imageCache?: ProjectAgentImageSessionCache;
  /** Explicit full-access opt-in; enables arbitrary terminal commands. */
  readonly registerTerminal?: boolean;
  /** Main-process-only terminal adapter. Required for terminal registration. */
  readonly terminal?: ProjectAgentTerminalPort;
}

export interface ProjectAgentToolListOptions {
  /**
   * Non-model callers may keep writes off a list. The model surface ALWAYS
   * includes the write tools: writes without a bound scene snapshot are
   * blocked before execution with scene_not_read (ADR0023), so hiding them at
   * list time never adds safety — it only made the prompt-described surface
   * disappear after restore/pause/settle while history still showed reads.
   */
  readonly includeWrites?: boolean;
}

type ToolHandler = (args: unknown, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;

/** Registry-derived write tool schemas (ADR0023): no duplicate hand-written schemas. */
const WRITE_TOOL_SCHEMAS = buildAgentWriteToolSchemas();

/** Shared write rules live in the system prompt; descriptions stay selection-focused. */
const WRITE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  insertStatement:
    'Insert a root statement at an absolute scene time in seconds. statement is { type, params }; a dialogue draft may include complete companions. beforeStatementId must reference a root at the SAME time, otherwise omit it to append at that time. statement.params must follow the statement authoring reference in the system prompt.',
  insertCompanion:
    'Insert a companion under dialogue statementId. anchor=start uses parentTime+offset; anchor=end uses parentEnd+offset. beforeCompanionId must be an existing companion of that same parent.',
  updateStatement:
    'Merge a patch { type?, params? } onto a root statement addressed by statementId. It cannot change id, time, or companions; use moveSourceItem for time. A different type is a family replacement and requires complete params for the new family.',
  updateCompanion:
    'Merge a patch { type?, params? } onto a dialogue companion addressed by statementId and companionId. It cannot change parent or timing; use moveSourceItem with anchor and offset. A different type is a family replacement and requires complete new-family params.',
  deleteSourceItem:
    'Delete one source item. Root targets use statementId; companion targets use statementId and companionId. Deleting a root also deletes all of its companions.',
  moveSourceItem:
    'Move a root statement addressed by statementId to an absolute scene time, or a companion addressed by statementId and companionId using its exact anchor and offset.',
  reorderCompanions:
    'Reorder all companions of dialogue statementId; orderedCompanionIds must contain that parent\'s companions exactly once.',
  applyAuthoringTransaction:
    'Apply version 1 operations as one all-or-nothing transaction. All source identities resolve against the scene read at transaction start; operations cannot address objects created earlier in the same transaction. Empty operations return no_change.',
};

/**
 * Typed tool registry for ADR0023 project Agent.
 * Registers read/write tools by name with JSON schemas and dispatches calls.
 */
export class ProjectAgentToolRegistry {
  readonly taskState: ProjectAgentTaskState;
  private readonly readPorts: ProjectAgentReadPorts;
  private readonly readTools: ProjectAgentReadTools;
  private readonly writeTools: ProjectAgentWriteTools;
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly definitions: ProjectAgentToolDefinition[] = [];
  private readonly imageCache?: ProjectAgentImageSessionCache;
  private readImageEligible: boolean;
  private readonly terminalEligible: boolean;
  private readonly terminalTools: ProjectAgentTerminalTools;

  constructor(options: ProjectAgentToolRegistryOptions) {
    this.taskState = options.taskState ?? new ProjectAgentTaskState();
    this.readImageEligible = options.registerReadImage ?? false;
    this.terminalEligible = options.registerTerminal === true && !!options.terminal;
    this.imageCache = options.imageCache;
    this.readPorts = options.readPorts;
    this.readTools = new ProjectAgentReadTools({
      ports: options.readPorts,
      taskState: this.taskState,
      imageAvailable: !!options.readPorts.image,
      ...(options.imageCache ? { imageCache: options.imageCache } : {}),
    });
    this.writeTools = new ProjectAgentWriteTools({
      ports: options.writePorts,
      taskState: this.taskState,
    });
    this.terminalTools = new ProjectAgentTerminalTools(options.terminal);
    this.registerAll();
  }

  listTools(options: ProjectAgentToolListOptions = {}): readonly ProjectAgentToolDefinition[] {
    const includeWrites = options.includeWrites ?? true;
    return this.definitions.filter((tool) => (
      (includeWrites || tool.readOnly)
      && (this.readImageEligible || tool.name !== 'readImage')
      && (this.terminalEligible || tool.name !== 'runTerminalCommand')
    ));
  }

  has(name: string): boolean {
    if (name === 'readImage' && !this.readImageEligible) return false;
    if (name === 'runTerminalCommand' && !this.terminalEligible) return false;
    return this.handlers.has(name);
  }

  /**
   * Flip readImage eligibility when the task's current endpoint + model
   * capability resolution changes (e.g. model switch on continue). The
   * tool definition and dispatch surface follow the live eligibility.
   */
  setReadImageEligible(eligible: boolean): void {
    this.readImageEligible = eligible;
  }

  /**
   * Capture ONE scene snapshot at the start of a parallel read group. All
   * scene tools in the group read this exact document + version (ADR0023).
   */
  async captureSceneSnapshot(): Promise<ProjectAgentSceneSnapshot | null> {
    const snapshot = await this.readPorts.scene.getSnapshot();
    this.taskState.setGroupSceneSnapshot(snapshot);
    return snapshot;
  }

  /** End the parallel read group: later groups capture a fresh snapshot. */
  clearSceneReadGroup(): void {
    this.taskState.clearGroupSceneSnapshot();
  }

  /** Promote the active binding after a complete tool round is persisted. */
  promoteSceneBinding(): void {
    this.taskState.markSceneBindingDurable();
  }

  /** Restore the last binding from a completed tool round for the next round. */
  restoreSceneBinding(): boolean {
    return this.taskState.restoreDurableSceneBinding();
  }

  /** Restore a binding loaded from the durable journal record. */
  restoreSceneBindingBlob(value: unknown): boolean {
    return this.taskState.restoreSceneBinding(value);
  }

  /** Return the binding that is safe to persist across execution boundaries. */
  getDurableSceneBindingBlob() {
    return this.taskState.getDurableSceneBindingBlob();
  }

  /**
   * Pause/settle/lease replacement: the active snapshot is no longer
   * authorized for the current execution boundary. The last completed-round
   * binding stays available for explicit continuation/recovery, while the
   * live-memory image payload cache is cleared (ADR0023).
   */
  clearTaskState(): void {
    this.taskState.clearRuntimeState();
    this.imageCache?.clear();
  }

  /** Replace the task runtime entirely when starting or hydrating another task. */
  resetTaskState(): void {
    this.taskState.clear();
    this.imageCache?.clear();
  }

  /** Host-only write receipt; never part of the result serialized to the model. */
  takeLastHostWriteReceipt(): ProjectAgentHostWriteReceipt | null {
    return this.writeTools.takeLastHostReceipt();
  }

  async dispatch(name: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    const handler = this.handlers.get(name);
    if (!handler) {
      if (name === 'readImage' && !this.readImageEligible) {
        return toolFail({
          code: 'vision_unavailable',
          message: 'readImage is not registered for the current model',
          retryable: false,
        });
      }
      if (name === 'runTerminalCommand' && !this.terminalEligible) {
        return toolFail({
          code: 'terminal_unavailable',
          message: 'runTerminalCommand is not registered for this Conversation',
          retryable: false,
        });
      }
      return toolFail({
        code: 'invalid_arguments',
        message: `Unknown tool: ${name}`,
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    if (name === 'readImage' && !this.readImageEligible) {
      return toolFail({
        code: 'vision_unavailable',
        message: 'readImage is not registered for the current model',
        retryable: false,
      });
    }
    if (name === 'runTerminalCommand' && !this.terminalEligible) {
      return toolFail({
        code: 'terminal_unavailable',
        message: 'runTerminalCommand is not registered for this Conversation',
        retryable: false,
      });
    }
    // Schema validation before dispatch (ADR0023): tool name and arguments
    // must pass the registered parameter schema; no text/JSON guessing.
    const definition = this.definitions.find((tool) => tool.name === name);
    const schemaError = definition
      ? validateAgentToolArguments(name, args, definition.parameters)
      : null;
    if (schemaError) return toolFail(schemaError);
    return handler(args, signal);
  }

  async call<Name extends ProjectAgentToolName>(
    name: Name,
    args: ProjectAgentToolArgsByName[Name],
  ): Promise<AgentToolResult<ProjectAgentToolResultByName[Name]>> {
    return this.dispatch(name, args) as Promise<AgentToolResult<ProjectAgentToolResultByName[Name]>>;
  }

  private registerAll(): void {
    this.register(
      'readProjectOverview',
      'Return cleaned project name, version, active scene, scene list, asset roots, and template info.',
      true,
      { type: 'object', additionalProperties: false, properties: {} },
      (args) => this.readTools.readProjectOverview(args),
    );
    this.register(
      'listProjectFiles',
      'List project-relative files with offset/limit pagination. total counts only the visible entries after forbidden paths are excluded, and excludedCount reports how many protected entries were filtered out, so total 0 plus excludedCount 0 means an empty project while a large excludedCount means everything is protected.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1 },
          prefix: { type: 'string' },
        },
      },
      (args) => this.readTools.listProjectFiles(asRecord(args)),
    );
    this.register(
      'readProjectText',
      'Read a project-relative or stable @mount text file by startLine + lineCount. @mount is an existing registered external-library reference, not a template. Binary files return metadata only. Scene files and project metadata are protected and return forbidden_path; use readScene / readProjectOverview / searchScene for scene content.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          lineCount: { type: 'integer', minimum: 1 },
        },
      },
      (args) => this.readTools.readProjectText(asRecord(args) as never),
    );
    this.register(
      'searchProjectText',
      'Search project text files with offset/limit pagination.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1 },
          prefix: { type: 'string' },
        },
      },
      (args) => this.readTools.searchProjectText(asRecord(args) as never),
    );
    this.register(
      'searchResources',
      'Search project assets, registered external libraries, and enabled templates; omit namespace to discover all. namespace "project" contains local project assets only and may be empty while mount:<id> libraries have resources. Use pathPrefix to browse immediate children of a project or mount directory (empty string browses a mount root): kind "directory" entries are navigation-only and expose pathPrefix, while files carry usable references. Combining pathPrefix with ownerId or outfitId searches files recursively below that prefix and intersects all filters. Internal dot directories/files are excluded. scope: "mount" means an existing registered external library with an @mount/<id>/... reference, not a template and not materialization-required. Only scope: "template" has materializationRequired: true and no direct reference.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          text: { type: 'string' },
          ownerId: { type: 'string' },
          outfitId: { type: 'string' },
          namespace: { type: 'string' },
          pathPrefix: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1 },
        },
      },
      (args) => this.readTools.searchResources(asRecord(args)),
    );
    this.register(
      'inspectResource',
      'Inspect a project-relative or @mount resource reference without materializing files. @mount is an existing registered external-library reference, not a template. For Live2D models, sizeBytes/modelDocumentBytes measure the entry document, not the full bundle. Motions are the keys declared by that model and may include multiple characters; ownerId does not restrict these keys.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        required: ['reference'],
        properties: {
          reference: { type: 'string' },
        },
      },
      (args) => this.readTools.inspectResource(asRecord(args) as never),
    );

    // Registered whenever an image read port exists; eligibility (the model's
    // imageInput capability) gates the definition and dispatch surface.
    if (this.readPorts.image) {
      this.register(
        'readImage',
        'Read a project-relative or @mount image as a bounded multimodal payload.',
        true,
        {
          type: 'object',
          additionalProperties: false,
          required: ['reference'],
          properties: {
            reference: { type: 'string' },
            detail: { type: 'string', enum: ['auto', 'low', 'high'] },
          },
        },
        (args) => this.readTools.readImage(asRecord(args) as never),
      );
    }

    this.register(
      'readScene',
      'Read the active formal scene as a flat Agent line view; one broad read returns up to 500 lines.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          startLine: { type: 'integer', minimum: 1 },
          lineCount: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
      (args) => this.readTools.readScene(asRecord(args)),
    );
    this.register(
      'searchScene',
      'Search active scene lines by text, family, or time range.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          family: { type: 'string' },
          timeFrom: { type: 'number' },
          timeTo: { type: 'number' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1 },
          contextLines: { type: 'integer', minimum: 0 },
        },
      },
      (args) => this.readTools.searchScene(asRecord(args)),
    );
    this.register(
      'validateScene',
      'Run schema, semantic, compiler, and strict resource diagnostics on the active scene.',
      true,
      { type: 'object', additionalProperties: false, properties: {} },
      (args) => this.readTools.validateScene(args as never),
    );
    this.register(
      'runTerminalCommand',
      'Run an arbitrary terminal command with the desktop application user permissions. Available only in an explicitly full-access Conversation. On Windows, the default shell is PowerShell 7 (pwsh), with Windows PowerShell fallback. Output is bounded; use this tool only for the current user request.',
      true,
      {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1 },
          shell: { enum: ['default', 'powershell'] },
          cwd: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
          maxOutputChars: { type: 'integer', minimum: 1, maximum: 200000 },
        },
      },
      (args, signal) => this.terminalTools.runTerminalCommand(asRecord(args) as never, signal),
    );

    for (const [name, schema] of Object.entries(WRITE_TOOL_SCHEMAS)) {
      if (name === 'applyAuthoringTransaction') continue;
      this.register(
        name as ProjectAgentToolName,
        WRITE_TOOL_DESCRIPTIONS[name] ?? `Apply a single ${name} semantic scene operation as an atomic transaction.`,
        false,
        schema,
        (args, signal) => {
          const record = asRecord(args);
          switch (name) {
            case 'insertStatement':
              return this.writeTools.insertStatement(record as never, signal);
            case 'insertCompanion':
              return this.writeTools.insertCompanion(record as never, signal);
            case 'updateStatement':
              return this.writeTools.updateStatement(record as never, signal);
            case 'updateCompanion':
              return this.writeTools.updateCompanion(record as never, signal);
            case 'deleteSourceItem':
              return this.writeTools.deleteSourceItem(record as never, signal);
            case 'moveSourceItem':
              return this.writeTools.moveSourceItem(record as never, signal);
            case 'reorderCompanions':
              return this.writeTools.reorderCompanions(record as never, signal);
            default:
              return Promise.resolve(toolFail({
                code: 'invalid_arguments',
                message: `Unknown write tool: ${name}`,
                retryable: false,
              }));
          }
        },
      );
    }

    this.register(
      'applyAuthoringTransaction',
      WRITE_TOOL_DESCRIPTIONS['applyAuthoringTransaction'] as string,
      false,
      WRITE_TOOL_SCHEMAS['applyAuthoringTransaction'],
      (args, signal) => this.writeTools.applyAuthoringTransaction(asRecord(args) as never, signal),
    );
  }

  private register(
    name: ProjectAgentToolName,
    description: string,
    readOnly: boolean,
    parameters: Readonly<Record<string, unknown>>,
    handler: ToolHandler,
  ): void {
    this.definitions.push({ name, description, readOnly, parameters });
    this.handlers.set(name, handler);
  }
}

function asRecord(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}
