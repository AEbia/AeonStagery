/**
 * Crash and Diagnostic Redaction Policy
 * Defined in ADR-0032
 */

import type { CrashErrorDetails, LogBreadcrumb } from '../../api/types/crash';

// Patterns to scrub
const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9_\-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
  /AIza[0-9A-Za-z-_]{35}/g,
];

const BEARER_PATTERN = /Bearer\s+[a-zA-Z0-9_\.\-]{20,}/gi;

const USER_HOME_PATTERNS = [
  /\/home\/[a-zA-Z0-9_\-.]+\//g,
  /\/Users\/[a-zA-Z0-9_\-.]+\//g,
  /[a-zA-Z]:\\Users\\[a-zA-Z0-9_\-.]+\\/gi,
];

export function redactText(text: string): string {
  if (!text) return '';
  let result = text;

  for (const pattern of API_KEY_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_API_KEY]');
  }

  result = result.replace(BEARER_PATTERN, 'Bearer [REDACTED_TOKEN]');

  for (const pattern of USER_HOME_PATTERNS) {
    result = result.replace(pattern, '~/');
  }

  return result;
}

export function redactErrorDetails(error: CrashErrorDetails): CrashErrorDetails {
  return {
    name: redactText(error.name),
    message: redactText(error.message),
    stack: error.stack ? redactText(error.stack) : undefined,
    componentStack: error.componentStack ? redactText(error.componentStack) : undefined,
  };
}

export function redactBreadcrumbs(breadcrumbs: LogBreadcrumb[]): LogBreadcrumb[] {
  return breadcrumbs.map((b) => ({
    timestamp: b.timestamp,
    level: b.level,
    context: redactText(b.context),
    message: redactText(b.message),
  }));
}
