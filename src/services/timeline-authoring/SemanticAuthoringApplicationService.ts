import type {
  SemanticAuthorIntent,
  SemanticAuthorReceipt,
} from '../../api/types/authoring';
import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import type { CharacterDirectoryCommand } from '../../api/types/character-directory';
import type { AgentValidateSceneDiagnostic } from '../../api/types/project-agent';
import type { ProjectTemplateConfiguration } from '../../api/types/project';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { AiScriptSegmentSemanticCompileResult } from '../ai-authoring/AiScriptSegmentCompiler';
import {
  authorAiScriptSegmentIntoCurrentSceneDocument,
  type AuthorAiScriptSegmentOptions,
  type AuthorAiScriptSegmentResult,
} from '../ai-authoring/AiScriptSegmentDocument';
import {
  applyCharacterDirectoryCommandToCurrentSceneDocument,
  type SemanticCharacterDirectoryReceipt,
} from '../character-directory/SemanticCharacterDirectory';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import { getSceneDocumentCanonicalOrder, withSceneDocumentCanonicalOrder } from '../semantic-scene/SceneDocumentCanonicalOrder';
import { SemanticTimelineAuthoringService } from './SemanticTimelineAuthoringService';
import type {
  MaterializedResourceReceipt,
  ResourceAuthoringService,
  ResourceCandidate,
  ResourceResolutionContext,
} from '../resource-authoring';

export type SemanticResourceSelection =
  | { input: string; context: ResourceResolutionContext }
  | { input: string; candidate: ResourceCandidate };

export interface SemanticResourceAuthoringRequest {
  selection: SemanticResourceSelection;
  buildIntent(reference: string): SemanticAuthorIntent;
}

export interface SemanticResourceAuthoringReceipt {
  authoring: SemanticAuthorReceipt;
  materialization: MaterializedResourceReceipt;
}

/** Authoritative-gate failure inside the exact-version commit seam (ADR0023). */
export class SemanticAuthoringGateError extends Error {
  readonly code = 'gate_failed' as const;
  readonly diagnostics: readonly AgentValidateSceneDiagnostic[];

  constructor(diagnostics: readonly AgentValidateSceneDiagnostic[], message?: string) {
    super(message ?? 'Semantic authoring gate rejected the candidate');
    this.name = 'SemanticAuthoringGateError';
    this.diagnostics = diagnostics;
  }
}

export interface ExactVersionAuthoringCommitRequest {
  readonly candidate: CurrentSceneDocument;
  /** The Agent base snapshot version; only exact equality may commit. */
  readonly expectedVersion: number;
  /** Complete authoritative gate re-run inside the serial queue operation. */
  readonly validate: (document: CurrentSceneDocument) => readonly AgentValidateSceneDiagnostic[]
    | Promise<readonly AgentValidateSceneDiagnostic[]>;
}

export interface ExactVersionAuthoringCommitResult {
  readonly version: number;
  readonly warnings: readonly AgentValidateSceneDiagnostic[];
}

export interface SemanticCharacterResourceReceipt {
  character: SemanticCharacterDirectoryReceipt;
  materialization: MaterializedResourceReceipt;
}

/** Read at commit time so queued writes use the current workbench preference. */
export interface DialogueFlowModeReader {
  getDialogueFlowMode(): 'auto' | 'manual';
}

export interface DialogueDefaultsReader {
  getDialogueDefaults(): Pick<ProjectTemplateConfiguration, 'dialoguePresentation' | 'dialogueTemplate' | 'defaults'> | undefined;
}

interface SemanticHistoryEntry {
  readonly before: CurrentSceneDocument;
  readonly after: CurrentSceneDocument;
}

export class SemanticAuthoringApplicationService {
  private mutationChain: Promise<unknown> = Promise.resolve();
  private readonly undoStack: SemanticHistoryEntry[] = [];
  private readonly redoStack: SemanticHistoryEntry[] = [];
  private readonly historyListeners = new Set<() => void>();

  constructor(
    private readonly documentStore: DocumentStore,
    private readonly coordinator: SemanticDocumentCoordinator,
    private readonly authoring = new SemanticTimelineAuthoringService(),
    private readonly resourceAuthoring?: ResourceAuthoringService,
    private readonly dialogueFlowMode?: DialogueFlowModeReader,
    private readonly dialogueDefaults?: DialogueDefaultsReader,
  ) {}

