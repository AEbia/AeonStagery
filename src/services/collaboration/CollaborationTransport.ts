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
  if (url.username || url.password || url.search) {
    throw new Error('Collaboration endpoint must not contain credentials or query parameters');
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

/** Invite credentials stay in the fragment, outside HTTP URLs and request logs. */
export function getCollaborationAccessToken(endpoint: string): string | undefined {
  const fragment = endpoint.split('#')[1];
  const token = fragment ? new URLSearchParams(fragment).get('token') : null;
  if (token === null) return undefined;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error('Invalid collaboration access token in invite link');
  }
  return token;
}

export function withCollaborationAccessToken(endpoint: string, token?: string): string {
  const normalized = normalizeCollaborationEndpoint(endpoint);
  return token ? `${normalized}#token=${encodeURIComponent(token)}` : normalized;
}

export function getCollaborationWebSocketProtocols(endpoint: string): string[] | undefined {
  const token = getCollaborationAccessToken(endpoint);
  return token ? ['aeonstagery-collaboration', `aeonstagery-auth.${token}`] : undefined;
}

export function authorizeCollaborationFetch(fetchImpl: typeof fetch, token?: string): typeof fetch {
  if (!token) return fetchImpl;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}

export async function collaborationEndpointWithPassword(endpoint: string, password: string): Promise<string> {
  if (!password) return endpoint;
  const normalizedEndpoint = normalizeCollaborationEndpoint(endpoint);
  const saltResponse = await fetch(`${normalizedEndpoint}/auth/salt`, {
    cache: 'no-store',
    redirect: 'error',
  });
  if (!saltResponse.ok) throw new Error('无法获取协作房间的密码 salt');
  const saltPayload: unknown = await saltResponse.json();
  const salt = saltPayload && typeof saltPayload === 'object' && 'salt' in saltPayload
    ? (saltPayload as { salt?: unknown }).salt
    : undefined;
  if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/.test(salt)) {
    throw new Error('协作服务器返回了无效的密码 salt');
  }
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', iterations: 210_000,
    salt: new TextEncoder().encode(salt),
  }, key, 256);
  const token = Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return withCollaborationAccessToken(normalizedEndpoint, token);
}
