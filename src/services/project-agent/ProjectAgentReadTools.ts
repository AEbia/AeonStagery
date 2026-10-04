import type {
  AgentSceneSourceLine,
  AgentInspectResourceArgs,
  AgentListProjectFilesArgs,
  AgentProjectFileEntry,
  AgentResourceCandidate,
  AgentReadImageArgs,
  AgentReadProjectTextArgs,
  AgentReadSceneArgs,
  AgentSearchProjectTextArgs,
  AgentSearchResourcesArgs,
  AgentSearchSceneArgs,
  AgentToolError,
  AgentToolResult,
  AgentValidateSceneArgs,
  ProjectAgentToolResultByName,
} from '../../api/types/project-agent';
import type { SemanticSceneLineV1 } from '../../api/types/semantic-scene-patch';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';
import type {
  ProjectAgentReadPorts,
} from './ProjectAgentPorts';
import { ProjectAgentPortError } from './ProjectAgentProjectReadPorts';
import {
  ProjectAgentImageReadError,
} from './ProjectAgentImageReadPort';
import type { ProjectAgentImageSessionCache } from './ProjectAgentImageSessionCache';
import {
  assertAllowedProjectPath,
  failPath,
  isForbiddenProjectPath,
  normalizeNonNegativeInt,
  normalizePositiveInt,
  normalizeProjectRelativePath,
  normalizeResourceReference,
  stableQueryKey,
  stableSortBy,
  toolFail,
  toolOk,
} from './ProjectAgentPathRules';
import type { ProjectAgentTaskState } from './ProjectAgentTaskState';
import { ProjectAgentSourceIdentityFacade } from './ProjectAgentSourceIdentity';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_TEXT_LINE_COUNT = 80;
const MAX_TEXT_LINE_COUNT = 200;
const DEFAULT_SCENE_LINE_COUNT = 500;
const MAX_SCENE_LINE_COUNT = 500;
const DEFAULT_SEARCH_LIMIT = 30;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_SCENE_CONTEXT = 1;
const MAX_SCENE_CONTEXT = 3;
/** A single text page may not inject more than this many bytes of content. */
const MAX_TEXT_PAGE_BYTES = 200_000;
/** A scene page uses the same bounded payload capacity as project text. */
const MAX_SCENE_PAGE_BYTES = MAX_TEXT_PAGE_BYTES;
/** A single search hit may not exceed this many characters. */
const MAX_HIT_TEXT_CHARS = 8192;
/** One search page may not deliver more than this many characters of hits. */
const MAX_SEARCH_PAGE_CHARS = 200_000;

export interface ProjectAgentReadToolsOptions {
  readonly ports: ProjectAgentReadPorts;
  readonly taskState: ProjectAgentTaskState;
  readonly imageAvailable?: boolean;
  /**
   * Live-memory image payload cache for the current session (ADR0023): the
   * transport projection re-reads verified bytes from here per model request;
   * the tool result itself carries only the JSON-safe descriptor.
   */
  readonly imageCache?: ProjectAgentImageSessionCache;
}

export class ProjectAgentReadTools {
  private readonly ports: ProjectAgentReadPorts;
  private readonly taskState: ProjectAgentTaskState;
  private readonly imageAvailable: boolean;
  private readonly imageCache?: ProjectAgentImageSessionCache;

  constructor(options: ProjectAgentReadToolsOptions) {
    this.ports = options.ports;
    this.taskState = options.taskState;
    this.imageAvailable = options.imageAvailable ?? !!options.ports.image;
    this.imageCache = options.imageCache;
  }