  private readDialogueFlowMode(): 'auto' | 'manual' | undefined {
    return this.dialogueFlowMode?.getDialogueFlowMode();
  }

  author(intent: SemanticAuthorIntent): Promise<SemanticAuthorReceipt> {
    return this.enqueue(async (document) => {
      const result = this.authoring.author(document, intent, this.readDialogueFlowMode());
      const next = intent.kind === 'duplicate-statements'
        ? result.document
        : this.applyCreatedDialogueDefaults(result.document, result.receipt.createdStatementIds);
      await this.commit(document, next);
      return result.receipt;
    });
  }

  authorTransaction(intents: readonly SemanticAuthorIntent[]): Promise<SemanticAuthorReceipt>;
  authorTransaction(
    buildIntents: (document: CurrentSceneDocument) => readonly SemanticAuthorIntent[],
  ): Promise<SemanticAuthorReceipt>;
  authorTransaction(
    input: readonly SemanticAuthorIntent[] | ((document: CurrentSceneDocument) => readonly SemanticAuthorIntent[]),
  ): Promise<SemanticAuthorReceipt> {
    return this.enqueue(async (document) => {
      const intents = typeof input === 'function' ? input(document) : input;
      if (intents.length === 0) {
        throw new Error('Semantic authoring transaction must contain at least one intent');
      }

      let nextDocument = document;
      const receipts: SemanticAuthorReceipt[] = [];
      const flowMode = this.readDialogueFlowMode();
      for (const intent of intents) {
        const result = this.authoring.author(nextDocument, intent, flowMode);
        nextDocument = intent.kind === 'duplicate-statements'
          ? result.document
          : this.applyCreatedDialogueDefaults(result.document, result.receipt.createdStatementIds);
        receipts.push(result.receipt);
      }

      await this.commit(document, nextDocument);
      return mergeSemanticAuthorReceipts(intents, receipts);
    });
  }

  authorResource(request: SemanticResourceAuthoringRequest): Promise<SemanticResourceAuthoringReceipt> {
    return this.enqueue(async (document) => {
      if (!this.resourceAuthoring) throw new Error('Resource authoring service is not configured');
      const materialized = 'candidate' in request.selection
        ? await this.resourceAuthoring.materializeCandidate(request.selection.input, request.selection.candidate)
        : await this.resourceAuthoring.resolveAndMaterialize(request.selection.input, request.selection.context);
      const intent = request.buildIntent(materialized.reference);
      const result = this.authoring.author(document, intent, this.readDialogueFlowMode());
      const next = intent.kind === 'duplicate-statements'
        ? result.document
        : this.applyCreatedDialogueDefaults(result.document, result.receipt.createdStatementIds);
      await this.commit(document, next);
      const sideEffects = materialized.receipt.operation !== 'existing-project-reference'
        ? [...result.receipt.sideEffects, {
            type: 'resource-import' as const,
            sourcePath: materialized.receipt.sourcePath,
            finalPath: materialized.receipt.projectPath,
            importKind: materialized.receipt.importKind,
          }]
        : result.receipt.sideEffects;
      return {
        authoring: { ...result.receipt, sideEffects },
        materialization: materialized.receipt,
      };
    });
  }

  applyCharacterCommand(command: CharacterDirectoryCommand): Promise<SemanticCharacterDirectoryReceipt> {
    return this.enqueue(async (document) => {
      const result = applyCharacterDirectoryCommandToCurrentSceneDocument(document, command);
      await this.commit(document, result.document);
      return result.receipt;
    });
  }

  applyCharacterResourceCommand(
    selection: SemanticResourceSelection,
    buildCommand: (reference: string) => CharacterDirectoryCommand,
  ): Promise<SemanticCharacterResourceReceipt> {
    return this.enqueue(async (document) => {
      if (!this.resourceAuthoring) throw new Error('Resource authoring service is not configured');
      const materialized = 'candidate' in selection
        ? await this.resourceAuthoring.materializeCandidate(selection.input, selection.candidate)
        : await this.resourceAuthoring.resolveAndMaterialize(selection.input, selection.context);
      const result = applyCharacterDirectoryCommandToCurrentSceneDocument(document, buildCommand(materialized.reference));
      await this.commit(document, result.document);
      return { character: result.receipt, materialization: materialized.receipt };
    });
  }

