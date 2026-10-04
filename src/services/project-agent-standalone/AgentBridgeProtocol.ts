/**
 * Agent Bridge NDJSON stdio protocol (ADR0023 Agent Bridge). Pure functions,
 * no Node IO. One JSON object per line for long-lived external-Agent ↔
 * bridge-session communication.
 */

export type AgentBridgeMethod =
  | 'run'
  | 'send'
  | 'pause'
  | 'cancel'
  | 'status'
  | 'result'
  | 'list'
  | 'show'
  | 'close';

export interface AgentBridgeRequest {
  readonly id: number | string; // caller-owned request id, echoed verbatim
  readonly method: AgentBridgeMethod;
  readonly params?: Record<string, unknown>;
}

export interface AgentBridgeOkResponse {
  readonly id: number | string;
  readonly ok: true;
  readonly result: Record<string, unknown>;
}

export interface AgentBridgeErrorResponse {
  readonly id: number | string;
  readonly ok: false;
  readonly error: string;
}

export type AgentBridgeResponse = AgentBridgeOkResponse | AgentBridgeErrorResponse;

export interface AgentBridgeEvent {
  readonly event: 'status' | 'activity' | 'result' | 'error';
  readonly payload: Record<string, unknown>;
}

export type AgentBridgeFrame = AgentBridgeRequest | AgentBridgeResponse | AgentBridgeEvent;

export type AgentBridgeParseResult =
  | { ok: true; message: AgentBridgeFrame }
  | { ok: false; error: string };

/**
 * Parse a single NDJSON frame line. Empty/whitespace-only → `empty frame`;
 * non-JSON → `invalid json`; a JSON object lacking a discriminator (method /
 * event / ok+id) → `unrecognized frame`.
 */
export function parseAgentBridgeFrame(line: string): AgentBridgeParseResult {
  if (line.trim().length === 0) return { ok: false, error: 'empty frame' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: 'invalid json' };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'unrecognized frame' };
  const hasMethod = typeof parsed.method === 'string' && parsed.method.length > 0;
  const hasEvent = typeof parsed.event === 'string';
  const hasOkWithId =
    typeof parsed.ok === 'boolean' &&
    (typeof parsed.id === 'string' || typeof parsed.id === 'number');
  if (!hasMethod && !hasEvent && !hasOkWithId) {
    return { ok: false, error: 'unrecognized frame' };
  }
  return { ok: true, message: parsed as unknown as AgentBridgeFrame };
}

/** JSON.stringify with no extra whitespace and no trailing newline. */
export function serializeAgentBridgeMessage(message: AgentBridgeFrame): string {
  return JSON.stringify(message);
}

export function createAgentBridgeResponse(
  id: number | string,
  result: Record<string, unknown>,
): AgentBridgeOkResponse {
  return { id, ok: true, result };
}

export function createAgentBridgeError(id: number | string, error: string): AgentBridgeErrorResponse {
  return { id, ok: false, error };
}

const REDACTED = '<redacted>';
const TRUNCATED_MARKER = '<truncated>';
const DEFAULT_MAX_BYTES = 200_000;
const REASONING_KEYS: ReadonlySet<string> = new Set([
  'reasoning',
  'reasoning_content',
  'reasoningContent',
]);

/**
 * Recursively redact reasoning keys and bound string length. Replacement of
 * the target keys is '<redacted>'; string values are truncated to maxBytes
 * (default 200_000) of UTF-8 bytes with a '<truncated>' suffix appended.
 * Uint8Array values render as `{bytes: N}`.
 */
export function redactAgentBridgePayload(
  value: unknown,
  options?: { maxBytes?: number },
): unknown {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  return redactValue(value, maxBytes);
}

function redactValue(value: unknown, maxBytes: number): unknown {
  if (value instanceof Uint8Array) {
    return { bytes: value.byteLength };
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    return truncateUtf8(value, maxBytes) + TRUNCATED_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, maxBytes));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REASONING_KEYS.has(key) ? REDACTED : redactValue(child, maxBytes);
    }
    return out;
  }
  return value;
}

/** Return the longest byte-prefix of `text` whose UTF-8 byte length <= max. */
function truncateUtf8(text: string, max: number): string {
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > max) break;
    current += char;
    currentBytes += charBytes;
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
