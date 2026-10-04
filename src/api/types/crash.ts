/**
 * Crash and Diagnostic Recovery Types
 * Defined in ADR-0032
 */

export type CrashSurface = 'editor' | 'agent' | 'workspace-tools' | 'main' | 'renderer-global';

export type CrashTier = 1 | 2 | 3 | 4;

export interface LogBreadcrumb {
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  context: string;
  message: string;
}

export interface CrashEnvironmentInfo {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  memoryUsageMb?: number;
  userAgent?: string;
}

export interface CrashErrorDetails {
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

export interface CrashReport {
  reportId: string;
  timestamp: string;
  tier: CrashTier;
  surface: CrashSurface;
  error: CrashErrorDetails;
  environment: CrashEnvironmentInfo;
  breadcrumbs: LogBreadcrumb[];
  redacted: boolean;
  /** Redacted summary of the scene the user was editing (no script text). */
  sceneSummary?: CrashSceneSummary;
}

/** One timeline statement in the redacted crash scene summary. */
export interface CrashSceneStatementOutline {
  index: number;
  type: string;
  startSeconds: number;
  durationSeconds?: number;
  characterId?: string;
}

/**
 * Redacted structural summary of the active scene at crash time. Deliberately
 * excludes any script/dialogue text — only counts, durations and the timeline
 * outline (statement kind + start time) are captured (ADR-0032 redaction).
 */
export interface CrashSceneSummary {
  statementCount: number;
  durationSeconds: number | null;
  outline: CrashSceneStatementOutline[];
}

export interface CrashRecordResult {
  success: boolean;
  reportId: string;
  filePath?: string;
  error?: string;
}
