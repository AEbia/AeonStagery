import type { GenericServerOptions } from 'builder-util-runtime';

export function getUpdateChannel(version: string): string {
  return /^[^-]+-([^+.]+)/.exec(version)?.[1] || 'latest';
}

export function createUpdateFeedOptions(url: string, version: string): GenericServerOptions {
  return { provider: 'generic', url, channel: getUpdateChannel(version), useMultipleRangeRequest: false };
}
