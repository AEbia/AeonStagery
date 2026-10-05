import type { CollaborationIdentity, CollaborationServerStatus } from '../../api/types/collaboration';

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
  if (!token) return undefined;
  return isLoopbackEndpoint(endpoint)
    ? ['aeonstagery-collaboration', `aeonstagery-auth.${token}`]
    : ['aeonstagery-collaboration'];
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(normalizeCollaborationEndpoint(endpoint)).hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '[::1]'
      || hostname === '::1'
      || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

async function createCollaborationAuthProof(
  token: string,
  nonce: string,
  method: string,
  requestTarget: string,
): Promise<string> {
  const crypto = globalThis.crypto?.subtle;
  if (!crypto) throw new Error('Secure collaboration authentication is unavailable in this runtime');
  const encoder = new TextEncoder();
  const key = await crypto.importKey(
    'raw',
    encoder.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const proof = await crypto.sign(
    'HMAC',
    key,
    encoder.encode(`${nonce}\n${method.toUpperCase()}\n${requestTarget}`),
  );
  return Array.from(new Uint8Array(proof), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function collaborationAuthorizationHeaders(
  endpoint: string,
  token: string | undefined,
  method: string,
  requestTarget: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Record<string, string>> {
  if (!token) return {};
  if (isLoopbackEndpoint(endpoint)) return { authorization: `Bearer ${token}` };

  const normalizedEndpoint = normalizeCollaborationEndpoint(endpoint);
  const challengeResponse = await fetchImpl(`${normalizedEndpoint}/auth/challenge`, {
    cache: 'no-store',
    redirect: 'error',
  });
  if (!challengeResponse.ok) throw new Error('无法获取协作服务器的一次性认证挑战');
  const challengePayload: unknown = await challengeResponse.json();
  const nonce = challengePayload && typeof challengePayload === 'object' && 'nonce' in challengePayload
    ? (challengePayload as { nonce?: unknown }).nonce
    : undefined;
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error('协作服务器返回了无效的一次性认证挑战');
  }
  const proof = await createCollaborationAuthProof(token, nonce, method, requestTarget);
  return {
    'x-collaboration-nonce': nonce,
    'x-collaboration-proof': proof,
  };
}

export function authorizeCollaborationFetch(
  fetchImpl: typeof fetch,
  token?: string,
  endpoint?: string,
): typeof fetch {
  if (!token) return fetchImpl;
  const normalizedEndpoint = endpoint ? normalizeCollaborationEndpoint(endpoint) : undefined;
  const endpointOrigin = normalizedEndpoint ? new URL(normalizedEndpoint).origin : undefined;
  return async (input, init) => {
    const requestInput = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const inputUrl = requestInput?.url ?? (input instanceof URL ? input.toString() : String(input));
    const requestUrl = new URL(inputUrl, endpointOrigin);
    if (endpointOrigin && requestUrl.origin !== endpointOrigin) return fetchImpl(input, init);

    const method = init?.method ?? requestInput?.method ?? 'GET';
    const headers = new Headers(requestInput?.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (normalizedEndpoint && !isLoopbackEndpoint(normalizedEndpoint)) {
      headers.delete('authorization');
    }
    const authHeaders = await collaborationAuthorizationHeaders(
      normalizedEndpoint ?? requestUrl.origin,
      token,
      method,
      `${requestUrl.pathname}${requestUrl.search}`,
      fetchImpl,
    );
    for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value);
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}

export async function prepareCollaborationWebSocketConnection(
  endpoint: string,
  identity?: CollaborationIdentity,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<{ url: string; protocols?: string[] }> {
  const url = toCollaborationWebSocketUrl(endpoint, identity);
  const protocols = getCollaborationWebSocketProtocols(endpoint);
  const token = getCollaborationAccessToken(endpoint);
  if (!token || isLoopbackEndpoint(endpoint)) return { url, protocols };

  const websocketUrl = new URL(url);
  const authHeaders = await collaborationAuthorizationHeaders(
    endpoint,
    token,
    'GET',
    `${websocketUrl.pathname}${websocketUrl.search}`,
    fetchImpl,
  );
  websocketUrl.searchParams.set('authNonce', authHeaders['x-collaboration-nonce']);
  websocketUrl.searchParams.set('authProof', authHeaders['x-collaboration-proof']);
  return { url: websocketUrl.toString(), protocols };
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

export function isMatchingCollaborationServerHost(
  endpoint: string,
  serverStatus: CollaborationServerStatus | null | undefined,
): boolean {
  if (!serverStatus || !serverStatus.running) return false;
  try {
    const raw = endpoint.trim().split('#')[0];
    const normalized = normalizeCollaborationEndpoint(raw);
    const targetUrl = new URL(normalized);

    const targetPort = targetUrl.port
      ? Number(targetUrl.port)
      : (targetUrl.protocol === 'https:' ? 443 : 80);
    if (targetPort !== serverStatus.port) {
      return false;
    }

    const hostname = targetUrl.hostname.toLowerCase();
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0';
    if (isLoopback) {
      return true;
    }

    const candidateOrigins = [
      serverStatus.localUrl,
      ...serverStatus.lanUrls,
      ...(serverStatus.inviteUrls ?? []),
    ];
    for (const candidate of candidateOrigins) {
      if (!candidate) continue;
      try {
        const candidateUrl = new URL(candidate.split('#')[0]);
        const candidatePort = candidateUrl.port
          ? Number(candidateUrl.port)
          : (candidateUrl.protocol === 'https:' ? 443 : 80);
        if (
          candidateUrl.hostname.toLowerCase() === hostname &&
          candidatePort === targetPort
        ) {
          return true;
        }
      } catch {
        // ignore invalid URL
      }
    }

    if (
      serverStatus.host &&
      serverStatus.host !== '0.0.0.0' &&
      serverStatus.host.toLowerCase() === hostname
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
