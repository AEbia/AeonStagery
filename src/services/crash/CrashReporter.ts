/**
 * Crash and Diagnostic Reporter Service
 * Defined in ADR-0032
 */

import type {
  CrashReport,
  CrashTier,
  CrashSurface,
  CrashEnvironmentInfo,
  CrashErrorDetails,
  CrashSceneSummary,
} from '../../api/types/crash';
import { getLogBreadcrumbs } from '../../engine/Logger';
import { redactBreadcrumbs, redactErrorDetails } from './CrashRedactor';

export interface BuildCrashReportOptions {
  error: Error | string | unknown;
  tier?: CrashTier;
  surface?: CrashSurface;
  componentStack?: string;
  environment?: Partial<CrashEnvironmentInfo>;
  sceneSummary?: CrashSceneSummary;
}

/**
 * Environment metadata override, populated from the Electron main process
 * (which has real `process.versions` / `app.getVersion`) so renderer-sourced
 * reports are not full of "unknown" fields. Set once at startup.
 */
let environmentOverride: Partial<CrashEnvironmentInfo> | null = null;

export function setCrashEnvironmentOverride(env: Partial<CrashEnvironmentInfo> | null): void {
  environmentOverride = env;
}

/**
 * Optional provider that returns a redacted summary of the active scene at
 * crash time. Registered by the editor surface (App.tsx) so the report carries
 * useful structural context without exposing private script text.
 */
let sceneSummaryProvider: (() => CrashSceneSummary | null) | null = null;

export function registerSceneSummaryProvider(
  provider: (() => CrashSceneSummary | null) | null,
): () => void {
  sceneSummaryProvider = provider;
  return () => {
    if (sceneSummaryProvider === provider) sceneSummaryProvider = null;
  };
}

function resolveDefaultEnvironment(): CrashEnvironmentInfo {
  const isBrowser = typeof window !== 'undefined';
  const nav = isBrowser ? window.navigator : undefined;

  return {
    appVersion: '0.6.1',
    electronVersion: (typeof process !== 'undefined' && process.versions?.electron) || 'unknown',
    chromeVersion: (typeof process !== 'undefined' && process.versions?.chrome) || (nav?.userAgent || 'unknown'),
    nodeVersion: (typeof process !== 'undefined' && process.versions?.node) || 'unknown',
    platform: (typeof process !== 'undefined' && process.platform) || (nav?.platform || 'unknown'),
    arch: (typeof process !== 'undefined' && process.arch) || 'unknown',
    userAgent: nav?.userAgent,
  };
}

export function buildCrashReport(options: BuildCrashReportOptions): CrashReport {
  const reportId = `crash-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const timestamp = new Date().toISOString();

  let errorDetails: CrashErrorDetails;
  if (options.error instanceof Error) {
    errorDetails = {
      name: options.error.name || 'Error',
      message: options.error.message || String(options.error),
      stack: options.error.stack,
      componentStack: options.componentStack,
    };
  } else if (typeof options.error === 'string') {
    errorDetails = {
      name: 'Error',
      message: options.error,
      componentStack: options.componentStack,
    };
  } else {
    errorDetails = {
      name: 'UnknownError',
      message: String(options.error),
      componentStack: options.componentStack,
    };
  }

  const redactedError = redactErrorDetails(errorDetails);
  const breadcrumbs = redactBreadcrumbs(getLogBreadcrumbs());

  const environment: CrashEnvironmentInfo = {
    ...resolveDefaultEnvironment(),
    ...(environmentOverride || {}),
    ...(options.environment || {}),
  };

  const sceneSummary = options.sceneSummary ?? (sceneSummaryProvider ? sceneSummaryProvider() : undefined);

  return {
    reportId,
    timestamp,
    tier: options.tier ?? 1,
    surface: options.surface ?? 'editor',
    error: redactedError,
    environment,
    breadcrumbs,
    redacted: true,
    ...(sceneSummary ? { sceneSummary } : {}),
  };
}

export function formatCrashReportMarkdown(report: CrashReport): string {
  const lines: string[] = [];

  lines.push('# AeonStagery Crash Diagnostic Report');
  lines.push('');
  lines.push(`- **Report ID**: \`${report.reportId}\``);
  lines.push(`- **Timestamp**: \`${report.timestamp}\``);
  lines.push(`- **Surface**: \`${report.surface}\``);
  lines.push(`- **Tier**: \`Tier ${report.tier}\``);
  lines.push('');

  lines.push('## Environment');
  lines.push(`- **App Version**: \`${report.environment.appVersion}\``);
  lines.push(`- **Platform / Arch**: \`${report.environment.platform} (${report.environment.arch})\``);
  lines.push(`- **Electron / Chrome / Node**: \`${report.environment.electronVersion} / ${report.environment.chromeVersion} / ${report.environment.nodeVersion}\``);
  if (report.environment.memoryUsageMb) {
    lines.push(`- **Memory Usage**: \`${report.environment.memoryUsageMb} MB\``);
  }
  lines.push('');

  lines.push('### Error Summary');
  lines.push(`**${report.error.name}**: ${report.error.message}`);
  lines.push('');

  if (report.error.stack) {
    lines.push('#### Stack Trace');
    lines.push('```');
    lines.push(report.error.stack);
    lines.push('```');
    lines.push('');
  }

  if (report.error.componentStack) {
    lines.push('#### Component Stack');
    lines.push('```');
    lines.push(report.error.componentStack);
    lines.push('```');
    lines.push('');
  }

  if (report.breadcrumbs && report.breadcrumbs.length > 0) {
    lines.push('## Recent Activity Logs (Breadcrumbs)');
    lines.push('```');
    for (const b of report.breadcrumbs) {
      lines.push(`[${b.timestamp}] [${b.level.toUpperCase()}] [${b.context}] ${b.message}`);
    }
    lines.push('```');
    lines.push('');
  }

  if (report.sceneSummary) {
    lines.push('## Scene Summary (redacted)');
    lines.push(`- **Statements**: \`${report.sceneSummary.statementCount}\``);
    lines.push(`- **Duration**: \`${report.sceneSummary.durationSeconds ?? 'unknown'}s\``);
    lines.push('');
    if (report.sceneSummary.outline.length > 0) {
      const truncated = report.sceneSummary.outline.length < report.sceneSummary.statementCount;
      lines.push(`### Timeline Outline${truncated ? ` (first ${report.sceneSummary.outline.length} of ${report.sceneSummary.statementCount})` : ''}`);
      lines.push('```');
      for (const o of report.sceneSummary.outline) {
        const tail =
          `${o.durationSeconds != null ? ` (${o.durationSeconds}s)` : ''}` +
          `${o.characterId ? ` char=${o.characterId}` : ''}`;
        lines.push(`#${o.index} [${o.type}] @${o.startSeconds}s${tail}`);
      }
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('*Generated by AeonStagery Crash Recovery System (ADR-0032)*');

  return lines.join('\n');
}

export function formatCrashReportJson(report: CrashReport): string {
  return JSON.stringify(report, null, 2);
}
