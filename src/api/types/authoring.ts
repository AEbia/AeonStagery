import type { AiRhythmPace } from './ai-authoring';
import type { ResourceImportKind } from './project';
import type { MarkerRole, SceneMarker } from './scene-common';
import type {
  CharacterMotionOutput,
  DialogueImagePresentation,
  DialogueCompanion,
  DialogueCompanionDraft,
  ScenePaceTier,
  SceneStatement,
  SceneStatementDraft,
} from './semantic-scene';

export const AUTHORING_SCHEMA_VERSION = 3 as const;

export type AuthoringOrigin =
  | 'blank-context-menu'
  | 'timeline-list-gap'
  | 'timeline-drop'
  | 'block-context-menu'
  | 'timeline-editor'
  | 'marker-prompt'
  | 'ai-script-panel'
  | 'sequential-flow'
  | 'template-config'
  | 'voice-workbench'
  | 'raw-script'
  | 'collaboration';

export type AuthoringScope =
  | { kind: 'none' }
  | { kind: 'character'; charId: string }
  | { kind: 'inferred-character'; charId: string; source: 'drop-target' | 'blank-menu-track' };

export interface ResolvedAuthoringScope {
  kind: AuthoringScope['kind'];
  charId?: string;
  source?: string;
}

export interface HistoryDescriptor {
  key: string;
  args: Record<string, string | number | boolean | null>;
  fallbackLabel: string;
}

export interface AuthoringWarning {
  severity: 'warning';
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ScriptSegmentMarkerDraft {
  offset: number;
  label: string;
  color?: string;
  role?: MarkerRole;
}

export interface AuthoringSideEffect {
  type: 'resource-import';
  sourcePath: string;
  finalPath: string;
  importKind: ResourceImportKind;
}

export interface StatementLocator {
  statementId: string;
}

export interface CompanionLocator {
  statementId: string;
  companionId: string;
}

export type SemanticAuthoringLocator =
  | ({ kind: 'statement' } & StatementLocator)
  | ({ kind: 'companion' } & CompanionLocator);

interface BaseSemanticAuthorIntent {
  version: typeof AUTHORING_SCHEMA_VERSION;
  correlationId: string;
  origin: AuthoringOrigin;
  scope?: AuthoringScope;
}

export interface InsertStatementAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'insert-statement';
  anchorTime: number;
  beforeStatementId?: string;
  statement: SceneStatementDraft;
  resource?: {
    filePath?: string;
    sourcePath?: string;
    sourceKind?: string;
    importKind?: ResourceImportKind;
  };
}

export interface InsertDialogueCompanionAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'insert-dialogue-companion';
  parentStatementId: string;
  companion: DialogueCompanionDraft;
}

export interface UpdateDialogueCompanionAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'update-dialogue-companion';
  locator: CompanionLocator;
  patch: Partial<DialogueCompanion>;
}

export interface DeleteDialogueCompanionsAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'delete-dialogue-companions';
  locators: CompanionLocator[];
}

export interface ReorderDialogueCompanionsAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'reorder-dialogue-companions';
  parentStatementId: string;
  orderedCompanionIds: string[];
}

export interface UpdateStatementAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'update-statement';
  statementId: string;
  patch: Partial<SceneStatement>;
  /** 全自动重排:对白语句变更后其后的所有语句按槽位 delta 平移。缺省为 false。 */
  flow?: boolean;
}

export interface MoveTimelineLocatorsAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'move-timeline-locators';
  moves: Array<{
    locator: SemanticAuthoringLocator;
    time: number;
  }>;
}

export interface DeleteStatementsAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'delete-statements';
  statementIds: string[];
  /** 全自动重排:删除对白后其后的所有语句按被删对白跨度回移。缺省为 false。 */
  flow?: boolean;
}

export interface DuplicateStatementsAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'duplicate-statements';
  statementIds: string[];
}

export interface AddMarkerAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'add-marker';
  time: number;
  label: string;
  color?: string;
  role?: MarkerRole;
}

export interface RemoveMarkerAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'remove-marker';
  markerId: string;
}

