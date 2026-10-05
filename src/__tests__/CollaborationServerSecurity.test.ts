import { request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCollaborationServer, type RunningCollaborationServer } from '../../server/collaboration/server';
import { collaborationEndpointWithPassword } from '../services/collaboration/CollaborationTransport';
import { COLLABORATION_LIMITS, createCollaborationAuthProof } from '../../server/collaboration/security';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import { authenticatedFetch } from './helpers/collaborationAuth';

describe('collaboration server security boundary', () => {
  let tempDir: string;
  let server: RunningCollaborationServer;
  const sockets = new Set<WebSocket>();
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeon-collab-security-'));
    server = await startCollaborationServer({ host: '127.0.0.1', port: 0, dataDir: tempDir });
  });
  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function connect(protocols?: string[], origin?: string): WebSocket {
    const socket = new WebSocket(`${server.getStatus().localUrl.replace('http:', 'ws:')}/sync`, protocols, origin ? { origin } : {});
    socket.on('error', () => {});
    sockets.add(socket);
    return socket;
  }
  function protocols(): string[] {
    return ['aeonstagery-collaboration', `aeonstagery-auth.${server.getStatus().accessToken}`];
  }
  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  }
  function handshakeStatus(socket: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => reject(new Error('Unauthorized handshake succeeded')));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.once('error', reject);
    });
  }

  it('requires a token on every data route before accepting bodies or revealing state', async () => {
    const status = server.getStatus();
    for (const [route, method] of [
      ['/health', 'GET'], ['/state', 'GET'], ['/snapshot', 'GET'], ['/yjs-state', 'GET'],
      ['/seed', 'POST'], ['/assets/background/test.png', 'GET'], ['/assets/background/test.png', 'PUT'],
    ]) {
      const response = await fetch(`${status.localUrl}${route}`, { method });
      expect(response.status, `${method} ${route}`).toBe(401);
      expect(await response.text()).not.toContain(tempDir);
    }
    const wrong = await fetch(`${status.localUrl}/health`, { headers: { authorization: `Bearer ${'x'.repeat(43)}` } });
    expect(wrong.status).toBe(401);
    expect((await authenticatedFetch(status, `${status.localUrl}/health`)).status).toBe(200);
    expect(await fs.readdir(status.assetRoot)).toEqual([]);
    expect(status.hasState).toBe(false);
  });

  it('restricts CORS and websocket origins, including credentialed requests', async () => {
    const status = server.getStatus();
    const rejected = await authenticatedFetch(status, `${status.localUrl}/health`, { headers: { origin: 'https://evil.example' } });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
    const allowed = await fetch(`${status.localUrl}/seed`, { method: 'OPTIONS', headers: { origin: 'null' } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('null');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('authorization');
    await expect(handshakeStatus(connect(protocols(), 'https://evil.example'))).resolves.toBe(403);
  });

  it.each([
    'null',
    'file://',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5199',
    'http://[::1]:5174',
  ])('allows peers using a different local development origin: %s', async (origin) => {
    const status = server.getStatus();
    const salt = await fetch(`${status.localUrl}/auth/salt`, { headers: { origin } });
    expect(salt.status).toBe(200);
    expect(salt.headers.get('access-control-allow-origin')).toBe(origin);

    const preflight = await fetch(`${status.localUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-collaboration-nonce,x-collaboration-proof',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-collaboration-proof');

    const challenge = await fetch(`${status.localUrl}/auth/challenge`, { headers: { origin } });
    expect(challenge.status).toBe(200);
    expect(challenge.headers.get('access-control-allow-origin')).toBe(origin);
    const { nonce } = await challenge.json() as { nonce: string };
    const health = await fetch(`${status.localUrl}/health`, {
      headers: {
        origin,
        'x-collaboration-nonce': nonce,
        'x-collaboration-proof': createCollaborationAuthProof(status.accessToken, nonce, 'GET', '/health'),
      },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBe(origin);

    const wsChallenge = await fetch(`${status.localUrl}/auth/challenge`, { headers: { origin } });
    const { nonce: wsNonce } = await wsChallenge.json() as { nonce: string };
    const wsProof = createCollaborationAuthProof(status.accessToken, wsNonce, 'GET', '/sync');
    const socket = new WebSocket(
      `${status.localUrl.replace('http:', 'ws:')}/sync?authNonce=${wsNonce}&authProof=${wsProof}`,
      ['aeonstagery-collaboration'],
      { origin },
    );
    sockets.add(socket);
    await opened(socket);
    expect(socket.protocol).toBe('aeonstagery-collaboration');
  });

  it.each([
    'http://localhost.evil.example:5173',
    'http://127.0.0.1.evil.example:5173',
    'http://192.168.1.10:5173',
  ])('rejects origins outside local development: %s', async (origin) => {
    const response = await fetch(`${server.getStatus().localUrl}/auth/challenge`, { headers: { origin } });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(handshakeStatus(connect(protocols(), origin))).resolves.toBe(403);
  });

  it('honors an explicit origin allowlist without adding local development origins', async () => {
    await server.stop();
    const origin = 'https://editor.example';
    server = await startCollaborationServer({
      host: '127.0.0.1', port: 0, dataDir: tempDir, allowedOrigins: [origin],
    });
    const allowed = await fetch(`${server.getStatus().localUrl}/auth/salt`, { headers: { origin } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
    const rejected = await fetch(`${server.getStatus().localUrl}/auth/salt`, {
      headers: { origin: 'http://localhost:5174' },
    });
    expect(rejected.status).toBe(403);
    await expect(handshakeStatus(connect(protocols(), 'http://localhost:5174'))).resolves.toBe(403);
  });

  it('authenticates websocket upgrade without putting credentials in URLs or response protocols', async () => {
    await expect(handshakeStatus(connect())).resolves.toBe(401);
    await expect(handshakeStatus(connect(['aeonstagery-collaboration', `aeonstagery-auth.${'x'.repeat(43)}`]))).resolves.toBe(401);
    const socket = connect(protocols());
    await opened(socket);
    expect(socket.protocol).toBe('aeonstagery-collaboration');
    expect(socket.url).not.toContain(server.getStatus().accessToken);
  });

  it('supports authenticated HTTP and realtime clients in both protocol versions', async () => {
    const status = server.getStatus();
    for (const Client of [CollaborationClientV2, CollaborationClientV3]) {
      const client = new Client({
        endpoint: `${status.localUrl}#token=${status.accessToken}`,
        webSocketFactory: (url, offered) => {
          const socket = new WebSocket(url, offered);
          sockets.add(socket);
          return socket as any;
        },
      });
      try {
        expect(client.endpoint).not.toContain(status.accessToken);
        await client.uploadAssetFile('background/test.bin', new Uint8Array([1, 2, 3]));
        expect(await client.downloadAssetFile('background/test.bin')).toEqual(new Uint8Array([1, 2, 3]));
        await expect(client.join()).resolves.toBeNull();
      } finally { client.dispose(); }
    }
  });

  it('rejects malformed JSON and malformed percent escapes without exposing local errors', async () => {
    const status = server.getStatus();
    for (const body of ['{', 'null', '[]']) {
      const response = await authenticatedFetch(status, `${status.localUrl}/seed`, { method: 'POST', body });
      expect(response.status).toBe(400);
    }
    const invalidPath = await authenticatedFetch(status, `${status.localUrl}/assets/%ZZ`);
    expect(invalidPath.status).toBe(400);
    expect(await invalidPath.text()).not.toContain(tempDir);
    expect((await authenticatedFetch(status, `${status.localUrl}/health`)).status).toBe(200);
  });

  it('rejects oversized declared and streamed HTTP bodies', async () => {
    const status = server.getStatus();
    const declared = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${status.localUrl}/seed`, {
        method: 'POST', headers: { authorization: `Bearer ${status.accessToken}`, 'content-length': COLLABORATION_LIMITS.jsonBytes + 1 },
      }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.flushHeaders();
    });
    expect(declared).toBe(413);
    const streamed = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${status.localUrl}/seed`, {
        method: 'POST', headers: { authorization: `Bearer ${status.accessToken}`, 'transfer-encoding': 'chunked' },
      }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on('error', reject);
      request.end(Buffer.alloc(COLLABORATION_LIMITS.jsonBytes + 1));
    });
    expect(streamed).toBe(413);
    expect(server.getStatus().hasState).toBe(false);
  });

  it('closes oversized websocket payloads and survives malformed frames', async () => {
    const socket = connect(protocols());
    await opened(socket);
    socket.send(Buffer.from([255, 255, 255]));
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(Buffer.alloc(COLLABORATION_LIMITS.websocketBytes + 1));
    expect(await closed).toBe(1009);
    const status = server.getStatus();
    expect((await authenticatedFetch(status, `${status.localUrl}/health`)).status).toBe(200);
  });

  it('rotates generated credentials across restarts without revealing them through health', async () => {
    const previous = server.getStatus();
    await server.stop();
    server = await startCollaborationServer({ host: '127.0.0.1', port: 0, dataDir: tempDir });
    const current = server.getStatus();
    expect(current.accessToken).not.toBe(previous.accessToken);
    expect(current.inviteUrls[0]).toContain(`#token=${current.accessToken}`);
    expect((await authenticatedFetch(previous, `${current.localUrl}/health`)).status).toBe(401);
    const body = await (await authenticatedFetch(current, `${current.localUrl}/health`)).json();
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('dataDir');
    expect(body).not.toHaveProperty('assetRoot');
  });
  it('allows address and password connections without an invite link', async () => {
    await server.stop();
    const password = 'a custom room password';
    server = await startCollaborationServer({ host: '127.0.0.1', port: 0, dataDir: tempDir, password });
    const status = server.getStatus();
    expect(status.connectionPassword).toBe(password);
    const endpoint = await collaborationEndpointWithPassword(status.localUrl, password);
    const client = new CollaborationClientV3({ endpoint });
    try {
      await client.uploadAssetFile('background/password.bin', new Uint8Array([42]));
      expect(await client.downloadAssetFile('background/password.bin')).toEqual(new Uint8Array([42]));
      await expect(client.join()).resolves.toBeNull();
    } finally { client.dispose(); }
    const wrongEndpoint = await collaborationEndpointWithPassword(status.localUrl, 'an incorrect password');
    const wrongClient = new CollaborationClientV3({ endpoint: wrongEndpoint });
    try { await expect(wrongClient.join()).rejects.toThrow('密码'); }
    finally { wrongClient.dispose(); }
  });

  it('does not serve local files outside the shared asset directory over HTTP', async () => {
    const status = server.getStatus();
    const outside = path.join(tempDir, 'private');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'local secret');
    await fs.symlink(outside, path.join(status.assetRoot, 'redirect'), 'junction');
    for (const route of ['/assets/redirect/secret.txt', '/assets/%2e%2e%2fprivate%2fsecret.txt', '/private/secret.txt']) {
      const response = await authenticatedFetch(status, `${status.localUrl}${route}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('local secret');
    }
    const write = await authenticatedFetch(status, `${status.localUrl}/assets/redirect/secret.txt`, { method: 'PUT', body: 'overwrite' });
    expect(write.status).toBe(400);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('local secret');
  });

});
