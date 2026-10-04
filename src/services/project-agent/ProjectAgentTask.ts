import type {
  AgentToolDiagnostic,
  AgentToolResult,
  AgentWriteReceipt,
  ProjectAgentHostWriteReceipt,
  ProjectAgentAccessMode,
} from '../../api/types/project-agent';
import type { ProjectAgentJournalRunningRecord } from './ProjectAgentJournal';
import type { JsonObject, JsonValue } from '../../api/types/ai-conversation';

export const PROJECT_AGENT_PROTOCOL_VERSION = 1 as const;
export const PROJECT_AGENT_JOURNAL_VERSION = 1 as const;
export const PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS = 8192 as const;
/** Bound for the auto conversation title derived from the first user message. */
export const PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH = 60 as const;

/**
 * Prefix of host-injected recovery notes appended as user-role conversation
 * messages (ADR0023). These notes are addressed to the model (reread/replan
 * facts), never user input: the Agent window hides user-role messages with
 * this prefix from the thread.
 */
export const PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX = 'Host recovery note' as const;

/**
 * Deterministic auto conversation title (ADR0023): the first non-empty line
 * of the first user message, trimmed and bounded to
 * `PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH` characters (truncated with a
 * trailing ellipsis). Always derivable from the same first-user text —
 * stable across restarts and never user-authored. `userRename` is the ONLY
 * way to override the display title and is never derived here.
 */
