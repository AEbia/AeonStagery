/**
 * AeonStagery — Level-Gated Logger with Breadcrumbs Ring Buffer
 * Defined in ADR-0032
 */

import type { LogBreadcrumb } from '../api/types/crash';

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5,
}

function resolveLevel(): LogLevel {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('aeonstagery_logLevel');
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= LogLevel.NONE && parsed <= LogLevel.TRACE) return parsed;
    }
  }
  return (import.meta as any).env?.DEV ? LogLevel.DEBUG : LogLevel.INFO;
}

const CURRENT_LEVEL = resolveLevel();
const MAX_BREADCRUMBS = 100;
/**
 * Floor for what is kept in the breadcrumb ring buffer. Trace/debug engine
 * chatter (per-frame SEEK, bake snapshots, motion-curve cache hits) floods the
 * buffer and pushes out meaningful user actions, so only WARN/INFO/ERROR (and
 * above) breadcrumbs are retained. Console output is unaffected.
 */
const BREADCRUMB_MIN_LEVEL = 3; // LogLevel.INFO
const LEVEL_RANK: Record<LogBreadcrumb['level'], number> = {
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};
const breadcrumbsRingBuffer: LogBreadcrumb[] = [];
let lastBreadcrumbKey: string | null = null;

function recordBreadcrumb(level: LogBreadcrumb['level'], context: string, msg: string, args: unknown[]): void {
  try {
    if (LEVEL_RANK[level] > BREADCRUMB_MIN_LEVEL) return;

    let formattedMsg = msg;
    if (args.length > 0) {
      const argStrings = args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      });
      formattedMsg = `${msg} ${argStrings.join(' ')}`;
    }

    // Suppress consecutive duplicates (e.g. the same per-frame SEEK spam) so a
    // single repeating event cannot occupy the whole ring buffer.
    const key = `${level}|${context}|${formattedMsg}`;
    if (key === lastBreadcrumbKey) return;
    lastBreadcrumbKey = key;

    breadcrumbsRingBuffer.push({
      timestamp: new Date().toISOString(),
      level,
      context,
      message: formattedMsg,
    });

    if (breadcrumbsRingBuffer.length > MAX_BREADCRUMBS) {
      breadcrumbsRingBuffer.shift();
    }
  } catch {
    // Fail-safe: recording breadcrumbs must never throw
  }
}

export function getLogBreadcrumbs(): LogBreadcrumb[] {
  return [...breadcrumbsRingBuffer];
}

export function clearLogBreadcrumbs(): void {
  breadcrumbsRingBuffer.length = 0;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  error(msg: string, ...args: unknown[]): void {
    recordBreadcrumb('error', this.context, msg, args);
    if (CURRENT_LEVEL >= LogLevel.ERROR) console.error(`[${this.context}] ${msg}`, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    recordBreadcrumb('warn', this.context, msg, args);
    if (CURRENT_LEVEL >= LogLevel.WARN) console.warn(`[${this.context}] ${msg}`, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    recordBreadcrumb('info', this.context, msg, args);
    if (CURRENT_LEVEL >= LogLevel.INFO) console.log(`[${this.context}] ${msg}`, ...args);
  }

  debug(msg: string, ...args: unknown[]): void {
    recordBreadcrumb('debug', this.context, msg, args);
    if (CURRENT_LEVEL >= LogLevel.DEBUG) console.log(`[${this.context}] ${msg}`, ...args);
  }

  trace(msg: string, css: string, ...args: unknown[]): void {
    recordBreadcrumb('trace', this.context, msg, [css, ...args]);
    if (CURRENT_LEVEL >= LogLevel.TRACE) console.log(`%c[${this.context}] ${msg}`, css, ...args);
  }
}

const loggerCache = new Map<string, Logger>();

export function getLogger(context: string): Logger {
  const existing = loggerCache.get(context);
  if (existing) return existing;
  const logger = new Logger(context);
  loggerCache.set(context, logger);
  return logger;
}