export interface InsertScriptSegmentAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'insert-script-segment';
  anchorTime: number;
  statements: SceneStatementDraft[];
  markers?: ScriptSegmentMarkerDraft[];
  durationSeconds?: number;
}

export interface AppendSequentialLinesAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'append-sequential-lines';
  lines: string[];
  pace?: AiRhythmPace;
}

/** 行间插入对白:插在 beforeStatementId 之前(缺省为链尾),时间由服务端按链语义计算。 */
export interface InsertDialogueInChainAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'insert-dialogue-in-chain';
  text: string;
  beforeStatementId?: string;
  /** 全自动重排:插入后其后所有语句按新句跨度平移。缺省为 false(不自动重排)。 */
  flow?: boolean;
  presentation?: DialogueImagePresentation;
  template?: 'glass' | 'minimal' | 'classic';
}

export interface UpdateScenePaceTierAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'update-scene-pace-tier';
  tier: ScenePaceTier;
}

/** 重排对白链:按给定顺序重排场景内全部对白语句。flow 开启时按两段 delta 级联重算时间。 */
export interface ReorderDialogueChainAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'reorder-dialogue-chain';
  orderedDialogueIds: string[];
  /** 被拖拽的对白 id(客户端拖拽时知道)。 */
  movedStatementId?: string;
  /** 精确的 root 语句落点；null 表示末尾，缺省时沿用对白链定位。 */
  beforeStatementId?: string | null;
  /** 全自动重排:旧槽位之后回移、新槽位之前移,被拖对白落在新槽位。缺省为 false(只动被拖句)。 */
  flow?: boolean;
}

/**
 * Replace the motion output of a `characterPerformance` statement or dialogue
 * companion with a new self-contained custom motion (ADR-0029 keyframe
 * editing and resource-motion conversion). The intent carries the full new
 * custom motion; the source entity must already hold a motion of the same
 * origin — a custom motion with the same `derivedFrom.key`, or a resource
 * motion whose `key` equals the new `derivedFrom.key`. Sibling performance
 * outputs (Expression / LookAt / Blink) are preserved.
 */
export interface UpdateCustomMotionKeyframesAuthorIntent extends BaseSemanticAuthorIntent {
  kind: 'update-custom-motion-keyframes';
  locator: StatementLocator | CompanionLocator;
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
}

export type SemanticAuthorIntent =
  | InsertStatementAuthorIntent
  | InsertDialogueCompanionAuthorIntent
  | UpdateDialogueCompanionAuthorIntent
  | DeleteDialogueCompanionsAuthorIntent
  | ReorderDialogueCompanionsAuthorIntent
  | UpdateStatementAuthorIntent
  | MoveTimelineLocatorsAuthorIntent
  | DeleteStatementsAuthorIntent
  | DuplicateStatementsAuthorIntent
  | AddMarkerAuthorIntent
  | RemoveMarkerAuthorIntent
  | InsertScriptSegmentAuthorIntent
  | AppendSequentialLinesAuthorIntent
  | InsertDialogueInChainAuthorIntent
  | UpdateScenePaceTierAuthorIntent
  | ReorderDialogueChainAuthorIntent
  | UpdateCustomMotionKeyframesAuthorIntent;

export interface SemanticAuthorReceipt {
  version: typeof AUTHORING_SCHEMA_VERSION;
  correlationId: string;
  intentType: SemanticAuthorIntent['kind'];
  origin: AuthoringOrigin;
  historyDescriptor: HistoryDescriptor;
  warnings: AuthoringWarning[];
  resolvedScope: ResolvedAuthoringScope;
  createdStatementIds: string[];
  updatedStatementIds: string[];
  deletedStatementIds: string[];
  createdCompanionLocators: CompanionLocator[];
  updatedCompanionLocators: CompanionLocator[];
  deletedCompanionLocators: CompanionLocator[];
  createdMarkerIds: string[];
  deletedMarkerIds: string[];
  createdMarkers: SceneMarker[];
  deletedMarkers: SceneMarker[];
  sideEffects: AuthoringSideEffect[];
  timeRange?: {
    start: number;
    end: number;
  };
}
