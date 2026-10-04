import type { AgentToolError, AgentToolResult } from '../../api/types/project-agent';

const FORBIDDEN_EXACT = new Set([
  'project.json',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
]);

const FORBIDDEN_PREFIXES = [
  '.git/',
  '.svn/',
  '.hg/',
  'node_modules/',
  '.ai-prose/',
  'ai-prose/',
  '.agent/',
  'agent-journal/',
  '.agent-journal/',
  'credentials/',
  '.credentials/',
  'secrets/',
  '.secrets/',
] as const;

const FORBIDDEN_SUFFIXES = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.env',
] as const;

const SCENE_FILE_RE = /\.(scene\.json|aeonscene|json)$/i;
const SCENE_DIR_RE = /(^|\/)scenes\//i;

export type PathNormalizationResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: AgentToolError };

export function failPath(message: string, code: AgentToolError['code'] = 'forbidden_path'): AgentToolError {
  return {
    code,
    message,
    retryable: false,
    // An existing-but-forbidden path cannot be fixed by changing arguments;
    // `fix_arguments` is only meaningful for invalid_arguments-style failures.
    ...(code === 'forbidden_path' ? {} : { suggestedAction: 'fix_arguments' as const }),
  };
}

export function toolFail<T>(error: AgentToolError): AgentToolResult<T> {
  return { ok: false, error };
}

export function toolOk<T>(
  data: T,
  meta?: {
    truncated?: boolean;
    hasMore?: boolean;
    nextOffset?: number;
    nextStartLine?: number;
  },
): AgentToolResult<T> {
  return {
    ok: true,
    data,
    ...(meta?.truncated ? { truncated: true } : {}),
    ...(meta?.hasMore ? { hasMore: true } : {}),
    ...(meta?.nextOffset !== undefined ? { nextOffset: meta.nextOffset } : {}),
    ...(meta?.nextStartLine !== undefined ? { nextStartLine: meta.nextStartLine } : {}),
  };
}

/**
 * Normalize a project-relative path for generic file tools.
 * Rejects absolute paths, `..`, `@mount`, and empty segments.
 */
export function normalizeProjectRelativePath(raw: unknown): PathNormalizationResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: failPath('Path must be a non-empty project-relative string', 'invalid_arguments') };
  }
  const input = raw.replace(/\\/g, '/').trim();
  if (input.startsWith('/') || /^[a-zA-Z]:\//.test(input) || input.startsWith('\\\\')) {
    return { ok: false, error: failPath('Absolute paths are not allowed') };
  }
  if (input.startsWith('@mount/') || input.startsWith('@')) {
    return { ok: false, error: failPath('@mount references are not allowed on generic file tools') };
  }
  if (input.includes('\0')) {
    return { ok: false, error: failPath('Path contains invalid characters', 'invalid_arguments') };
  }

  const segments = input.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, error: failPath('Path traversal ("..") is not allowed') };
  }
  if (segments.length === 0) {
    return { ok: false, error: failPath('Path must be project-relative', 'invalid_arguments') };
  }

  return { ok: true, path: segments.join('/') };
}

/**
 * Resource references may be project-relative or stable `@mount/<id>/...`.
 */
export function normalizeResourceReference(raw: unknown): PathNormalizationResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: failPath('Reference must be a non-empty string', 'invalid_arguments') };
  }
  const input = raw.replace(/\\/g, '/').trim();
  if (input.startsWith('/') || /^[a-zA-Z]:\//.test(input) || input.startsWith('\\\\')) {
    return { ok: false, error: failPath('Absolute paths are not allowed') };
  }
  if (/^https?:\/\//i.test(input) || input.startsWith('data:')) {
    return { ok: false, error: failPath('Network URLs and data URIs are not allowed') };
  }
  if (input.startsWith('@mount/')) {
    const rest = input.slice('@mount/'.length);
    const parts = rest.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (parts.length < 2 || parts.some((segment) => segment === '..')) {
      return { ok: false, error: failPath('Invalid @mount reference') };
    }
    return { ok: true, path: `@mount/${parts.join('/')}` };
  }
  if (input.startsWith('@')) {
    return { ok: false, error: failPath('Only @mount/<id>/... resource references are allowed') };
  }
  return normalizeProjectRelativePath(input);
}