  /**
   * Every port call is wrapped so unexpected port/fs failures become typed
   * AgentToolResult errors with generic messages: no stack traces, absolute
   * paths or rejected-file contents can leak into the model context.
   */
  private async safePortCall<T>(
    run: () => T | Promise<T>,
    genericMessage: string,
  ): Promise<{ ok: true; value: T } | { ok: false; error: AgentToolError }> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      const code = error instanceof ProjectAgentPortError ? error.code : 'not_found';
      return {
        ok: false,
        error: {
          code,
          message: genericMessage,
          retryable: false,
          ...(code === 'result_too_large' || code === 'forbidden_path'
            ? {}
            : { suggestedAction: 'fix_arguments' as const }),
        },
      };
    }
  }

  async readProjectOverview(
    _args?: unknown,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['readProjectOverview']>> {
    const port = await this.safePortCall(() => this.ports.overview.getOverview(), 'Project overview could not be read');
    if (!port.ok) return toolFail(port.error);
    const overview = port.value;
    return toolOk({
      name: overview.name,
      projectVersion: overview.projectVersion,
      ...(overview.activeScene
        ? {
            activeScene: {
              name: overview.activeScene.name,
              relativePath: overview.activeScene.relativePath,
            },
          }
        : {}),
      scenes: overview.scenes.map((scene) => ({
        name: scene.name,
        relativePath: scene.relativePath,
      })),
      assetRoots: { ...overview.assetRoots },
      ...(overview.templates
        ? {
            templates: {
              enabledTemplateIds: [...overview.templates.enabledTemplateIds],
              ...(overview.templates.defaults
                ? { defaults: { ...overview.templates.defaults } }
                : {}),
            },
          }
        : {}),
    });
  }

  async listProjectFiles(
    args: AgentListProjectFilesArgs = {},
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['listProjectFiles']>> {
    const offset = normalizeNonNegativeInt(args.offset, 0, 'offset');
    if (typeof offset !== 'number') return toolFail(offset);
    const limitRaw = normalizePositiveInt(args.limit, DEFAULT_LIST_LIMIT, 'limit');
    if (typeof limitRaw !== 'number') return toolFail(limitRaw);
    const limit = Math.min(limitRaw, MAX_LIST_LIMIT);

    let prefix: string | undefined;
    if (args.prefix !== undefined) {
      const normalized = assertAllowedProjectPath(args.prefix);
      if (!normalized.ok) return toolFail(normalized.error);
      prefix = normalized.path;
    }

    const listed = await this.safePortCall(() => this.ports.files.listFiles({ prefix }), 'Project files could not be listed');
    if (!listed.ok) return toolFail(listed.error);
    const listedValue = listed.value;
    const listedEntries = 'revision' in listedValue ? listedValue.entries : listedValue;
    const portRevision = 'revision' in listedValue ? listedValue.revision : undefined;
    const portExcluded = 'revision' in listedValue && typeof listedValue.excludedCount === 'number'
      ? listedValue.excludedCount
      : 0;

    // Defense in depth: drop anything that is not a clean project-relative path.
    const valid = listedEntries.filter((entry) => normalizeProjectRelativePath(entry.path).ok);
    const filtered = valid.filter((entry) => !isForbiddenProjectPath(entry.path));
    // Transparent total semantics: total = visible entries, excludedCount =
    // forbidden/protected entries filtered out (port-level skips plus this
    // tool-level defense filtering), so callers can tell an empty project
    // apart from an all-forbidden view.
    const excludedCount = portExcluded + (valid.length - filtered.length);
    const sorted = stableSortBy(filtered, (entry) => entry.path);
    const revision = portRevision
      ?? hashEntries(sorted.map((entry) => `${entry.path}:${entry.kind}:${entry.sizeBytes ?? 0}`));
    const queryKey = stableQueryKey('listProjectFiles', { prefix: prefix ?? '' });
    const pageCheck = this.taskState.checkPaginationRevision(queryKey, revision, offset);
    if (pageCheck === 'changed') {
      return toolFail({
        code: 'pagination_changed',
        message: 'Underlying file listing changed; restart from offset 0',
        retryable: true,
        suggestedAction: 'retry_from_offset_zero',
      });
    }

    const slice = sorted.slice(offset, offset + limit);
    const hasMore = offset + limit < sorted.length;
    const truncated = limitRaw > MAX_LIST_LIMIT;
    return toolOk(
      {
        entries: slice.map(sanitizeFileEntry),
        hasMore,
        nextOffset: offset + limit,
        total: sorted.length,
        excludedCount,
        truncated,
      },
      {
        hasMore,
        truncated,
        nextOffset: offset + limit,
      },
    );
  }

  async readProjectText(
    args: AgentReadProjectTextArgs,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['readProjectText']>> {
    if (!args || typeof args !== 'object') {
      return toolFail({
        code: 'invalid_arguments',
        message: 'readProjectText requires { path }',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const pathResult = normalizeResourceReference(args.path);
    if (!pathResult.ok) return toolFail(pathResult.error);
    const pathForPolicy = mountedRelativePath(pathResult.path) ?? pathResult.path;
    if (isForbiddenProjectPath(pathForPolicy)) {
      // Distinguish "does not exist" from "exists but forbidden": a missing
      // file reports not_found, an existing forbidden path stays forbidden.
      const exists = await this.ports.text.exists?.(pathResult.path) ?? true;
      if (!exists) {
        return toolFail({
          code: 'not_found',
          message: 'Project file does not exist',
          retryable: false,
        });
      }
      return toolFail(failPath(`Path is forbidden: ${pathResult.path}`));
    }

    const startLine = normalizePositiveInt(args.startLine, 1, 'startLine');
    if (typeof startLine !== 'number') return toolFail(startLine);
    const lineCountRaw = normalizePositiveInt(args.lineCount, DEFAULT_TEXT_LINE_COUNT, 'lineCount');
    if (typeof lineCountRaw !== 'number') return toolFail(lineCountRaw);
    const lineCount = Math.min(lineCountRaw, MAX_TEXT_LINE_COUNT);

    const contentPort = await this.safePortCall(
      () => this.ports.text.readText(pathResult.path),
      'Project file could not be read',
    );
    if (!contentPort.ok) return toolFail(contentPort.error);
    const content = contentPort.value;
    if (content.tooLarge) {
      return toolFail({
        code: 'result_too_large',
        message: 'Project file exceeds the safe read capacity; no lines were returned',
        retryable: false,
      });
    }
    if (content.binary) {
      return toolOk({
        path: pathResult.path,
        lines: [],
        startLine: 1,
        endLine: 0,
        binary: true,
        mimeType: content.mimeType,
        sizeBytes: content.sizeBytes,
        hasMore: false,
        nextStartLine: 1,
        totalLines: 0,
        truncated: false,
      });
    }

    const totalLines = content.lines.length;
    if (startLine > totalLines + 1) {
      return toolFail({
        code: 'invalid_arguments',
        message: `startLine ${startLine} is beyond end of file (${totalLines} lines)`,
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const startIndex = startLine - 1;
    const endIndex = Math.min(startIndex + lineCount, totalLines);
    const lines = content.lines.slice(startIndex, endIndex);
    const sliceBytes = lines.reduce((sum, line) => sum + line.length, 0);
    if (sliceBytes > MAX_TEXT_PAGE_BYTES) {
      return toolFail({
        code: 'result_too_large',
        message: 'Requested line page exceeds the safe capacity; request a smaller lineCount',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const hasMore = endIndex < totalLines;
    const truncated = lineCountRaw > MAX_TEXT_LINE_COUNT;
    return toolOk(
      {
        path: pathResult.path,
        lines,
        startLine,
        endLine: startIndex + lines.length,
        binary: false,
        mimeType: content.mimeType,
        sizeBytes: content.sizeBytes,
        hasMore,
        nextStartLine: endIndex + 1,
        totalLines,
        truncated,
      },
      {
        hasMore,
        truncated,
        nextStartLine: endIndex + 1,
      },
    );
  }

  async searchProjectText(
    args: AgentSearchProjectTextArgs,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['searchProjectText']>> {
    if (!args || typeof args.query !== 'string' || args.query.length === 0) {
      return toolFail({
        code: 'invalid_arguments',
        message: 'searchProjectText requires non-empty query',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const offset = normalizeNonNegativeInt(args.offset, 0, 'offset');
    if (typeof offset !== 'number') return toolFail(offset);
    const limitRaw = normalizePositiveInt(args.limit, DEFAULT_SEARCH_LIMIT, 'limit');
    if (typeof limitRaw !== 'number') return toolFail(limitRaw);
    const limit = Math.min(limitRaw, MAX_SEARCH_LIMIT);

    let prefix: string | undefined;
    if (args.prefix !== undefined) {
      const normalized = assertAllowedProjectPath(args.prefix);
      if (!normalized.ok) return toolFail(normalized.error);
      prefix = normalized.path;
    }

    const searchPort = await this.safePortCall(
      () => this.ports.textSearch.searchText({ query: args.query, prefix }),
      'Project text search failed',
    );
    if (!searchPort.ok) return toolFail(searchPort.error);
    const searchResult = searchPort.value;
    const portHits = 'revision' in searchResult ? searchResult.hits : searchResult;
    const portRevision = 'revision' in searchResult ? searchResult.revision : undefined;

    const allowed = portHits.filter((hit) => {
      const path = normalizeProjectRelativePath(hit.path);
      return path.ok && !isForbiddenProjectPath(path.path);
    });
    const oversizedHit = allowed.find((hit) => hit.text.length > MAX_HIT_TEXT_CHARS);
    if (oversizedHit) {
      return toolFail({
        code: 'result_too_large',
        message: 'A search hit exceeds the safe capacity; it cannot be delivered without truncation',
        retryable: false,
      });
    }
    const sorted = stableSortBy(allowed, (hit) => `${hit.path}:${String(hit.line).padStart(8, '0')}`);
    const pageChars = sorted.reduce((sum, hit) => sum + hit.text.length, 0);
    if (pageChars > MAX_SEARCH_PAGE_CHARS) {
      return toolFail({
        code: 'result_too_large',
        message: 'Search page exceeds the safe capacity; request a smaller limit',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const revision = portRevision
      ?? hashEntries(sorted.map((hit) => `${hit.path}:${hit.line}:${hit.text}`));
    const queryKey = stableQueryKey('searchProjectText', {
      query: args.query,
      prefix: prefix ?? '',
    });
    if (this.taskState.checkPaginationRevision(queryKey, revision, offset) === 'changed') {
      return toolFail({
        code: 'pagination_changed',
        message: 'Search results changed; restart from offset 0',
        retryable: true,
        suggestedAction: 'retry_from_offset_zero',
      });
    }

    const slice = sorted.slice(offset, offset + limit);
    const hasMore = offset + limit < sorted.length;
    const truncated = limitRaw > MAX_SEARCH_LIMIT;
    return toolOk(
      {
        hits: slice.map((hit) => ({
          path: hit.path,
          line: hit.line,
          text: hit.text,
        })),
        hasMore,
        nextOffset: offset + limit,
        total: sorted.length,
        truncated,
      },
      {
        hasMore,
        truncated,
        nextOffset: offset + limit,
      },
    );
  }

  async searchResources(
    args: AgentSearchResourcesArgs = {},
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['searchResources']>> {
    const offset = normalizeNonNegativeInt(args.offset, 0, 'offset');
    if (typeof offset !== 'number') return toolFail(offset);
    const limitRaw = normalizePositiveInt(args.limit, DEFAULT_SEARCH_LIMIT, 'limit');
    if (typeof limitRaw !== 'number') return toolFail(limitRaw);
    const limit = Math.min(limitRaw, MAX_SEARCH_LIMIT);
    const pathPrefix = args.pathPrefix === undefined
      ? undefined
      : normalizeResourceBrowsePrefix(args.pathPrefix);
    if (pathPrefix !== undefined && typeof pathPrefix !== 'string') return toolFail(pathPrefix);

    const searchPort = await this.safePortCall(
      () => this.ports.resources.searchResources({
        kind: args.kind,
        text: args.text,
        ownerId: args.ownerId,
        outfitId: args.outfitId,
        namespace: args.namespace,
        pathPrefix,
      }),
      'Resource search failed',
    );
    if (!searchPort.ok) return toolFail(searchPort.error);
    const searchResult = searchPort.value;
    const candidates = 'revision' in searchResult ? searchResult.entries : searchResult;
    const portRevision = 'revision' in searchResult ? searchResult.revision : undefined;

    const sanitized: AgentResourceCandidate[] = [];
    for (const candidate of candidates) {
      if (candidate.kind === 'directory') {
        if (candidate.scope === 'template') continue;
        const prefix = normalizeResourceBrowsePrefix(candidate.pathPrefix);
        if (typeof prefix !== 'string') continue;
        sanitized.push({ ...candidate, pathPrefix: prefix });
        continue;
      }
      if (candidate.scope === 'template' || candidate.materializationRequired) {
        const { reference: _reference, ...rest } = candidate;
        sanitized.push({
          ...rest,
          materializationRequired: true as const,
          reference: undefined,
        });
        continue;
      }
      // Defense in depth: project/mount candidates must carry a reference
      // that is a clean project-relative or stable @mount reference.
      if (candidate.reference !== undefined && normalizeResourceReference(candidate.reference).ok) {
        sanitized.push(candidate);
      }
    }

    const sorted = stableSortBy(
      sanitized,
      resourceCandidateKey,
    );
    const revision = portRevision
      ?? hashEntries(sorted.map(resourceCandidateKey));
    const queryKey = stableQueryKey('searchResources', {
      kind: args.kind ?? '',
      text: args.text ?? '',
      ownerId: args.ownerId ?? '',
      outfitId: args.outfitId ?? '',
      namespace: args.namespace ?? '',
      pathPrefix: pathPrefix ?? '',
    });
    if (this.taskState.checkPaginationRevision(queryKey, revision, offset) === 'changed') {
      return toolFail({
        code: 'pagination_changed',
        message: 'Resource listing changed; restart from offset 0',
        retryable: true,
        suggestedAction: 'retry_from_offset_zero',
      });
    }

    const slice = sorted.slice(offset, offset + limit);
    const hasMore = offset + limit < sorted.length;
    const truncated = limitRaw > MAX_SEARCH_LIMIT;
    return toolOk(
      {
        entries: slice,
        hasMore,
        nextOffset: offset + limit,
        total: sorted.length,
        truncated,
      },
      {
        hasMore,
        truncated,
        nextOffset: offset + limit,
      },
    );
  }

  async inspectResource(
    args: AgentInspectResourceArgs,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['inspectResource']>> {
    if (!args || typeof args.reference !== 'string') {
      return toolFail({
        code: 'invalid_arguments',
        message: 'inspectResource requires { reference }',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const reference = normalizeResourceReference(args.reference);
    if (!reference.ok) return toolFail(reference.error);
    if (!reference.path.startsWith('@mount/') && isForbiddenProjectPath(reference.path)) {
      // Distinguish "does not exist" from "exists but forbidden": a missing
      // file reports not_found, an existing forbidden path stays forbidden.
      const exists = await this.ports.resourceInspect.exists?.(reference.path) ?? true;
      if (!exists) {
        return toolFail({
          code: 'not_found',
          message: 'Resource does not exist',
          retryable: false,
        });
      }
      return toolFail(failPath(`Path is forbidden: ${reference.path}`));
    }

    const inspectPort = await this.safePortCall(
      () => this.ports.resourceInspect.inspectResource(reference.path),
      'Resource could not be inspected',
    );
    if (!inspectPort.ok) return toolFail(inspectPort.error);
    const result = inspectPort.value;
    if (result.materializationRequired || result.scope === 'template') {
      return toolOk({
        ...result,
        reference: reference.path,
        materializationRequired: true,
        bindable: false,
      });
    }
    return toolOk({
      ...result,
      reference: reference.path,
    });
  }

  async readImage(
    args: AgentReadImageArgs,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['readImage']>> {
    if (!this.imageAvailable || !this.ports.image) {
      return toolFail({
        code: 'vision_unavailable',
        message: 'readImage is not registered for the current model',
        retryable: false,
      });
    }
    if (!args || typeof args.reference !== 'string') {
      return toolFail({
        code: 'invalid_arguments',
        message: 'readImage requires { reference }',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const reference = normalizeResourceReference(args.reference);
    if (!reference.ok) return toolFail(reference.error);
    // Defense in depth: URI-scheme style input (base64:, ftp:, ...) can never
    // be a project-relative or @mount resource reference (ADR0023).
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference.path)) {
      return toolFail(failPath('Scheme-style input is not a resource reference'));
    }
    if (!reference.path.startsWith('@mount/') && isForbiddenProjectPath(reference.path)) {
      // Distinguish "does not exist" from "exists but forbidden": a missing
      // file reports not_found, an existing forbidden path stays forbidden.
      const exists = await this.ports.image?.exists?.(reference.path) ?? true;
      if (!exists) {
        return toolFail({
          code: 'not_found',
          message: 'Image does not exist',
          retryable: false,
        });
      }
      return toolFail(failPath(`Path is forbidden: ${reference.path}`));
    }
    const detail = args.detail ?? 'auto';
    if (detail !== 'auto' && detail !== 'low' && detail !== 'high') {
      return toolFail({
        code: 'invalid_arguments',
        message: 'detail must be auto | low | high',
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }

    let image: Awaited<ReturnType<NonNullable<ProjectAgentReadPorts['image']>['readImage']>>;
    try {
      image = await this.ports.image.readImage({ reference: reference.path, detail });
    } catch (error) {
      const code = error instanceof ProjectAgentImageReadError
        ? error.code
        : error instanceof ProjectAgentPortError
          ? error.code
          : 'not_found';
      return toolFail({
        code,
        message: 'Image could not be read within the safe media limits',
        retryable: false,
        ...(code === 'not_found' ? {} : { suggestedAction: 'fix_arguments' as const }),
      });
    }

    // Verified bytes stay in the session cache while the result message is
    // assembled: the coordinator builds the tool-result message with the
    // image content block from this cache, so the bytes persist once with the
    // message in the conversation store (ADR0023) and restore from there. The
    // cache also serves per-request projections for descriptor-only messages
    // (legacy records, summarizer copies).
    this.imageCache?.set(reference.path, {
      mimeType: image.mimeType,
      bytes: image.bytes,
      width: image.deliveredWidth,
      height: image.deliveredHeight,
      detail,
      contentFingerprint: image.contentFingerprint,
    });
    return toolOk({
      reference: reference.path,
      mimeType: image.mimeType,
      detail,
      originalWidth: image.originalWidth,
      originalHeight: image.originalHeight,
      deliveredWidth: image.deliveredWidth,
      deliveredHeight: image.deliveredHeight,
      scaled: image.scaled,
      contentFingerprint: image.contentFingerprint,
      imagePayload: {
        mimeType: image.mimeType,
        width: image.deliveredWidth,
        height: image.deliveredHeight,
        detail,
      },
      ...(image.animated !== undefined ? { animated: image.animated } : {}),
      ...(image.frame !== undefined ? { frame: image.frame } : {}),
    });
  }

  async readScene(
    args: AgentReadSceneArgs = {},
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['readScene']>> {
    const startLine = normalizePositiveInt(args.startLine, 1, 'startLine');
    if (typeof startLine !== 'number') return toolFail(startLine);
    const lineCountRaw = normalizePositiveInt(args.lineCount, DEFAULT_SCENE_LINE_COUNT, 'lineCount');
    if (typeof lineCountRaw !== 'number') return toolFail(lineCountRaw);
    const lineCount = Math.min(lineCountRaw, MAX_SCENE_LINE_COUNT);

    const snapshot = this.taskState.getGroupSceneSnapshot()
      ?? await this.ports.scene.getSnapshot();
    if (!snapshot) {
      return toolFail({
        code: 'not_found',
        message: 'No active scene snapshot is available',
        retryable: false,
      });
    }

    const lineView = new SemanticSceneLineView(snapshot.document);
    const sourceFacade = new ProjectAgentSourceIdentityFacade(snapshot.document);
    const totalLines = lineView.totalLines;
    const startIndex = startLine - 1;
    if (startIndex > totalLines) {
      return toolFail({
        code: 'invalid_arguments',
        message: `startLine ${startLine} is beyond totalLines ${totalLines}`,
        retryable: false,
        suggestedAction: 'fix_arguments',
      });
    }
    const requestedEndIndex = Math.min(startIndex + lineCount, totalLines);
    const page = takeSceneLinesWithinCapacity(
      lineView.lines.slice(startIndex, requestedEndIndex),
      MAX_SCENE_PAGE_BYTES,
    );
    if (page.firstLineTooLarge) {
      return toolFail({
        code: 'result_too_large',
        message: 'A scene line exceeds the safe read capacity; no lines were returned',
        retryable: false,
      });
    }
    const identities = new Map(sourceFacade.project().map((item) => [item.line, item]));
    const lines = page.lines.map((line) => projectSourceLine(line, identities));
    const endIndex = startIndex + lines.length;
    const hasMore = endIndex < totalLines;
    const truncated = lineCountRaw > MAX_SCENE_LINE_COUNT || page.truncated;
    this.taskState.bindSceneRead(snapshot.document, snapshot.version);
    const meta = snapshot.document.meta;

    return toolOk(
      {
        lines,
        totalLines,
        meta: {
          title: meta.title,
          ...(meta.author !== undefined ? { author: meta.author } : {}),
          ...(meta.durationSeconds !== undefined ? { durationSeconds: meta.durationSeconds } : {}),
          ...(meta.resolution !== undefined ? { resolution: meta.resolution } : {}),
          ...(meta.fps !== undefined ? { fps: meta.fps } : {}),
        },
        characters: (meta.characters ?? []).map((character) => ({
          id: character.id,
          name: character.name,
          ...(character.model !== undefined ? { model: character.model } : {}),
          ...(character.color !== undefined ? { color: character.color } : {}),
        })),
        startLine,
        endLine: startIndex + lines.length,
        hasMore,
        nextStartLine: endIndex + 1,
        truncated,
      },
      {
        hasMore,
        truncated,
        nextStartLine: endIndex + 1,
      },
    );
  }

  async searchScene(
    args: AgentSearchSceneArgs = {},
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['searchScene']>> {
    const offset = normalizeNonNegativeInt(args.offset, 0, 'offset');
    if (typeof offset !== 'number') return toolFail(offset);
    const limitRaw = normalizePositiveInt(args.limit, DEFAULT_SEARCH_LIMIT, 'limit');
    if (typeof limitRaw !== 'number') return toolFail(limitRaw);
    const limit = Math.min(limitRaw, MAX_SEARCH_LIMIT);
    const contextRaw = normalizeNonNegativeInt(args.contextLines, DEFAULT_SCENE_CONTEXT, 'contextLines');
    if (typeof contextRaw !== 'number') return toolFail(contextRaw);
    const contextLines = Math.min(contextRaw, MAX_SCENE_CONTEXT);

    const snapshot = this.taskState.getGroupSceneSnapshot()
      ?? await this.ports.scene.getSnapshot();
    if (!snapshot) {
      return toolFail({
        code: 'not_found',
        message: 'No active scene snapshot is available',
        retryable: false,
      });
    }

    const binding = this.taskState.bindSceneRead(snapshot.document, snapshot.version);
    const identities = new Map(new ProjectAgentSourceIdentityFacade(snapshot.document).project().map((item) => [item.line, item]));
    const lines = binding.lineView.lines.map((line) => projectSourceLine(line, identities));
    const text = args.text?.toLowerCase();
    const matched = lines.filter((line) => matchesSceneFilter(line, args, text));
    const sorted = [...matched].sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      return a.line - b.line;
    });

    const revision = hashEntries(sorted.map((line) => `${line.line}:${line.type}:${line.time}`));
    const queryKey = stableQueryKey('searchScene', {
      text: args.text ?? '',
      family: args.family ?? '',
      timeFrom: args.timeFrom ?? '',
      timeTo: args.timeTo ?? '',
    });
    if (this.taskState.checkPaginationRevision(queryKey, revision, offset) === 'changed') {
      return toolFail({
        code: 'pagination_changed',
        message: 'Scene search results changed; restart from offset 0',
        retryable: true,
        suggestedAction: 'retry_from_offset_zero',
      });
    }

    const slice = sorted.slice(offset, offset + limit);
    const hits = slice.map((line) => {
      const before = contextLines > 0
        ? lines.slice(Math.max(0, line.line - 1 - contextLines), line.line - 1)
        : [];
      const after = contextLines > 0
        ? lines.slice(line.line, line.line + contextLines)
        : [];
      return {
        line,
        ...(before.length > 0 ? { contextBefore: before } : {}),
        ...(after.length > 0 ? { contextAfter: after } : {}),
      };
    });
    const hasMore = offset + limit < sorted.length;
    return toolOk(
      {
        hits,
        hasMore,
        nextOffset: offset + limit,
        total: sorted.length,
      },
      {
        hasMore,
        nextOffset: offset + limit,
      },
    );
  }

  async validateScene(
    _args?: AgentValidateSceneArgs,
  ): Promise<AgentToolResult<ProjectAgentToolResultByName['validateScene']>> {
    const snapshot = this.taskState.getGroupSceneSnapshot()
      ?? await this.ports.scene.getSnapshot();
    if (!snapshot) {
      return toolFail({
        code: 'not_found',
        message: 'No active scene snapshot is available',
        retryable: false,
      });
    }
    // Successful scene-related read establishes binding for subsequent writes.
    this.taskState.bindSceneRead(snapshot.document, snapshot.version);

    const diagnostics = await this.ports.validation.validate(snapshot.document);
    const hasError = diagnostics.some((item) => item.severity === 'error');
    return toolOk({
      ok: !hasError,
      diagnostics: [...diagnostics],
    });
  }
}

function takeSceneLinesWithinCapacity(
  lines: readonly SemanticSceneLineV1[],
  maxBytes: number,
): {
  lines: SemanticSceneLineV1[];
  truncated: boolean;
  firstLineTooLarge: boolean;
} {
  const selected: SemanticSceneLineV1[] = [];
  let usedBytes = 2; // JSON array brackets.
  for (const line of lines) {
    const lineBytes = utf8ByteLength(JSON.stringify(line));
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (usedBytes + separatorBytes + lineBytes > maxBytes) {
      return {
        lines: selected,
        truncated: true,
        firstLineTooLarge: selected.length === 0,
      };
    }
    selected.push(line);
    usedBytes += separatorBytes + lineBytes;
  }
  return { lines: selected, truncated: false, firstLineTooLarge: false };
}

function projectSourceLine(
  line: SemanticSceneLineV1,
  identities: ReadonlyMap<number, { statementId: string; companionId?: string }>,
): AgentSceneSourceLine {
  const identity = identities.get(line.line);
  if (!identity) throw new Error(`Missing source identity for scene line ${line.line}`);
  return {
    ...line,
    statementId: identity.statementId,
    ...(identity.companionId === undefined ? {} : { companionId: identity.companionId }),
  };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function mountedRelativePath(reference: string): string | null {
  if (!reference.startsWith('@mount/')) return null;
  const separator = reference.indexOf('/', '@mount/'.length);
  return separator < 0 ? null : reference.slice(separator + 1);
}

function sanitizeFileEntry(entry: AgentProjectFileEntry): AgentProjectFileEntry {
  return {
    path: entry.path,
    kind: entry.kind,
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
    ...(entry.binary !== undefined ? { binary: entry.binary } : {}),
  };
}

function normalizeResourceBrowsePrefix(raw: unknown): string | AgentToolError {
  if (typeof raw !== 'string') {
    return failPath('pathPrefix must be a string', 'invalid_arguments');
  }
  const input = raw.replace(/\\/g, '/').trim();
  if (input === '') return '';
  if (
    input.startsWith('/')
    || /^[a-zA-Z]:\//.test(input)
    || input.startsWith('\\\\')
    || input.startsWith('@')
    || input.includes('\0')
  ) {
    return failPath('pathPrefix must be relative to the selected resource namespace');
  }
  const segments = input.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    return failPath('pathPrefix must not contain path traversal');
  }
  return segments.join('/');
}

function resourceCandidateKey(candidate: AgentResourceCandidate): string {
  const location = candidate.kind === 'directory'
    ? candidate.pathPrefix
    : candidate.reference ?? candidate.displayName;
  return `${candidate.scope}:${candidate.namespace ?? ''}:${candidate.kind}:${location}`;
}

function matchesSceneFilter(
  line: SemanticSceneLineV1,
  args: AgentSearchSceneArgs,
  text: string | undefined,
): boolean {
  if (args.family && line.type !== args.family) return false;
  if (args.timeFrom !== undefined && line.time < args.timeFrom) return false;
  if (args.timeTo !== undefined && line.time > args.timeTo) return false;
  if (text) {
    const haystack = JSON.stringify({
      type: line.type,
      label: line.label,
      params: line.params,
    }).toLowerCase();
    if (!haystack.includes(text)) return false;
  }
  return true;
}

function hashEntries(parts: readonly string[]): string {
  // Cheap deterministic revision token; not a cryptographic hash.
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
  }
  return (hash >>> 0).toString(16);
}
