import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import { getCollaborationWebSocketProtocols, toCollaborationWebSocketUrl } from '../services/collaboration/CollaborationTransport';

const token = 'a'.repeat(43);
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

  it('keeps websocket credentials in subprotocols and preserves presence identity in the URL', () => {
    const endpoint = `https://collab.example#token=${token}`;
    const url = toCollaborationWebSocketUrl(endpoint, { clientId: 'client-one', displayName: '导演' });
    expect(url).not.toContain(token);
    expect(new URL(url).searchParams.get('displayName')).toBe('导演');
    expect(getCollaborationWebSocketProtocols(endpoint)).toEqual(['aeonstagery-collaboration', `aeonstagery-auth.${token}`]);
  });
});