  authorAiScriptSegment(
    compiled: AiScriptSegmentSemanticCompileResult,
    anchorTime: number,
    correlationId: string,
    options: AuthorAiScriptSegmentOptions = {},
  ): Promise<AuthorAiScriptSegmentResult> {
    return this.enqueue(async (document) => {
      const result = authorAiScriptSegmentIntoCurrentSceneDocument(
        document,
        compiled,
        anchorTime,
        correlationId,
        options,
      );
      const next = this.applyCreatedDialogueDefaults(result.document, result.receipt.createdStatementIds);
      await this.commit(document, next);
      return { ...result, document: next };
    });
  }

  private applyCreatedDialogueDefaults(
    document: CurrentSceneDocument,
    createdStatementIds: readonly string[],
  ): CurrentSceneDocument {
    if (createdStatementIds.length === 0) return document;
    const defaults = this.dialogueDefaults?.getDialogueDefaults();
    const styleId = defaults?.defaults?.dialogueStyleId;
    const builtin = styleId === 'glass' || styleId === 'minimal' || styleId === 'classic' ? styleId : undefined;
    const presentation = builtin ? undefined : defaults?.dialoguePresentation;
    const template = builtin ?? defaults?.dialogueTemplate;
    if (!presentation && !template) return document;

    const createdIds = new Set(createdStatementIds);
    return withSceneDocumentCanonicalOrder({
      ...document,
      statements: document.statements.map((statement) => {
        if (!createdIds.has(statement.id) || statement.type !== 'dialogue'
          || statement.params.presentation || statement.params.template) return statement;
        return {
          ...statement,
          params: {
            ...statement.params,
            ...(presentation ? { presentation: JSON.parse(JSON.stringify(presentation)) } : { template }),
          },
        };
      }),
    }, getSceneDocumentCanonicalOrder(document));
  }

  replaceDocument(
    document: CurrentSceneDocument,
    recordHistory = true,
    expectedVersion?: number,
  ): Promise<CurrentSceneDocument> {
    return this.enqueue(async (current) => {
      if (expectedVersion !== undefined && this.documentStore.version !== expectedVersion) {
        throw new Error('Scene document version changed before queued replacement could be applied');
      }
      await this.coordinator.applyDocument(document, this.documentStore.filePath ?? undefined);
      const committed = this.requireDocument();
      if (recordHistory) this.recordHistory(current, committed);
      return committed;
    });
  }

  replaceDocumentWithSideEffect(
    document: CurrentSceneDocument,
    sideEffect: () => void | Promise<void>,
  ): Promise<CurrentSceneDocument> {
    return this.enqueue(async (current) => {
      await this.coordinator.applyDocument(document, this.documentStore.filePath ?? undefined);
      try {
        await sideEffect();
      } catch (error) {
        await this.coordinator.applyDocument(current, this.documentStore.filePath ?? undefined);
        throw error;
      }
      const committed = this.requireDocument();
      this.recordHistory(current, committed);
      return committed;
    });
  }

  /**
   * ADR0023 exact-version authoritative commit. Runs inside the SAME serial
   * mutation queue as human authoring: re-reads the current DocumentStore
   * version, requires exact equality with the Agent base snapshot, re-runs
   * the complete authoritative gate, then commits in the same serial
   * operation. Any version change throws `version_conflict` — no field-level
   * three-way merge is ever attempted.
   */
  commitExactVersion(request: ExactVersionAuthoringCommitRequest): Promise<ExactVersionAuthoringCommitResult> {
    return this.enqueue(async (document) => {
      if (this.documentStore.version !== request.expectedVersion) {
        const error = new Error(
          `Scene document version changed (expected ${request.expectedVersion}, found ${this.documentStore.version})`,
        );
        (error as Error & { code: string }).code = 'version_conflict';
        throw error;
      }
      const diagnostics = await request.validate(request.candidate);
      const errors = diagnostics.filter((item) => item.severity === 'error');
      if (errors.length > 0) {
        throw new SemanticAuthoringGateError(errors);
      }
      await this.coordinator.applyDocument(request.candidate, this.documentStore.filePath ?? undefined);
      this.recordHistory(document, this.requireDocument());
      return {
        version: this.documentStore.version,
        warnings: diagnostics.filter((item) => item.severity === 'warning'),
      };
    });
  }

