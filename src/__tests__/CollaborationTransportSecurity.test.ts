import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import {
  authorizeCollaborationFetch,
  getCollaborationWebSocketProtocols,
  prepareCollaborationWebSocketConnection,
  toCollaborationWebSocketUrl,
} from '../services/collaboration/CollaborationTransport';

const token = 'a'.repeat(43);
const identity = { clientId: 'client-one', displayName: '导演' };

/** Mirrors the server-side HMAC proof so the tests pin the exact signed payload. */
async function createExpectedProof(
  secret: string,
  nonce: string,
  method: string,
  requestTarget: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${nonce}\n${method.toUpperCase()}\n${requestTarget}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stubChallengeFetch(nonce: string) {
  return vi.fn(async () => new Response(JSON.stringify({ nonce }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('collaboration credential transport', () => {
  it.each([CollaborationClientV2, CollaborationClientV3])('authorizes XHR uploads through the same credential as fetch', async (Client) => {
    const headers: Record<string, string> = {};
    let requestUrl = '';
    class FakeXhr {
      upload = {};
      status = 201;
      onload?: () => void;
      open(_method: string, url: string): void { requestUrl = url; }
      setRequestHeader(name: string, value: string): void { headers[name] = value; }
      send(): void { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const client = new Client({ endpoint: `http://localhost:12345#token=${token}` });
    try { await client.uploadAssetFile('background/file.bin', new Uint8Array([1])); }
    finally { client.dispose(); }
    expect(headers.authorization).toBe(`Bearer ${token}`);
    expect(requestUrl).toBe('http://localhost:12345/assets/background/file.bin');
    expect(requestUrl).not.toContain(token);
  });

  it.each([CollaborationClientV2, CollaborationClientV3])('disallows fetch redirects while transmitting the credential', async (Client) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const client = new Client({ endpoint: `http://localhost:12345#token=${token}`, fetchImpl });
    try { await client.uploadAssetFile('background/file.bin', new Uint8Array([1])); }
    finally { client.dispose(); }
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(token);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(init.redirect).toBe('error');
  });

  it('keeps websocket credentials in subprotocols and preserves presence identity in the URL', async () => {
    const endpoint = `http://localhost:12345#token=${token}`;
    const url = toCollaborationWebSocketUrl(endpoint, identity);
    expect(url).not.toContain(token);
    expect(new URL(url).searchParams.get('displayName')).toBe('导演');
    expect(getCollaborationWebSocketProtocols(endpoint)).toEqual(['aeonstagery-collaboration', `aeonstagery-auth.${token}`]);

    // The loopback path is trusted local IPC, so it authenticates through the
    // subprotocol without requesting a one-time challenge.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const connection = await prepareCollaborationWebSocketConnection(endpoint, identity, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(connection.url).not.toContain(token);
    expect(connection.protocols).toEqual(['aeonstagery-collaboration', `aeonstagery-auth.${token}`]);
  });

  it('never puts the bearer token in remote websocket protocols, proving a one-time challenge instead', async () => {
    const endpoint = `https://collab.example#token=${token}`;
    const nonce = 'b'.repeat(43);
    const fetchImpl = stubChallengeFetch(nonce);

    expect(getCollaborationWebSocketProtocols(endpoint)).toEqual(['aeonstagery-collaboration']);

    const connection = await prepareCollaborationWebSocketConnection(endpoint, identity, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('https://collab.example/auth/challenge', {
      cache: 'no-store',
      redirect: 'error',
    });
    expect(connection.protocols).toEqual(['aeonstagery-collaboration']);
    expect(connection.url).not.toContain(token);

    const url = new URL(connection.url);
    expect(url.searchParams.get('displayName')).toBe('导演');
    expect(url.searchParams.get('authNonce')).toBe(nonce);
    const proof = url.searchParams.get('authProof');
    url.searchParams.delete('authNonce');
    url.searchParams.delete('authProof');
    expect(proof).toBe(await createExpectedProof(token, nonce, 'GET', `${url.pathname}${url.search}`));
  });

  it('replaces the bearer header with a challenge proof on remote HTTP requests', async () => {
    const endpoint = `https://collab.example#token=${token}`;
    const nonce = 'c'.repeat(43);
    const fetchImpl = stubChallengeFetch(nonce);
    const authorizedFetch = authorizeCollaborationFetch(fetchImpl, token, endpoint);

    await authorizedFetch('https://collab.example/yjs-state');

    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://collab.example/yjs-state');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-collaboration-nonce')).toBe(nonce);
    expect(headers.get('x-collaboration-proof'))
      .toBe(await createExpectedProof(token, nonce, 'GET', '/yjs-state'));
    expect(init.redirect).toBe('error');
  });
});
