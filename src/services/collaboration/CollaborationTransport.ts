import type { CollaborationIdentity } from '../../api/types/collaboration';

export interface CollaborationWebSocketLike {
  binaryType: BinaryType;
  readyState: number;
  onopen?: (() => void | Promise<void>) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: Uint8Array | string): void;
  close(): void;
}

export function normalizeCollaborationEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error('Collaboration endpoint is required');
  const httpEndpoint = trimmed
    .replace(/^tcp:\/\//i, 'http://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://');
  const withProtocol = /^https?:\/\//i.test(httpEndpoint) ? httpEndpoint : `http://${httpEndpoint}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported collaboration endpoint protocol: ${url.protocol}`);
  }
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function toCollaborationWebSocketUrl(endpoint: string, identity?: CollaborationIdentity): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/sync';
  url.search = '';
  if (identity) {
    url.searchParams.set('clientId', identity.clientId);
    url.searchParams.set('displayName', identity.displayName);
  }
  url.hash = '';
  return url.toString();
}