export function deriveConversationTitle(firstUserMessageText: string): string {
  const firstLine = firstUserMessageText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  if (firstLine.length <= PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH - 1)}…`;
}

/**
 * Display title of a conversation (ADR0023): an optional user rename
 * overrides the auto title; an empty/whitespace rename falls back to the
 * auto title. Never derives a rename.
 */
export function effectiveConversationTitle(options: {
  readonly title?: string;
  readonly userRename?: string;
}): string {
  const rename = options.userRename?.trim() ?? '';
  if (rename.length > 0) return rename;
  return options.title ?? '';
}

/**
 * Closed union of host-projected tool activities (ADR0023): read, write
 * (committed or no-change) and tool errors. Activities are deterministic
 * short display facts derived from the real tool-result envelope — never
 * free-form model text and never a copy of a receipt.
 */
export type ProjectAgentActivityKind =
  | 'read'
  | 'write'
  | 'write_no_change'
  | 'tool_error'
  | 'context_compaction';

/**
 * One user-visible tool activity (ADR0023): minimal display facts only. The
 * activity text is deterministically derived from the tool name plus the
 * result envelope (outcome and trusted counts/status); it never copies the
 * receipt (the receipt stays the single complete persistent copy inside its
 * tool-result message).
 */
export interface ProjectAgentActivityRecord {
  readonly kind: ProjectAgentActivityKind;
  readonly toolName: string;
  /**
   * Stable short display text, e.g. 「读取 scene」 or 「已提交 2 处修改」.
   * The matching tool-message toolCallId (ADR0023): the thread window binds a
   * flow tool anchor to its activity by this id instead of by append-order
   * position. Absent for host activities that have no tool message — context
   * compaction and terminal scene-gate failures — and on legacy records;
   * those render as standalone rows.
   */
  readonly toolCallId?: string;
  readonly text: string;
  /**
   * Deterministic short display detail (e.g. 「L5~L24 · 20 行」, 「text=森林
   * · kind=background」). Additive: old journal records without it keep the
   * plain activity text.
   */
  readonly detail?: string;
  /** Optional bounded facts and read-result content for on-demand inspection. */
  readonly details?: {
    readonly paths?: readonly string[];
    readonly lineRange?: { readonly start: number; readonly end: number };
    readonly query?: string;
    readonly matches?: number;
    readonly reference?: string;
    readonly pagination?: { readonly truncated: boolean; readonly hasMore: boolean; readonly remaining?: number };
    readonly diagnostics?: { readonly errors: number; readonly warnings: number };
    readonly counts?: { readonly inserted: number; readonly updated: number; readonly deleted: number; readonly moved: number };
    /** Object-level change facts projected from the host authoring receipt (ADR0024). */
    readonly changedObjects?: readonly {
      readonly statementId: string;
      readonly companionId?: string;
      readonly kind: 'inserted' | 'updated' | 'deleted' | 'moved' | 'reordered';
    }[];
    /** Affected scene time range [start, end] in scene seconds (ADR0024). */
    readonly timeRange?: { readonly start: number; readonly end: number };
    /** Actual successful read content, recursively redacted and length-bounded. */
    readonly content?: {
      readonly format: 'text' | 'json';
      readonly text: string;
      readonly truncated: boolean;
    };
    readonly safe?: boolean;
  };
}

type MutableProjectAgentActivityDetails = {
  paths?: string[];
  lineRange?: { start: number; end: number };
  query?: string;
  matches?: number;
  reference?: string;
  pagination?: { truncated: boolean; hasMore: boolean; remaining?: number };
  diagnostics?: { errors: number; warnings: number };
  counts?: { inserted: number; updated: number; deleted: number; moved: number };
  changedObjects?: {
    statementId: string;
    companionId?: string;
    kind: 'inserted' | 'updated' | 'deleted' | 'moved' | 'reordered';
  }[];
  timeRange?: { start: number; end: number };
  content?: { format: 'text' | 'json'; text: string; truncated: boolean };
  safe?: boolean;
};

/** Deterministic display texts keyed by tool name (non-receipt activities). */
const PROJECT_AGENT_ACTIVITY_TEXT: Readonly<Record<string, string>> = {
  readScene: '读取 scene',
  searchScene: '搜索 scene',
  validateScene: '校验 scene',
  readProjectOverview: '读取项目概览',
  listProjectFiles: '读取项目文件',
  readProjectText: '读取文件',
  searchProjectText: '搜索项目文本',
  searchResources: '搜索资源',
  inspectResource: '检查资源',
  readImage: '读取图片',
  runTerminalCommand: '运行命令',
};

/** UI-facing tool display name for live progress rows; falls back to the raw name. */
export function projectAgentToolDisplayName(toolName: string): string {
  return PROJECT_AGENT_ACTIVITY_TEXT[toolName] ?? toolName;
}

function isReceiptEnvelope(data: unknown): data is AgentWriteReceipt {
  return !!data
    && typeof data === 'object'
    && 'status' in data
    && 'counts' in data
    && 'outcomes' in data;
}

/**
 * Deterministic activity projection from the real tool-result envelope
 * (ADR0023): same tool name + outcome + counts/status always yields the same
 * activity. Read/probe successes produce the stable read text; write receipts
 * produce a trusted total change count from the receipt counts; failures
 * produce the error code. No timestamps and no model narrative. The optional
 * `detail` is derived deterministically from the call arguments and the
 * result envelope (line ranges, search queries, resource references). The
 * expandable content is a bounded, recursively-redacted projection of the
 * actual successful read result.
 */
export function projectToolActivity(
  toolName: string,
  result: AgentToolResult<unknown>,
  args?: JsonObject,
): ProjectAgentActivityRecord {
  if (!result.ok) {
    const facts = activityFactsFromDiagnostics(result.error.diagnostics);
    return {
      kind: 'tool_error',
      toolName,
      text: `失败 (${result.error.code})`,
      ...(facts ? { details: facts } : {}),
    };
  }
  if (isReceiptEnvelope(result.data)) {
    if (result.data.status === 'committed') {
      const count = result.data.counts.inserted
        + result.data.counts.updated
        + result.data.counts.deleted
        + result.data.counts.moved;
      return {
        kind: 'write',
        toolName,
        text: `已提交 ${count} 处修改`,
        details: {
          counts: {
            inserted: result.data.counts.inserted,
            updated: result.data.counts.updated,
            deleted: result.data.counts.deleted,
            moved: result.data.counts.moved,
          },
          safe: true,
        },
      };
    }
    return {
      kind: 'write_no_change',
      toolName,
      text: '写入无变更',
    };
  }
  const detail = activityDetail(toolName, result.data, args);
  const facts = activityFacts(toolName, result.data, args, {
    hasMore: result.hasMore,
    truncated: result.truncated,
  });
  const content = activityReadContent(toolName, result.data, {
    hasMore: result.hasMore,
    truncated: result.truncated,
  }, args);
  return {
    kind: 'read',
    toolName,
    text: PROJECT_AGENT_ACTIVITY_TEXT[toolName] ?? `读取 ${toolName}`,
    ...(detail ? { detail } : {}),
    ...(facts || content ? {
      details: {
        ...(facts ?? {}),
        ...(content ? { content } : {}),
      },
    } : {}),
  };
}

/**
 * Object-level write activity projected deterministically from the committed
 * HOST authoring receipt (ADR0024): changed source identities, change
 * categories, and the affected scene time range. It never copies the receipt
 * wholesale and never exposes document versions; the model-visible tool
 * result stays minimal and is never used here.
 */
export function projectHostWriteActivity(
  toolName: string,
  receipt: ProjectAgentHostWriteReceipt,
): ProjectAgentActivityRecord {
  const changeCount = receipt.outcomes.filter((outcome) => outcome.kind !== 'no_change').length;
  const details: MutableProjectAgentActivityDetails = {
    counts: {
      inserted: receipt.counts.inserted,
      updated: receipt.counts.updated,
      deleted: receipt.counts.deleted,
      moved: receipt.counts.moved,
    },
    ...(receipt.changedObjects.length > 0
      ? { changedObjects: receipt.changedObjects.map((changed) => ({ ...changed })) }
      : {}),
    ...(receipt.timeRange ? { timeRange: { ...receipt.timeRange } } : {}),
    safe: true,
  };
  return {
    kind: 'write',
    toolName,
    text: `已提交 ${changeCount} 处修改`,
    details,
  };
}

const ACTIVITY_LIST_LIMIT = 25;
const ACTIVITY_CONTENT_MAX_CHARS = 24_000;
const ACTIVITY_CONTENT_OMISSION = '[redacted]';
const ACTIVITY_CONTENT_CIRCULAR = '[circular]';
const ACTIVITY_SENSITIVE_KEYS = new Set(['reasoning', 'reasoning_content', 'reasoningcontent']);

function activityReadContent(
  toolName: string,
  data: unknown,
  resultPagination: { readonly hasMore?: boolean; readonly truncated?: boolean },
  args?: JsonObject,
): NonNullable<ProjectAgentActivityRecord['details']>['content'] | undefined {
  if (data === undefined) return undefined;
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  if (!record) return undefined;
  const dataTruncated = record.truncated === true || record.hasMore === true;
  const truncated = resultPagination.truncated === true
    || resultPagination.hasMore === true
    || dataTruncated;

  if (toolName === 'readProjectText'
    && record.binary !== true
    && Array.isArray(record.lines)
    && record.lines.every((line) => typeof line === 'string')) {
    return boundedActivityContent('text', record.lines.join('\n'), truncated);
  }
  if (toolName === 'runTerminalCommand') {
    return terminalActivityContent(record, args, resultPagination.truncated === true);
  }
  const text = activityReadableText(toolName, record, resultPagination);
  if (text === undefined) return undefined;
  return boundedActivityContent('text', text, truncated);
}

/** Deterministic human-readable per-tool content: the expandable activity
 *  panel never shows raw JSON — every tool projects readable lines from its
 *  declared result contract, keeping the existing path compaction and
 *  reasoning redaction guarantees. */
function activityReadableText(
  toolName: string,
  record: Record<string, unknown>,
  resultPagination: { readonly hasMore?: boolean; readonly truncated?: boolean },
): string | undefined {
  switch (toolName) {
    case 'readScene':
      return readableSceneContent(record);
    case 'searchScene':
      return readableSceneSearchContent(record);
    case 'searchProjectText':
      return readableProjectTextSearchContent(record);
    case 'listProjectFiles':
      return readableProjectFilesContent(record, resultPagination.hasMore === true);
    case 'searchResources':
      return readableResourceSearchContent(record);
    case 'inspectResource':
      return readableInspectResourceContent(record);
    case 'readImage':
      return readableImageContent(record);
    case 'readProjectOverview':
      return readableProjectOverviewContent(record);
    case 'validateScene':
      return readableValidationContent(record);
    default:
      return undefined;
  }
}

/** Deterministic one-line rendering of a scene line: dialogue reads as
 *  「speaker：text」, other families as label plus scalar params — never a
 *  JSON dump and never nested params. */
function readableSceneLine(line: unknown): string {
  const record = asActivityRecord(line);
  const lineNo = numberValue(record.line);
  const type = stringValue(record.type) ?? 'statement';
  const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : {};
  let summary: string;
  if (type === 'dialogue') {
    const speaker = stringValue(params.speaker) ?? stringValue(params.speakerId) ?? '无名';
    const text = stringValue(params.text) ?? '';
    summary = `${speaker}：${text.slice(0, 200)}`;
  } else {
    const label = stringValue(record.label) ?? stringValue(params.label) ?? type;
    const scalars: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      const scalar = readableScalarParam(key, value);
      if (scalar !== undefined) scalars.push(`${key}=${scalar}`);
    }
    summary = scalars.length > 0 ? `${label}（${scalars.join(' · ')}）` : label;
  }
  return lineNo !== undefined ? `L${lineNo} · ${type} · ${summary}` : `${type} · ${summary}`;
}

function readableSceneContent(record: Record<string, unknown>): string | undefined {
  if (!nonEmptyArray(record.lines)) return undefined;
  const lines = record.lines.map((line) => readableSceneLine(line));
  const header: string[] = [];
  const meta = record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)
    ? record.meta as Record<string, unknown>
    : {};
  const title = stringValue(meta.title);
  if (title) header.push(`场景 ${title}`);
  const duration = numberValue(meta.durationSeconds);
  const resolution = Array.isArray(meta.resolution) && meta.resolution.length === 2
    ? `${numberValue(meta.resolution[0]) ?? '?'}×${numberValue(meta.resolution[1]) ?? '?'}`
    : undefined;
  const fps = numberValue(meta.fps);
  if (duration !== undefined || resolution !== undefined || fps !== undefined) {
    header.push([
      duration !== undefined ? `时长 ${duration}s` : '',
      resolution !== undefined ? `分辨率 ${resolution}` : '',
      fps !== undefined ? `fps ${fps}` : '',
    ].filter(Boolean).join(' · '));
  }
  if (Array.isArray(record.characters) && record.characters.length > 0) {
    const names = record.characters.slice(0, 20).map((character) => {
      const entry = asActivityRecord(character);
      const name = stringValue(entry.name);
      const id = stringValue(entry.id);
      return name ? (id ? `${id}=${name}` : name) : (id ?? '?');
    }).join('、');
    header.push(`角色 ${names}`);
  }
  const footer: string[] = [];
  const total = numberValue(record.totalLines);
  if (total !== undefined) footer.push(`共 ${total} 行`);
  const start = numberValue(record.startLine);
  const end = numberValue(record.endLine);
  if (start !== undefined && end !== undefined) footer.push(`L${start}~L${end}`);
  return [...header, ...lines, ...footer].join('\n');
}

function readableSceneSearchContent(record: Record<string, unknown>): string | undefined {
  if (!nonEmptyArray(record.hits)) return undefined;
  const lines: string[] = [];
  for (const hit of record.hits) {
    const entry = asActivityRecord(hit);
    lines.push(readableSceneLine(entry.line));
    for (const contextKey of ['contextBefore', 'contextAfter'] as const) {
      if (!Array.isArray(entry[contextKey])) continue;
      for (const contextLine of entry[contextKey]) {
        lines.push(`  ${readableSceneLine(contextLine)}`);
      }
    }
  }
  const total = numberValue(record.total);
  if (total !== undefined) lines.push(`共 ${total} 条命中`);
  return lines.join('\n');
}

function readableProjectTextSearchContent(record: Record<string, unknown>): string | undefined {
  if (!nonEmptyArray(record.hits)) return undefined;
  const lines: string[] = [];
  for (const hit of record.hits) {
    const entry = asActivityRecord(hit);
    const hitPath = compactActivityPath(stringValue(entry.path) ?? '') ?? '?';
    const hitLine = numberValue(entry.line);
    const text = stringValue(entry.text) ?? '';
    lines.push(`${hitPath}:${hitLine ?? '?'} · ${text}`);
  }
  const total = numberValue(record.total);
  if (total !== undefined) lines.push(`共 ${total} 条命中`);
  return lines.join('\n');
}

function readableProjectFilesContent(
  record: Record<string, unknown>,
  hasMore: boolean,
): string | undefined {
  if (!nonEmptyArray(record.entries)) return undefined;
  const lines: string[] = [];
  for (const entry of record.entries) {
    const file = asActivityRecord(entry);
    const filePath = compactActivityPath(stringValue(file.path) ?? '') ?? '?';
    const kind = stringValue(file.kind);
    const sizeBytes = numberValue(file.sizeBytes);
    const parts = [filePath];
    if (kind === 'directory') parts.push('[目录]');
    else if (sizeBytes !== undefined) parts.push(`${sizeBytes} B`);
    if (file.binary === true) parts.push('二进制');
    lines.push(parts.join(' · '));
  }
  const footer: string[] = [];
  const total = numberValue(record.total);
  if (total !== undefined) footer.push(`共 ${total} 项`);
  const excluded = numberValue(record.excludedCount);
  if (excluded !== undefined && excluded > 0) footer.push(`已排除 ${excluded} 项受保护条目`);
  if (hasMore || record.hasMore === true) footer.push('还有更多');
  if (footer.length > 0) lines.push(footer.join(' · '));
  return lines.join('\n');
}

function readableResourceSearchContent(record: Record<string, unknown>): string | undefined {
  if (!nonEmptyArray(record.entries)) return undefined;
  const lines: string[] = [];
  for (const candidate of record.entries) {
    const entry = asActivityRecord(candidate);
    const kind = stringValue(entry.kind) ?? '资源';
    const displayName = stringValue(entry.displayName) ?? '?';
    const scope = stringValue(entry.scope);
    const reference = stringValue(entry.reference);
    const target = entry.materializationRequired === true
      ? '需要物化'
      : (reference ? (compactActivityPath(reference) ?? '?') : '无引用');
    lines.push(`${kind} ${displayName}（${scope ?? '未知范围'}）→ ${target}`);
  }
  const total = numberValue(record.total);
  if (total !== undefined) lines.push(`共 ${total} 条`);
  return lines.join('\n');
}

function readableInspectResourceContent(record: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  lines.push(`存在：${record.exists === true ? '是' : '否'}`);
  const reference = stringValue(record.reference);
  if (reference) lines.push(`引用：${compactActivityPath(reference) ?? '?'}`);
  const scope = stringValue(record.scope);
  if (scope) lines.push(`范围：${scope}`);
  const kind = stringValue(record.kind);
  if (kind) lines.push(`类型：${kind}`);
  lines.push(`可绑定：${record.bindable === true ? '是' : '否'}`);
  if (record.materializationRequired === true) lines.push('需要物化：是');
  if (record.media && typeof record.media === 'object' && !Array.isArray(record.media)) {
    const media = redactActivityValue(record.media);
    if (media && typeof media === 'object' && !Array.isArray(media)) {
      for (const [key, value] of Object.entries(media)) {
        const text = readableScalarParam(key, value) ?? '…';
        lines.push(`媒体 ${key}：${text}`);
      }
    }
  }
  const live2d = record.live2d && typeof record.live2d === 'object' && !Array.isArray(record.live2d)
    ? record.live2d as Record<string, unknown>
    : undefined;
  if (live2d) {
    if (Array.isArray(live2d.motions) && live2d.motions.length > 0) {
      lines.push(`动作：${live2d.motions.slice(0, 20).map((motion) => String(motion)).join('、')}`);
    }
    if (Array.isArray(live2d.expressions) && live2d.expressions.length > 0) {
      lines.push(`表情：${live2d.expressions.slice(0, 20).map((expression) => String(expression)).join('、')}`);
    }
    if (live2d.capabilities && typeof live2d.capabilities === 'object' && !Array.isArray(live2d.capabilities)) {
      const capabilities = redactActivityValue(live2d.capabilities);
      if (capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)) {
        for (const [key, value] of Object.entries(capabilities)) {
          const text = readableScalarParam(key, value) ?? '…';
          lines.push(`能力 ${key}：${text}`);
        }
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function readableImageContent(record: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const reference = stringValue(record.reference);
  if (reference) lines.push(`引用：${compactActivityPath(reference) ?? '?'}`);
  const mimeType = stringValue(record.mimeType);
  if (mimeType) lines.push(`格式：${mimeType}`);
  const detail = stringValue(record.detail);
  if (detail) lines.push(`细节：${detail}`);
  const originalWidth = numberValue(record.originalWidth);
  const originalHeight = numberValue(record.originalHeight);
  if (originalWidth !== undefined && originalHeight !== undefined) {
    lines.push(`原始尺寸：${originalWidth}×${originalHeight}`);
  }
  const deliveredWidth = numberValue(record.deliveredWidth);
  const deliveredHeight = numberValue(record.deliveredHeight);
  if (deliveredWidth !== undefined && deliveredHeight !== undefined) {
    lines.push(`送模尺寸：${deliveredWidth}×${deliveredHeight}`);
  }
  if (record.scaled === true) lines.push('已缩放');
  if (record.animated === true) lines.push('动图（仅首帧）');
  const fingerprint = stringValue(record.contentFingerprint);
  if (fingerprint) lines.push(`指纹：${fingerprint}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function readableProjectOverviewContent(record: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const name = stringValue(record.name);
  if (name) lines.push(`项目：${name}`);
  const version = numberValue(record.projectVersion);
  if (version !== undefined) lines.push(`版本：v${version}`);
  const activeScene = record.activeScene && typeof record.activeScene === 'object' && !Array.isArray(record.activeScene)
    ? record.activeScene as Record<string, unknown>
    : undefined;
  if (activeScene) {
    const sceneName = stringValue(activeScene.name);
    const relativePath = compactActivityPath(stringValue(activeScene.relativePath) ?? '');
    lines.push(`当前场景：${sceneName ?? '?'}${relativePath ? `（${relativePath}）` : ''}`);
  }
  if (Array.isArray(record.scenes) && record.scenes.length > 0) {
    lines.push(`场景：${record.scenes.slice(0, 20).map((scene) => {
      const entry = asActivityRecord(scene);
      const sceneName = stringValue(entry.name) ?? '?';
      const relativePath = compactActivityPath(stringValue(entry.relativePath) ?? '');
      return relativePath ? `${sceneName}（${relativePath}）` : sceneName;
    }).join('、')}`);
  }
  if (record.assetRoots && typeof record.assetRoots === 'object' && !Array.isArray(record.assetRoots)) {
    const roots = Object.entries(record.assetRoots as Record<string, unknown>)
      .slice(0, 20)
      .map(([key, value]) => `${key}=${readableScalarParam(key, value) ?? '…'}`);
    if (roots.length > 0) lines.push(`资源根：${roots.join(' · ')}`);
  }
  if (record.templates && typeof record.templates === 'object' && !Array.isArray(record.templates)) {
    const templates = record.templates as Record<string, unknown>;
    if (Array.isArray(templates.enabledTemplateIds) && templates.enabledTemplateIds.length > 0) {
      lines.push(`模板：${templates.enabledTemplateIds.slice(0, 20).map((id) => String(id)).join('、')}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function readableValidationContent(record: Record<string, unknown>): string | undefined {
  const diagnostics = Array.isArray(record.diagnostics) ? record.diagnostics : [];
  const errors = diagnostics.filter((item) => asActivityRecord(item).severity === 'error').length;
  const warnings = diagnostics.filter((item) => asActivityRecord(item).severity === 'warning').length;
  const lines: string[] = [];
  lines.push(record.ok === false
    ? `校验：失败（${errors} 错误${warnings > 0 ? ` · ${warnings} 警告` : ''}）`
    : errors === 0 && warnings === 0
      ? '校验：通过（无诊断）'
      : `校验：通过（${errors} 错误 · ${warnings} 警告）`);
  for (const diagnostic of diagnostics) {
    const entry = asActivityRecord(diagnostic);
    const gate = stringValue(entry.gate);
    const severity = stringValue(entry.severity) ?? 'info';
    const message = stringValue(entry.message) ?? '';
    lines.push(`[${gate ?? 'unknown'}] ${severity} · ${message}`);
  }
  return lines.join('\n');
}

/** Terminal output projection: command header, stdout/stderr and markers. */
function terminalActivityContent(
  record: Record<string, unknown>,
  args: JsonObject | undefined,
  resultTruncated: boolean,
): NonNullable<ProjectAgentActivityRecord['details']>['content'] | undefined {
  const lines: string[] = [];
  const command = stringArg(args, 'command');
  if (command) {
    const singleLine = command.replace(/\s+/g, ' ').trim();
    if (singleLine) lines.push(`$ ${singleLine.slice(0, 120)}`);
  }
  const stdout = stringValue(record.stdout);
  if (stdout) lines.push(stdout);
  const stderr = stringValue(record.stderr);
  if (stderr) lines.push(`[stderr]\n${stderr}`);
  const exitCode = numberValue(record.exitCode);
  if (exitCode !== undefined) lines.push(`退出码 ${exitCode}`);
  if (record.timedOut === true) lines.push('命令超时');
  if (record.cancelled === true) lines.push('已取消');
  if (lines.length === 0) return undefined;
  return boundedActivityContent(
    'text',
    lines.join('\n'),
    resultTruncated || record.truncated === true,
  );
}

/** Bounded scalar rendering of a param value; path-like keys are compacted. */
function readableScalarParam(key: string, value: unknown): string | undefined {
  if (typeof value === 'string') {
    const safe = isActivityPathKey(key) ? (compactActivityPath(value) ?? ACTIVITY_CONTENT_OMISSION) : value;
    return safe.length > 80 ? `${safe.slice(0, 80)}…` : safe;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function asActivityRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function boundedActivityContent(
  format: 'text' | 'json',
  text: string,
  truncated: boolean,
): NonNullable<ProjectAgentActivityRecord['details']>['content'] {
  if (text.length <= ACTIVITY_CONTENT_MAX_CHARS) return { format, text, truncated };
  return {
    format,
    text: `${text.slice(0, ACTIVITY_CONTENT_MAX_CHARS)}\n…`,
    truncated: true,
  };
}

/**
 * Tool outputs have already passed individual read-policy gates. This second
 * guard removes provider reasoning and unsafe path values before a durable
 * activity record can reach the Agent window.
 */
function redactActivityValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => redactActivityValue(item, seen));
  if (!value || typeof value !== 'object') return String(value);
  if (seen.has(value)) return ACTIVITY_CONTENT_CIRCULAR;
  seen.add(value);

  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    if (ACTIVITY_SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    const item = (value as Record<string, unknown>)[key];
    result[key] = isActivityPathKey(key) && typeof item === 'string'
      ? compactActivityPath(item) ?? ACTIVITY_CONTENT_OMISSION
      : redactActivityValue(item, seen);
  }
  return result;
}

function isActivityPathKey(key: string): boolean {
  return /(?:path|reference)$/iu.test(key);
}

function activityFacts(
  toolName: string,
  data: unknown,
  args?: JsonObject,
  resultPagination: { readonly hasMore?: boolean; readonly truncated?: boolean } = {},
): ProjectAgentActivityRecord['details'] | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const facts: MutableProjectAgentActivityDetails = {};
  const pathValues: string[] = [];
  const collectPath = (value: unknown) => {
    if (typeof value !== 'string') return;
    const path = compactActivityPath(value);
    if (path) pathValues.push(path);
  };
  if (toolName === 'readProjectText' || toolName === 'inspectResource' || toolName === 'readImage') {
    collectPath(record.path ?? record.reference ?? stringArg(args, 'path') ?? stringArg(args, 'reference'));
  }
  if (toolName === 'listProjectFiles' && Array.isArray(record.entries)) {
    for (const entry of record.entries) {
      if (pathValues.length >= ACTIVITY_LIST_LIMIT) break;
      if (entry && typeof entry === 'object') collectPath((entry as Record<string, unknown>).path);
    }
  }
  if (toolName === 'searchProjectText' && Array.isArray(record.hits)) {
    for (const hit of record.hits) {
      if (pathValues.length >= ACTIVITY_LIST_LIMIT) break;
      if (hit && typeof hit === 'object') collectPath((hit as Record<string, unknown>).path);
    }
  }
  if (toolName === 'searchResources' && Array.isArray(record.entries)) {
    for (const candidate of record.entries) {
      if (pathValues.length >= ACTIVITY_LIST_LIMIT) break;
      if (candidate && typeof candidate === 'object') collectPath((candidate as Record<string, unknown>).reference);
    }
  }
  if (pathValues.length > 0) facts.paths = pathValues;
  const start = numberArg(args, 'startLine') ?? numberValue(record.startLine);
  const end = numberValue(record.endLine);
  if (start !== undefined && end !== undefined && end >= start) facts.lineRange = { start, end };
  const query = stringArg(args, 'query') ?? stringArg(args, 'text');
  if (query) facts.query = query.slice(0, 160);
  if (typeof record.total === 'number') facts.matches = record.total;
  const reference = stringArg(args, 'reference') ?? stringValue(record.reference);
  if (reference) {
    const safeReference = compactActivityPath(reference);
    if (safeReference) facts.reference = safeReference;
  }
  const sourceItems = Array.isArray(record.entries) ? record.entries
    : Array.isArray(record.hits) ? record.hits
      : Array.isArray(record.candidates) ? record.candidates : undefined;
  const hasMore = resultPagination.hasMore ?? booleanValue(record.hasMore);
  const truncated = resultPagination.truncated ?? booleanValue(record.truncated);
  if (hasMore === true || truncated === true || (sourceItems?.length ?? 0) > ACTIVITY_LIST_LIMIT) {
    const shown = pathValues.length;
    const sourceCount = sourceItems?.length ?? 0;
    const total = numberValue(record.total);
    const remaining = total !== undefined
      ? Math.max(0, total - shown)
      : Math.max(0, sourceCount - shown);
    facts.pagination = {
      truncated: truncated === true,
      hasMore: hasMore === true,
      ...(remaining > 0 ? { remaining } : {}),
    };
  }
  if (Array.isArray(record.diagnostics)) {
    const diagnostics = activityFactsFromDiagnostics(record.diagnostics);
    if (diagnostics?.diagnostics) facts.diagnostics = diagnostics.diagnostics;
  }
  if (Object.keys(facts).length > 0) facts.safe = true;
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function activityFactsFromDiagnostics(
  diagnostics: readonly AgentToolDiagnostic[] | readonly unknown[] | undefined,
): ProjectAgentActivityRecord['details'] | undefined {
  if (!diagnostics || diagnostics.length === 0) return undefined;
  const errors = diagnostics.filter((item) => (
    item && typeof item === 'object' && (item as { severity?: unknown }).severity === 'error'
  )).length;
  const warnings = diagnostics.filter((item) => (
    item && typeof item === 'object' && (item as { severity?: unknown }).severity === 'warning'
  )).length;
  return { diagnostics: { errors, warnings }, safe: true };
}

/** Deterministic per-tool display detail from call args + result envelope. */
function activityDetail(
  toolName: string,
  data: unknown,
  args?: JsonObject,
): string | undefined {
  switch (toolName) {
    case 'readScene': {
      const record = data as { startLine?: unknown; endLine?: unknown; lines?: unknown } | undefined;
      if (!record) return undefined;
      const range = (typeof record.startLine === 'number' && typeof record.endLine === 'number'
        && record.startLine > 0 && record.endLine >= record.startLine)
        ? `L${record.startLine}~L${record.endLine}`
        : undefined;
      const count = Array.isArray(record.lines) && record.lines.length > 0
        ? `${record.lines.length} 行`
        : undefined;
      return [range, count].filter((part): part is string => !!part).join(' · ') || undefined;
    }
    case 'searchScene': {
      const record = data as { total?: unknown } | undefined;
      const parts: string[] = [];
      const text = stringArg(args, 'text');
      if (text) parts.push(`text=${text}`);
      const family = stringArg(args, 'family');
      if (family) parts.push(`family=${family}`);
      if (typeof record?.total === 'number') parts.push(`命中 ${record.total}`);
      return parts.length > 0 ? parts.join(' · ') : undefined;
    }
    case 'validateScene': {
      const record = data as { ok?: unknown; diagnostics?: readonly { severity?: string }[] } | undefined;
      if (!Array.isArray(record?.diagnostics)) return undefined;
      const errors = record.diagnostics.filter((d) => d.severity === 'error').length;
      const warnings = record.diagnostics.filter((d) => d.severity === 'warning').length;
      if (errors === 0 && warnings === 0) return '无诊断';
      return record.ok === false ? `错误 ${errors}` : `错误 ${errors} · 警告 ${warnings}`;
    }
    case 'readProjectText': {
      const parts: string[] = [];
      const path = stringArg(args, 'path');
      if (path) {
        const safePath = compactActivityPath(path);
        if (safePath) parts.push(safePath);
      }
      const lineCount = numberArg(args, 'lineCount');
      if (lineCount) parts.push(`${lineCount} 行`);
      return parts.length > 0 ? parts.join(' · ') : undefined;
    }
    case 'searchProjectText': {
      const query = stringArg(args, 'query');
      return query ? `查询 “${query}”` : undefined;
    }
    case 'searchResources': {
      const parts: string[] = [];
      for (const key of ['text', 'kind', 'namespace', 'pathPrefix', 'ownerId', 'outfitId'] as const) {
        const value = stringArg(args, key);
        if (value) parts.push(`${key}=${value}`);
      }
      return parts.length > 0 ? parts.join(' · ') : undefined;
    }
    case 'inspectResource':
    case 'readImage': {
      const reference = stringArg(args, 'reference');
      return reference ? compactActivityPath(reference) : undefined;
    }
    case 'runTerminalCommand': {
      const command = stringArg(args, 'command');
      if (!command) return undefined;
      const singleLine = command.replace(/\s+/g, ' ').trim();
      if (!singleLine) return undefined;
      return singleLine.length > 80 ? `${singleLine.slice(0, 80)}…` : singleLine;
    }
    default:
      return undefined;
  }
}

function stringArg(args: JsonObject | undefined, key: string): string | undefined {
  if (!args) return undefined;
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberArg(args: JsonObject | undefined, key: string): number | undefined {
  if (!args) return undefined;
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Project-relative or registered mount references only; never reveal local paths. */
function compactActivityPath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('\\')
    || /^[A-Za-z]:\//u.test(normalized) || /^file:/iu.test(normalized)) return undefined;
  if (normalized.length <= 44) return normalized;
  return `…${normalized.slice(-43)}`;
}

/**
 * Versioned model-visible conversation summary (ADR0023): the ONLY model
 * context preserved across an 80% context compaction. `objective` is the
 * summary's current conversation direction — never a persistent goal
 * identity and never a completion/terminal trigger. Capped at 8192 tokens;
 * scene source, Agent lines, internal UUIDs, full receipts/tool logs and
 * image bytes never enter it.
 */
export interface AgentConversationSummaryV1 {
  readonly version: 1;
  readonly objective: string;
  readonly importantDetails: readonly string[];
  readonly workState: {
    readonly completed: readonly string[];
    readonly active: readonly string[];
    readonly nextMove: readonly string[];
  };
  readonly relevantFiles: readonly string[];
}

export const PROJECT_AGENT_CONVERSATION_SUMMARY_FIELDS = [
  'importantDetails',
  'relevantFiles',
] as const;

export const PROJECT_AGENT_CONVERSATION_SUMMARY_WORK_STATE_FIELDS = [
  'completed',
  'active',
  'nextMove',
] as const;

/**
 * Deterministic schema gate for a conversation summary produced by the
 * summarizer model (ADR0023): version 1, `objective` + `importantDetails` +
 * `workState{completed,active,nextMove}` + `relevantFiles`, and the
 * 8192-token cap. One failure earns one correction; a second failure
 * suspends the execution round as `context_compaction_required` — the host
 * never generates a deterministic semantic summary.
 */
export function validateAgentConversationSummary(value: unknown):
  | { ok: true; summary: AgentConversationSummaryV1 }
  | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Summary must be a JSON object' };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, error: 'Summary version must be 1' };
  }
  if (typeof record.objective !== 'string') {
    return { ok: false, error: 'Summary field "objective" must be a string' };
  }
  const workState = record.workState;
  if (!workState || typeof workState !== 'object' || Array.isArray(workState)) {
    return { ok: false, error: 'Summary field "workState" must be an object' };
  }
  const workStateRecord = workState as Record<string, unknown>;
  for (const field of PROJECT_AGENT_CONVERSATION_SUMMARY_WORK_STATE_FIELDS) {
    const items = workStateRecord[field];
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
      return { ok: false, error: `Summary field "workState.${field}" must be an array of strings` };
    }
  }
  const summary: Record<string, unknown> = {
    version: 1,
    objective: record.objective,
    workState: {
      completed: workStateRecord.completed,
      active: workStateRecord.active,
      nextMove: workStateRecord.nextMove,
    },
  };
  let tokens = Math.ceil(record.objective.length / 4);
  for (const field of PROJECT_AGENT_CONVERSATION_SUMMARY_FIELDS) {
    const items = record[field];
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
      return { ok: false, error: `Summary field "${field}" must be an array of strings` };
    }
    for (const item of items) {
      tokens += Math.ceil((item as string).length / 4);
    }
    summary[field] = items;
  }
  for (const field of PROJECT_AGENT_CONVERSATION_SUMMARY_WORK_STATE_FIELDS) {
    for (const item of workStateRecord[field] as string[]) {
      tokens += Math.ceil(item.length / 4);
    }
  }
  if (tokens > PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS) {
    return {
      ok: false,
      error: `Summary exceeds the ${PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS}-token cap`,
    };
  }
  return { ok: true, summary: summary as unknown as AgentConversationSummaryV1 };
}

export type ProjectAgentExecutionRoundLifecycle =
  | 'idle'
  | 'running'
  | 'suspended'
  | 'cancelling';

/** Execution-round states for a persistent project Agent Conversation (ADR0023). */
export type ProjectAgentTaskLifecycle = ProjectAgentExecutionRoundLifecycle | 'paused' | 'completed' | 'cancelled' | 'blocked' | 'assistant_reply' | 'user_cancelled';

export type ProjectAgentRoundSettlementKind = 'assistant_reply' | 'user_cancelled' | 'completed' | 'cancelled' | 'blocked';

/** Backward-compatible type name for the host's final round settlement facts. */
export type ProjectAgentTerminalLifecycle = ProjectAgentRoundSettlementKind;

export type ProjectAgentPauseReason =
  | 'user_requested'
  | 'provider_unavailable'
  | 'provider_configuration_required'
  | 'window_closed'
  | 'application_exit'
  | 'renderer_reloaded'
  | 'lease_lost'
  | 'target_scene_inactive'
  | 'repeated_invalid_tool_calls'
  | 'provider_protocol_incompatible'
  | 'version_conflict_exhausted'
  | 'target_scene_unavailable'
  | 'task_state_incompatible'
  | 'missing_authorization'
  | 'resource_unavailable'
  | 'unrecoverable_error'
  | 'agent_reported'
  | 'context_compaction_required';

export type ProjectAgentSuspensionReason = ProjectAgentPauseReason;

/** Compatibility alias while callers migrate from terminal blocked semantics. */
export type ProjectAgentBlockedReason =
  | 'repeated_invalid_tool_calls'
  | 'provider_protocol_incompatible'
  | 'version_conflict_exhausted'
  | 'target_scene_unavailable'
  | 'task_state_incompatible'
  | 'missing_authorization'
  | 'resource_unavailable'
  | 'unrecoverable_error'
  | 'agent_reported';

export type ProjectAgentCompleteKind = 'with_changes' | 'no_changes';

/** Host-trusted facts for the final report; agent only fills narrative slots. */
export interface ProjectAgentTerminalHostFacts {
  readonly lifecycle: ProjectAgentTerminalLifecycle;
  readonly completeKind?: ProjectAgentCompleteKind;
  readonly suspensionReason?: ProjectAgentSuspensionReason;
  readonly blockedReason?: ProjectAgentBlockedReason;
  readonly pauseReasonBeforeTerminal?: ProjectAgentPauseReason;
  readonly committedChangeCount: number;
  readonly committedReceipts: readonly AgentWriteReceiptSummary[];
  readonly warnings: readonly AgentToolDiagnostic[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly hadSuccessfulRelatedRead: boolean;
  readonly zeroWriteComplete: boolean;
}

export interface AgentWriteReceiptSummary {
  readonly status: ProjectAgentHostWriteReceipt['status'];
  readonly version: number;
  readonly counts: ProjectAgentHostWriteReceipt['counts'];
  readonly warningCount: number;
}

export interface ProjectAgentTerminalAgentNarrative {
  readonly summary?: string;
  readonly blocker?: string;
  readonly attemptedAlternatives?: readonly string[];
  readonly unfinishedWork?: string;
}

export interface ProjectAgentTerminalReport {
  readonly hostFacts: ProjectAgentTerminalHostFacts;
  readonly agentNarrative: ProjectAgentTerminalAgentNarrative;
  readonly viewed: boolean;
}

/** Queued user supplement: ordered, verbatim, never merged. */
export interface ProjectAgentUserSupplement {
  readonly id: string;
  readonly text: string;
  readonly enqueuedAt: number;
  readonly deliveredToModel: boolean;
}

/**
 * Internal-only task identity (never enters model messages or tool args).
 * `conversationId` is the canonical stable store-addressing identity
 * (ADR0023); it equals `taskId` at creation and `taskId` stays as the
 * backward-compatible alias non-owned consumers address it by.
 */
export interface ProjectAgentTaskIdentity {
  readonly taskId: string;
  readonly projectId: string;
  readonly targetSceneIdentity: string;
  readonly createdAt: number;
  /** Canonical stable conversation store identity (=== taskId at creation). */
  readonly conversationId?: string;
  /** Explicit per-conversation tool authorization; omitted legacy records are standard. */
  readonly accessMode?: ProjectAgentAccessMode;
}

export interface ProjectAgentTaskCounters {
  /** Transient provider failures within the current model-request attempt window (max 3). */
  transportRetryCount: number;
  /** Consecutive version_conflict outcomes across automatic retries (max 3 → blocked). */
  versionConflictRetryCount: number;
  /**
   * Successful scene/project reads that relate to the user goal (for zero-write
   * complete). Terminal command success is NOT counted here — it has its own
   * counter (ADR0023), so 「成功读取 N」 never includes commands.
   */
  successfulRelatedReadCount: number;
  /**
   * Successful runTerminalCommand calls (full-access conversations only,
   * ADR0023). Counted separately from reads; in full-access mode a terminal
   * inspection equally satisfies the zero-write related-read requirement.
   * Absent on legacy records — treat as 0.
   */
  successfulTerminalCommandCount?: number;
  /** True after a write receipt was returned to the model and a subsequent turn may completeTask. */
  lastWriteReceiptReturnedToModel: boolean;
  /** True when any committed write occurred in this task. */
  hasCommittedWrite: boolean;
  /** Pending write receipt that must be delivered before completeTask is allowed. */
  pendingWriteReceiptForModel: boolean;
}

/**
 * Structured provider failure carried on a provider pause (ADR0023): the
 * transport code plus a user-facing message, with the HTTP status when the
 * provider reported one. Lives in host task state, never in model context.
 */
export interface ProjectAgentProviderPauseDetail {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}

export interface ProjectAgentPauseRecoveryFacts {
  readonly pauseReason: ProjectAgentPauseReason;
  readonly discardedCurrentRound: boolean;
  readonly committedDuringPause: readonly AgentWriteReceiptSummary[];
  readonly message: string;
  readonly providerDetail?: ProjectAgentProviderPauseDetail;
}

/**
 * turn_aborted recovery facts (ADR0023): a host-recorded marker that an
 * assistant/tool round was left unclosed by a process crash or lifecycle
 * interruption. The explicit field is persisted when the coordinator detects
 * the interruption; hydration restores it and synthesizes it for older
 * records. The marker is injected once into the next user-triggered model
 * request and then cleared. Never model text, never replayed.
 */
export interface ProjectAgentTurnAbortedFacts {
  readonly reason: ProjectAgentPauseReason;
  /** Confirmed committed receipt summaries at the interruption (source of truth for the projection). */
  readonly committedDuringInterruption: readonly AgentWriteReceiptSummary[];
  /** True when a durable pending write had an unknown commit outcome at the interruption. */
  readonly unknownOutcome: boolean;
}

export interface ProjectAgentTaskSnapshot {
  readonly identity: ProjectAgentTaskIdentity;
  readonly lifecycle: ProjectAgentExecutionRoundLifecycle;
  readonly suspensionReason?: ProjectAgentSuspensionReason;
  readonly pauseReason?: ProjectAgentPauseReason;
  /** Deprecated: persistent Conversations no longer expose blocked as lifecycle. */
  readonly blockedReason?: ProjectAgentBlockedReason;
  readonly originalTaskText: string;
  readonly supplements: readonly ProjectAgentUserSupplement[];
  readonly counters: Readonly<ProjectAgentTaskCounters>;
  /** Host-projected tool activities in append order (ADR0023). */
  readonly activities: readonly ProjectAgentActivityRecord[];
  /**
   * Timing of the last settled round (ADR0023): persisted to the journal so
   * the Agent window keeps its 「已完成 · Ns」 status line after switching
   * away / reopening. Additive: absent until the first round settles.
   */
  readonly lastSettledRound?: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly kind: 'settled' | 'cancelled' | 'suspended';
  };
  /** Deprecated: ordinary assistant text settles a round, not a Conversation. */
  readonly terminalReport?: ProjectAgentTerminalReport;
  readonly settlementReport?: ProjectAgentTerminalReport;
  readonly pauseRecovery?: ProjectAgentPauseRecoveryFacts;
  readonly turnAborted?: ProjectAgentTurnAbortedFacts;
  readonly leaseToken?: string;
  /**
   * Auto conversation title (ADR0023): deterministic derivation from the
   * first user message; never user-authored.
   */
  readonly title: string;
  /** Last user-visible activity timestamp (ms): user message append or round settle. */
  readonly lastActivityAt: number;
  /** Optional user rename overriding the auto title for display; never auto-derived. */
  readonly userRename?: string;
}

function createCounters(): ProjectAgentTaskCounters {
  return {
    transportRetryCount: 0,
    versionConflictRetryCount: 0,
    successfulRelatedReadCount: 0,
    successfulTerminalCommandCount: 0,
    lastWriteReceiptReturnedToModel: false,
    hasCommittedWrite: false,
    pendingWriteReceiptForModel: false,
  };
}

function summarizeReceipt(receipt: ProjectAgentHostWriteReceipt): AgentWriteReceiptSummary {
  return {
    status: receipt.status,
    version: receipt.version,
    counts: receipt.counts,
    warningCount: receipt.warnings.length,
  };
}

/**
 * Explicit task lifecycle + queued supplements + terminal report facts.
 * Scene snapshot / line map live in ProjectAgentTaskState (Task 3); this is orchestration state.
 */
export class ProjectAgentTask {
  readonly identity: ProjectAgentTaskIdentity;
  readonly originalTaskText: string;
  private lifecycle: ProjectAgentExecutionRoundLifecycle = 'idle';
  private suspensionReason?: ProjectAgentSuspensionReason;
  private readonly supplements: ProjectAgentUserSupplement[] = [];
  private supplementSeq = 0;
  private readonly counters: ProjectAgentTaskCounters = createCounters();
  private readonly committedReceipts: AgentWriteReceiptSummary[] = [];
  /** Full receipts for journal dual-layer recovery; summaries are model/report-facing. */
  private readonly committedWriteReceipts: ProjectAgentHostWriteReceipt[] = [];
  /** Host-projected tool activities in append order (ADR0023). */
  private readonly activities: ProjectAgentActivityRecord[] = [];
  private readonly accumulatedWarnings: AgentToolDiagnostic[] = [];
  private settlementReport?: ProjectAgentTerminalReport;
  private pauseRecovery?: ProjectAgentPauseRecoveryFacts;
  private turnAborted?: ProjectAgentTurnAbortedFacts;
  private leaseToken?: string;
  private readonly startedAt: number;
  /** Start time of the CURRENT execution round (set by markRunning); the
   *  settlement reports use it so a persisted lastSettledRound measures the
   *  round itself, not the whole Conversation (ADR0023). */
  private roundStartedAt?: number;
  /**
   * Timing of the last settled round (ADR0023): persisted to the journal so
   * the Agent window keeps its status line after switching away / reopening.
   * Kept separately from settlementReport because suspended rounds do NOT
   * retain a terminal report (the status payload contract keeps
   * terminalReport undefined there); only the display timing is retained.
   */
  private lastSettledTiming?: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly kind: 'settled' | 'cancelled' | 'suspended';
  };
  private readonly title: string;
  private lastActivityAt: number;
  private userRename?: string;
  private stopScheduling = false;

  constructor(options: {
    taskId: string;
    projectId: string;
    targetSceneIdentity: string;
    originalTaskText: string;
    createdAt?: number;
    conversationId?: string;
    accessMode?: ProjectAgentAccessMode;
  }) {
    this.identity = {
      taskId: options.taskId,
      projectId: options.projectId,
      targetSceneIdentity: options.targetSceneIdentity,
      createdAt: options.createdAt ?? Date.now(),
      conversationId: options.conversationId ?? options.taskId,
      accessMode: options.accessMode ?? 'standard',
    };
    this.originalTaskText = options.originalTaskText;
    this.startedAt = this.identity.createdAt;
    this.title = deriveConversationTitle(options.originalTaskText);
    this.lastActivityAt = this.identity.createdAt;
  }

  /**
   * Rebuild a paused task from its durable journal record (ADR0023): the
   * original task, three-part target identity, ordered verbatim supplements,
   * trusted receipts and counters, and the pause recovery facts. Recovery
   * only restores state — no lease, no scheduling, no model call. A record
   * left `running` by a crash hydrates as paused (`application_exit`) with
   * synthesized recovery facts; image bytes restore with their messages
   * directly from the conversation store (ADR0023).
   */
  static hydrateFromJournal(record: ProjectAgentJournalRunningRecord): ProjectAgentTask {
    const task = Object.create(ProjectAgentTask.prototype) as ProjectAgentTask;
    // Readonly identity fields may only be set inside the constructor;
    // hydration restores them through the same internal slot on this fresh object.
    const hydrated = task as unknown as {
      identity: ProjectAgentTaskIdentity;
      originalTaskText: string;
      lifecycle: ProjectAgentExecutionRoundLifecycle;
      pauseReason?: ProjectAgentPauseReason;
      suspensionReason?: ProjectAgentSuspensionReason;
      supplements: ProjectAgentUserSupplement[];
      supplementSeq: number;
      counters: ProjectAgentTaskCounters;
      committedReceipts: AgentWriteReceiptSummary[];
      committedWriteReceipts: ProjectAgentHostWriteReceipt[];
      activities: ProjectAgentActivityRecord[];
      accumulatedWarnings: AgentToolDiagnostic[];
      settlementReport?: ProjectAgentTerminalReport;
      pauseRecovery?: ProjectAgentPauseRecoveryFacts;
      turnAborted?: ProjectAgentTurnAbortedFacts;
      leaseToken?: string;
      stopScheduling: boolean;
      startedAt: number;
      title: string;
      lastActivityAt: number;
      userRename?: string;
    };
    hydrated.identity = {
      ...record.identity,
      conversationId: record.identity.conversationId ?? record.identity.taskId,
      accessMode: record.identity.accessMode === 'full_access' ? 'full_access' : 'standard',
    };
    hydrated.originalTaskText = record.originalTaskText;
    hydrated.lifecycle = 'suspended';
    const recordLifecycle = (record as { lifecycle?: string }).lifecycle;
    hydrated.suspensionReason = record.pauseReason
      ?? (recordLifecycle === 'suspended' || recordLifecycle === 'paused' ? undefined : 'application_exit');
    hydrated.supplements = [];
    hydrated.supplements.push(...record.supplements.map((supplement) => ({ ...supplement })));
    hydrated.supplementSeq = record.supplements.length;
    hydrated.counters = { successfulTerminalCommandCount: 0, ...record.counters };
    hydrated.committedWriteReceipts = [];
    hydrated.committedWriteReceipts.push(
      ...record.committedReceipts.map((r) => structuredClone(r)),
    );
    hydrated.committedReceipts = [];
    hydrated.committedReceipts.push(
      ...record.committedReceipts.map((r) => summarizeReceipt(r)),
    );
    hydrated.accumulatedWarnings = [];
    for (const r of record.committedReceipts) {
      hydrated.accumulatedWarnings.push(...r.warnings);
    }
    hydrated.activities = [];
    if (record.activities) {
      hydrated.activities.push(...record.activities.map((a) => ({ ...a })));
    }
    hydrated.settlementReport = undefined;
    hydrated.leaseToken = undefined;
    hydrated.stopScheduling = true;
    hydrated.startedAt = record.identity.createdAt;
    hydrated.title = record.title ?? deriveConversationTitle(record.originalTaskText);
    hydrated.lastActivityAt = record.lastActivityAt ?? record.updatedAt;
    hydrated.userRename = record.userRename;
    hydrated.pauseRecovery = record.pauseRecovery
      ? {
          ...record.pauseRecovery,
          committedDuringPause: [...record.pauseRecovery.committedDuringPause],
        }
      : synthesizeHydratedPauseRecovery(record);
    hydrated.turnAborted = record.turnAborted
      ? {
          ...record.turnAborted,
          committedDuringInterruption: [...record.turnAborted.committedDuringInterruption],
        }
      : undefined;
    return task;
  }

  getLifecycle(): ProjectAgentTaskLifecycle {
    if (this.lifecycle === 'suspended') return 'paused';
    return this.lifecycle;
  }

  getExecutionRoundState(): ProjectAgentExecutionRoundLifecycle {
    return this.lifecycle;
  }

  isTerminal(): boolean {
    return false;
  }

  isSchedulingAllowed(): boolean {
    return this.lifecycle === 'running' && !this.stopScheduling;
  }

  getPauseReason(): ProjectAgentPauseReason | undefined {
    return this.suspensionReason;
  }

  getSuspensionReason(): ProjectAgentSuspensionReason | undefined {
    return this.suspensionReason;
  }

  getBlockedReason(): ProjectAgentBlockedReason | undefined {
    return isBlockedCompatibilityReason(this.suspensionReason)
      ? this.suspensionReason
      : undefined;
  }

  getCounters(): Readonly<ProjectAgentTaskCounters> {
    return { ...this.counters };
  }

  getLeaseToken(): string | undefined {
    return this.leaseToken;
  }

  getTerminalReport(): ProjectAgentTerminalReport | undefined {
    return this.settlementReport;
  }

  getSettlementReport(): ProjectAgentTerminalReport | undefined {
    return this.settlementReport;
  }

  getPauseRecovery(): ProjectAgentPauseRecoveryFacts | undefined {
    return this.pauseRecovery;
  }

  /** Explicit host marker of an aborted unclosed round, or undefined. */
  getTurnAborted(): ProjectAgentTurnAbortedFacts | undefined {
    return this.turnAborted;
  }

  /** Record the turn_aborted marker when the coordinator detects the interruption. */
  setTurnAborted(facts: ProjectAgentTurnAbortedFacts): void {
    this.turnAborted = {
      ...facts,
      committedDuringInterruption: facts.committedDuringInterruption.map((r) => ({
        ...r,
        counts: { ...r.counts },
      })),
    };
  }

  /** Consume the marker after its single projection into a model request. */
  clearTurnAborted(): void {
    this.turnAborted = undefined;
  }

  snapshot(): ProjectAgentTaskSnapshot {
    return {
      identity: this.identity,
      lifecycle: this.lifecycle,
      ...(this.suspensionReason ? {
        suspensionReason: this.suspensionReason,
        pauseReason: this.suspensionReason,
      } : {}),
      ...(isBlockedCompatibilityReason(this.suspensionReason)
        ? { blockedReason: this.suspensionReason }
        : {}),
      originalTaskText: this.originalTaskText,
      supplements: this.supplements.map((s) => ({ ...s })),
      counters: { ...this.counters },
      activities: this.getActivities(),
      ...(this.lastSettledTiming ? { lastSettledRound: { ...this.lastSettledTiming } } : {}),
      ...(this.settlementReport ? {
        settlementReport: this.settlementReport,
        terminalReport: this.settlementReport,
      } : {}),
      ...(this.pauseRecovery ? { pauseRecovery: this.pauseRecovery } : {}),
      ...(this.turnAborted ? { turnAborted: this.turnAborted } : {}),
      ...(this.leaseToken ? { leaseToken: this.leaseToken } : {}),
      title: this.title,
      lastActivityAt: this.lastActivityAt,
      ...(this.userRename ? { userRename: this.userRename } : {}),
    };
  }

  getConversationTitle(): string {
    return this.title;
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  getUserRename(): string | undefined {
    return this.userRename;
  }

  /**
   * Optional user rename (ADR0023): overrides the auto title for display;
   * the userRename value itself is never auto-derived. Empty/whitespace
   * input clears the override so the auto title shows again.
   */
  renameConversation(name: string | undefined): void {
    const trimmed = name?.trim() ?? '';
    this.userRename = trimmed.length > 0 ? trimmed : undefined;
  }

  /** Record a user-visible activity: user message append or round settle. */
  touchLastActivity(now = Date.now()): void {
    this.lastActivityAt = now;
  }

  markRunning(leaseToken: string, startedAt = Date.now()): void {
    this.lifecycle = 'running';
    this.leaseToken = leaseToken;
    this.suspensionReason = undefined;
    this.stopScheduling = false;
    this.settlementReport = undefined;
    this.counters.transportRetryCount = 0;
    this.roundStartedAt = startedAt;
    this.lastSettledTiming = undefined;
  }

  /** Stop scheduling new model/tool work immediately (pause or cancel path). */
  requestStopScheduling(): void {
    this.stopScheduling = true;
  }

  beginCancelling(): void {
    this.stopScheduling = true;
    this.lifecycle = 'cancelling';
  }

  enterPaused(
    reason: ProjectAgentPauseReason,
    options: {
      discardedCurrentRound: boolean;
      committedDuringPause?: readonly ProjectAgentHostWriteReceipt[];
      providerDetail?: ProjectAgentProviderPauseDetail;
    },
  ): void {
    this.stopScheduling = true;
    this.lifecycle = 'suspended';
    this.suspensionReason = reason;
    this.leaseToken = undefined;
    const committed = (options.committedDuringPause ?? []).map(summarizeReceipt);
    this.pauseRecovery = {
      pauseReason: reason,
      discardedCurrentRound: options.discardedCurrentRound,
      committedDuringPause: committed,
      message: buildPauseRecoveryMessage(reason, options.discardedCurrentRound, committed.length),
      ...(options.providerDetail ? { providerDetail: options.providerDetail } : {}),
    };
  }

  clearPauseRecovery(): void {
    this.pauseRecovery = undefined;
  }

  enqueueSupplement(text: string, enqueuedAt = Date.now()): ProjectAgentUserSupplement {
    this.supplementSeq += 1;
    const entry: ProjectAgentUserSupplement = {
      id: `${this.identity.taskId}:sup:${this.supplementSeq}`,
      text,
      enqueuedAt,
      deliveredToModel: false,
    };
    this.supplements.push(entry);
    return entry;
  }

  /** Undelivered supplements in enqueue order (verbatim, not merged). */
  peekPendingSupplements(): readonly ProjectAgentUserSupplement[] {
    return this.supplements.filter((s) => !s.deliveredToModel);
  }

  markSupplementsDelivered(ids: readonly string[]): void {
    const idSet = new Set(ids);
    for (const s of this.supplements) {
      if (idSet.has(s.id)) {
        (s as { deliveredToModel: boolean }).deliveredToModel = true;
      }
    }
  }

  recordSuccessfulRelatedRead(): void {
    this.counters.successfulRelatedReadCount += 1;
  }

  /** Record a successful runTerminalCommand (full-access, ADR0023): counted
   *  separately from related reads and never shown as 「成功读取」. */
  recordSuccessfulTerminalCommand(): void {
    this.counters.successfulTerminalCommandCount = (this.counters.successfulTerminalCommandCount ?? 0) + 1;
  }

  recordCommittedWrite(receipt: ProjectAgentHostWriteReceipt): void {
    if (receipt.status === 'committed') {
      this.counters.hasCommittedWrite = true;
    }
    this.committedWriteReceipts.push(receipt);
    this.committedReceipts.push(summarizeReceipt(receipt));
    for (const w of receipt.warnings) {
      this.accumulatedWarnings.push(w);
    }
    this.counters.pendingWriteReceiptForModel = true;
    this.counters.lastWriteReceiptReturnedToModel = false;
  }

  /** Full write receipts accumulated this task (for journal persist / pause settle). */
  getCommittedWriteReceipts(): readonly ProjectAgentHostWriteReceipt[] {
    return this.committedWriteReceipts;
  }

  getCommittedWriteReceiptCount(): number {
    return this.committedWriteReceipts.length;
  }

  /**
   * Tool activities appended after each completed tool round, in append order
   * (ADR0023). Host-authored only; never model text, never receipt copies.
   */
  getActivities(): readonly ProjectAgentActivityRecord[] {
    return this.activities.map((a) => ({ ...a }));
  }

  /** Append the deterministic activities of one completed tool round. */
  appendActivities(records: readonly ProjectAgentActivityRecord[]): void {
    for (const record of records) {
      this.activities.push({ ...record });
    }
  }

  /** Call when write tool results have been appended for the next model turn. */
  markWriteReceiptsReturnedToModel(): void {
    if (this.counters.pendingWriteReceiptForModel) {
      this.counters.lastWriteReceiptReturnedToModel = true;
      this.counters.pendingWriteReceiptForModel = false;
    }
  }

  recordTransportRetry(): number {
    this.counters.transportRetryCount += 1;
    return this.counters.transportRetryCount;
  }

  resetTransportRetries(): void {
    this.counters.transportRetryCount = 0;
  }

  recordVersionConflictRetry(): number {
    this.counters.versionConflictRetryCount += 1;
    return this.counters.versionConflictRetryCount;
  }

  resetVersionConflictRetries(): void {
    this.counters.versionConflictRetryCount = 0;
  }

  canZeroWriteComplete(): boolean {
    return !this.counters.hasCommittedWrite
      && (this.counters.successfulRelatedReadCount > 0
        || (this.counters.successfulTerminalCommandCount ?? 0) > 0)
      && this.peekPendingSupplements().length === 0
      && !this.counters.pendingWriteReceiptForModel;
  }

  /**
   * Round settlement after a write is only trusted after the last write receipt
   * was returned in a prior turn; zero-write settlement needs at least one
   * successful related read when a caller wants to assert no scene changes.
   */
  canSettleRoundAsDone(): { ok: true } | { ok: false; code: string; message: string } {
    if (this.counters.pendingWriteReceiptForModel) {
      return {
        ok: false,
        code: 'complete_requires_receipt_roundtrip',
        message: 'Round settlement requires the last write receipt to be returned to the model in a subsequent turn',
      };
    }
    if (this.counters.hasCommittedWrite && !this.counters.lastWriteReceiptReturnedToModel) {
      return {
        ok: false,
        code: 'complete_requires_receipt_roundtrip',
        message: 'Round settlement requires the last write receipt to be returned to the model in a subsequent turn',
      };
    }
    if (!this.counters.hasCommittedWrite
      && this.counters.successfulRelatedReadCount === 0
      && (this.counters.successfulTerminalCommandCount ?? 0) === 0) {
      return {
        ok: false,
        code: 'zero_write_requires_related_read',
        message: 'Zero-write done settlement requires at least one successful related read',
      };
    }
    if (this.peekPendingSupplements().length > 0) {
      return {
        ok: false,
        code: 'pending_user_input',
        message: 'Cannot complete while user supplements are still queued for the model',
      };
    }
    return { ok: true };
  }

  /** Compatibility wrapper while callers migrate away from completeTask. */
  canCompleteTask(): { ok: true } | { ok: false; code: string; message: string } {
    return this.canSettleRoundAsDone();
  }

  settleAssistantReply(
    agentNarrative: ProjectAgentTerminalAgentNarrative,
    endedAt = Date.now(),
  ): ProjectAgentTerminalReport {
    const zeroWrite = !this.counters.hasCommittedWrite;
    this.lifecycle = 'idle';
    this.leaseToken = undefined;
    this.stopScheduling = true;
    this.settlementReport = {
      hostFacts: {
        lifecycle: 'assistant_reply',
        completeKind: zeroWrite ? 'no_changes' : 'with_changes',
        committedChangeCount: this.committedReceipts.filter((r) => r.status === 'committed').length,
        committedReceipts: [...this.committedReceipts],
        warnings: [...this.accumulatedWarnings],
        startedAt: this.roundStartedAt ?? this.startedAt,
        endedAt,
        hadSuccessfulRelatedRead: this.counters.successfulRelatedReadCount > 0,
        zeroWriteComplete: zeroWrite,
      },
      agentNarrative: { ...agentNarrative },
      viewed: false,
    };
    this.lastSettledTiming = {
      startedAt: this.settlementReport.hostFacts.startedAt,
      endedAt: this.settlementReport.hostFacts.endedAt,
      kind: 'settled',
    };
    return this.settlementReport;
  }

  /** Compatibility wrapper while callers migrate away from completeTask. */
  complete(
    agentNarrative: ProjectAgentTerminalAgentNarrative,
    endedAt = Date.now(),
  ): ProjectAgentTerminalReport {
    const gate = this.canSettleRoundAsDone();
    if (!gate.ok) {
      throw new Error(gate.message);
    }
    return this.settleAssistantReply(agentNarrative, endedAt);
  }

  cancel(endedAt = Date.now()): ProjectAgentTerminalReport {
    this.lifecycle = 'idle';
    this.leaseToken = undefined;
    this.stopScheduling = true;
    this.settlementReport = {
      hostFacts: {
        lifecycle: 'user_cancelled',
        committedChangeCount: this.committedReceipts.filter((r) => r.status === 'committed').length,
        committedReceipts: [...this.committedReceipts],
        warnings: [...this.accumulatedWarnings],
        startedAt: this.roundStartedAt ?? this.startedAt,
        endedAt,
        hadSuccessfulRelatedRead: this.counters.successfulRelatedReadCount > 0,
        zeroWriteComplete: false,
      },
      agentNarrative: {
        unfinishedWork: 'Task cancelled by host before completion',
      },
      viewed: false,
    };
    this.lastSettledTiming = {
      startedAt: this.settlementReport.hostFacts.startedAt,
      endedAt: this.settlementReport.hostFacts.endedAt,
      kind: 'cancelled',
    };
    return this.settlementReport;
  }

  block(
    reason: ProjectAgentSuspensionReason,
    agentNarrative: ProjectAgentTerminalAgentNarrative = {},
    endedAt = Date.now(),
  ): ProjectAgentTerminalReport {
    this.lifecycle = 'suspended';
    this.suspensionReason = reason;
    this.leaseToken = undefined;
    this.stopScheduling = true;
    const report: ProjectAgentTerminalReport = {
      hostFacts: {
        lifecycle: 'assistant_reply',
        suspensionReason: reason,
        pauseReasonBeforeTerminal: reason,
        committedChangeCount: this.committedReceipts.filter((r) => r.status === 'committed').length,
        committedReceipts: [...this.committedReceipts],
        warnings: [...this.accumulatedWarnings],
        startedAt: this.roundStartedAt ?? this.startedAt,
        endedAt,
        hadSuccessfulRelatedRead: this.counters.successfulRelatedReadCount > 0,
        zeroWriteComplete: false,
      },
      agentNarrative: { ...agentNarrative },
      viewed: false,
    };
    // Suspended rounds deliberately do NOT retain the terminal report (the
    // status payload contract keeps terminalReport undefined there); only
    // the display timing is kept for the journal's lastSettledRound.
    this.lastSettledTiming = {
      startedAt: report.hostFacts.startedAt,
      endedAt: report.hostFacts.endedAt,
      kind: 'suspended',
    };
    return report;
  }

  markReportViewed(): void {
    if (this.settlementReport) {
      this.settlementReport = { ...this.settlementReport, viewed: true };
    }
  }

  getCommittedReceipts(): readonly AgentWriteReceiptSummary[] {
    return this.committedReceipts;
  }
}

function isBlockedCompatibilityReason(
  reason: ProjectAgentSuspensionReason | undefined,
): reason is ProjectAgentBlockedReason {
  return reason === 'repeated_invalid_tool_calls'
    || reason === 'provider_protocol_incompatible'
    || reason === 'version_conflict_exhausted'
    || reason === 'target_scene_unavailable'
    || reason === 'task_state_incompatible'
    || reason === 'missing_authorization'
    || reason === 'resource_unavailable'
    || reason === 'unrecoverable_error'
    || reason === 'agent_reported';
}

function buildPauseRecoveryMessage(
  reason: ProjectAgentPauseReason,
  discardedCurrentRound: boolean,
  committedCount: number,
): string {
  const parts = [
    `Task paused (${reason}).`,
    discardedCurrentRound
      ? 'The unfinished current assistant round was discarded and must not be replayed.'
      : 'No in-flight assistant round was discarded.',
  ];
  if (committedCount > 0) {
    parts.push(`${committedCount} semantic transaction(s) committed atomically during settle.`);
  }
  return parts.join(' ');
}

/**
 * Deterministic pause recovery facts for a record that was persisted without
 * them (crash recovery, main-side lifecycle rewrite): the interrupted round
 * was discarded; the current full messages restore directly from the store
 * (ADR0023) and the host never marks visual context for re-read.
 */
function synthesizeHydratedPauseRecovery(
  record: ProjectAgentJournalRunningRecord,
): ProjectAgentPauseRecoveryFacts {
  const reason = record.pauseReason
    ?? ((record as { lifecycle?: string }).lifecycle === 'paused' || record.lifecycle === 'suspended'
      ? 'user_requested'
      : 'application_exit');
  return {
    pauseReason: reason,
    discardedCurrentRound: true,
    committedDuringPause: [],
    message: `Execution round recovered after ${reason}; the unfinished current assistant round was discarded and must not be replayed.`,
  };
}

/**
 * Deterministic model-visible turn_aborted recovery projection (ADR0023):
 * host-authored facts — confirmed committed changes (from trusted receipts),
 * unknown commit outcomes and the scene scope that must be re-read. Never
 * model text, never replayed calls, never fabricated closing tool results.
 */
export function buildTurnAbortedProjection(facts: ProjectAgentTurnAbortedFacts): string {
  const parts: string[] = [
    `${PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX} (turn_aborted): the previous assistant/tool round was aborted by a crash or lifecycle interruption before the round completed. The unclosed round was discarded from recoverable history; uncompleted tool calls are not replayed and no tool results were fabricated for them.`,
  ];
  if (facts.committedDuringInterruption.length > 0) {
    parts.push(
      `Confirmed committed changes are preserved: ${facts.committedDuringInterruption
        .map((r) => `v${r.version} ${r.status} (+${r.counts.inserted}/~${r.counts.updated}/-${r.counts.deleted})`)
        .join(', ')}.`,
    );
  } else {
    parts.push('No confirmed committed changes exist from the interrupted round.');
  }
  if (facts.unknownOutcome) {
    parts.push('A write with an unknown commit outcome was not replayed and no receipt was backfilled.');
  }
  parts.push(
    'Re-read the scene (readScene/searchScene) and re-plan before further writes; do not assume side effects from uncompleted calls.',
  );
  return parts.join(' ');
}