  getDocumentSnapshot(): CurrentSceneDocument {
    return this.requireDocument();
  }

  async undo(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    await this.coordinator.applyDocument(entry.before, this.documentStore.filePath ?? undefined);
    this.redoStack.push(entry);
    this.notifyHistory();
    return true;
  }

  async redo(): Promise<boolean> {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    await this.coordinator.applyDocument(entry.after, this.documentStore.filePath ?? undefined);
    this.undoStack.push(entry);
    this.notifyHistory();
    return true;
  }

  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notifyHistory();
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  subscribeHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  private enqueue<T>(operation: (document: CurrentSceneDocument) => Promise<T>): Promise<T> {
    const task = this.mutationChain
      .catch(() => undefined)
      .then(() => operation(this.requireDocument()));
    this.mutationChain = task;
    return task;
  }

  private async commit(before: CurrentSceneDocument, after: CurrentSceneDocument): Promise<void> {
    await this.coordinator.applyDocument(after, this.documentStore.filePath ?? undefined);
    this.recordHistory(before, this.requireDocument());
  }

  private recordHistory(before: CurrentSceneDocument, after: CurrentSceneDocument): void {
    this.undoStack.push({ before, after });
    this.redoStack.length = 0;
    this.notifyHistory();
  }

  private notifyHistory(): void {
    this.historyListeners.forEach((listener) => listener());
  }

  private requireDocument(): CurrentSceneDocument {
    const document = this.documentStore.getCurrentSceneDocumentSnapshot();
    if (!document) throw new Error('No semantic scene document loaded');
    return document;
  }
}

function mergeSemanticAuthorReceipts(
  intents: readonly SemanticAuthorIntent[],
  receipts: readonly SemanticAuthorReceipt[],
): SemanticAuthorReceipt {
  const first = receipts[0];
  const unique = (values: readonly string[]) => [...new Set(values)];
  const timeRanges = receipts
    .map((receipt) => receipt.timeRange)
    .filter((range): range is { start: number; end: number } => !!range);

  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: intents[0].correlationId,
    intentType: intents[0].kind,
    origin: intents[0].origin,
    historyDescriptor: {
      key: 'timeline.author.transaction',
      args: { count: intents.length },
      fallbackLabel: `语义事务（${intents.length} 项）`,
    },
    warnings: receipts.flatMap((receipt) => receipt.warnings),
    resolvedScope: first.resolvedScope,
    createdStatementIds: unique(receipts.flatMap((receipt) => receipt.createdStatementIds)),
    updatedStatementIds: unique(receipts.flatMap((receipt) => receipt.updatedStatementIds)),
    deletedStatementIds: unique(receipts.flatMap((receipt) => receipt.deletedStatementIds)),
    createdCompanionLocators: uniqueLocators(receipts.flatMap((receipt) => receipt.createdCompanionLocators)),
    updatedCompanionLocators: uniqueLocators(receipts.flatMap((receipt) => receipt.updatedCompanionLocators)),
    deletedCompanionLocators: uniqueLocators(receipts.flatMap((receipt) => receipt.deletedCompanionLocators)),
    createdMarkerIds: unique(receipts.flatMap((receipt) => receipt.createdMarkerIds)),
    deletedMarkerIds: unique(receipts.flatMap((receipt) => receipt.deletedMarkerIds)),
    createdMarkers: receipts.flatMap((receipt) => receipt.createdMarkers),
    deletedMarkers: receipts.flatMap((receipt) => receipt.deletedMarkers),
    sideEffects: receipts.flatMap((receipt) => receipt.sideEffects),
    timeRange: timeRanges.length > 0
      ? {
          start: Math.min(...timeRanges.map((range) => range.start)),
          end: Math.max(...timeRanges.map((range) => range.end)),
        }
      : undefined,
  };
}

function uniqueLocators<T extends { statementId: string; companionId: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.statementId}\u0000${value.companionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