export function isForbiddenProjectPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const base = lower.split('/').pop() ?? lower;

  if (FORBIDDEN_EXACT.has(base) || FORBIDDEN_EXACT.has(lower)) return true;
  if (FORBIDDEN_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix))) {
    return true;
  }
  if (FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (base.startsWith('.env')) return true;
  if (lower.includes('/.git/') || lower === '.git') return true;
  if (isFormalScenePath(normalized)) return true;
  if (isAiProseDraftPath(normalized)) return true;
  if (isAgentJournalPath(normalized)) return true;
  if (isCredentialLike(base)) return true;
  return false;
}

/**
 * Compare canonical filesystem paths without assuming POSIX separators.
 * Electron's Windows realpath result uses backslashes, while resource paths
 * are deliberately normalized to forward slashes elsewhere in the agent.
 */
export function isCanonicalPathWithinRoot(canonicalPath: string, canonicalRoot: string): boolean {
  const path = normalizeCanonicalPath(canonicalPath);
  const root = normalizeCanonicalPath(canonicalRoot);
  const comparablePath = isWindowsCanonicalPath(path) ? path.toLowerCase() : path;
  const comparableRoot = isWindowsCanonicalPath(root) ? root.toLowerCase() : root;
  const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  return comparablePath === comparableRoot || comparablePath.startsWith(rootPrefix);
}

function normalizeCanonicalPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/' || /^[a-zA-Z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function isWindowsCanonicalPath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith('//');
}

export function isFormalScenePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (SCENE_DIR_RE.test(normalized)) return true;
  if (/\.scene\.json$/i.test(normalized)) return true;
  if (/\.aeonscene$/i.test(normalized)) return true;
  // Bare scene json under common scene roots
  if (/(^|\/)(scenes|scene)\//i.test(normalized) && SCENE_FILE_RE.test(normalized)) return true;
  return false;
}

export function isAiProseDraftPath(path: string): boolean {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  return lower.includes('/.ai-prose/')
    || lower.startsWith('.ai-prose/')
    || lower.includes('/ai-prose-drafts/')
    || lower.startsWith('ai-prose-drafts/')
    || lower.includes('/ai-prose/')
    // AiProseDraftPersistence writes drafts under <assetRoot.project>/ai-authoring/<sceneId>/<session>.json
    || lower.includes('/ai-authoring/')
    || lower.startsWith('ai-authoring/')
    || /(^|\/)drafts?\//i.test(lower) && /ai[-_]?prose/i.test(lower);
}

export function isAgentJournalPath(path: string): boolean {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  return lower.includes('agent-journal')
    || lower.includes('/.agent/')
    || lower.startsWith('.agent/')
    || lower.includes('project-agent');
}

function isCredentialLike(base: string): boolean {
  return /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(base)
    || base.endsWith('.pem')
    || base === 'credentials.json'
    || base === 'secrets.json'
    || base === 'api-keys.json'
    || base === 'apikey'
    || base === 'api_key';
}

export function assertAllowedProjectPath(path: string): PathNormalizationResult {
  const normalized = normalizeProjectRelativePath(path);
  if (!normalized.ok) return normalized;
  if (isForbiddenProjectPath(normalized.path)) {
    return { ok: false, error: failPath(`Path is forbidden: ${normalized.path}`) };
  }
  return normalized;
}

export function stableSortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

export function normalizeNonNegativeInt(value: unknown, fallback: number, label: string): number | AgentToolError {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return {
      code: 'invalid_arguments',
      message: `${label} must be a non-negative integer`,
      retryable: false,
      suggestedAction: 'fix_arguments',
    };
  }
  return value;
}

export function normalizePositiveInt(value: unknown, fallback: number, label: string): number | AgentToolError {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    return {
      code: 'invalid_arguments',
      message: `${label} must be a positive integer`,
      retryable: false,
      suggestedAction: 'fix_arguments',
    };
  }
  return value;
}

export function stableQueryKey(tool: string, query: unknown): string {
  return `${tool}:${stableStringify(query)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
