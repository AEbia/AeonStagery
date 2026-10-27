import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const token = 'a'.repeat(43);
const projectRoot = path.resolve(__dirname, '../..');

describe('collaboration CLI startup', () => {
  let dataDir: string;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeon-collab-cli-'));
  });

  async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    children.delete(child);
  }

  afterEach(async () => {
    await Promise.all([...children].map(stop));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function launch(flags: string[]): ChildProcessWithoutNullStreams {
    const env: NodeJS.ProcessEnv = { ...process.env, AEONSTAGERY_COLLAB_TOKEN: token };
    delete env.AEONSTAGERY_COLLAB_PASSWORD;
    const child = spawn(process.execPath, [
      '--import', 'tsx', 'server/collaboration/index.ts',
      '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDir, ...flags,
    ], { cwd: projectRoot, env });
    children.add(child);
    return child;
  }

  async function start(flags: string[]): Promise<{ child: ChildProcessWithoutNullStreams; endpoint: string }> {
    const child = launch(flags);
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error(`CLI startup timed out: ${output}`)), 10_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`CLI exited with ${code}: ${output}`));
      });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const listening = output.match(/\[collab\] listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (listening) { clearTimeout(timeout); resolve(listening[1]); }
      });
    });
    return { child, endpoint };
  }

  it.each([
    { label: 'default version', flags: [] },
    { label: 'schema-version flag', flags: ['--schema-version', '3'] },
    { label: 'collaboration-schema-version alias', flags: ['--collaboration-schema-version', '3'] },
  ])('starts, serves and resumes a V3 room with $label', async ({ flags }) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const first = await start(flags);
    const health = await fetch(`${first.endpoint}/health`, { headers });
    expect(await health.json()).toMatchObject({ ok: true, schemaVersion: 3, hasState: false });
    const seeded = await fetch(`${first.endpoint}/seed`, {
      method: 'POST', headers,
      body: JSON.stringify({
        schemaVersion: 3, sceneSchemaVersion: 5,
        collaborationProjectId: 'cli-project', roomId: 'cli-project:main', sceneId: 'main',
        meta: { title: 'CLI room', fps: 60 }, statementsById: {}, statementOrder: [],
      }),
    });
    expect(seeded.status).toBe(201);
    await stop(first.child);

    const resumed = await start(flags);
    const snapshot = await fetch(`${resumed.endpoint}/snapshot`, { headers });
    expect(await snapshot.json()).toMatchObject({ schemaVersion: 5, sceneId: 'main', meta: { title: 'CLI room' } });
  }, 20_000);

  it.each(['--schema-version', '--collaboration-schema-version'])('rejects retired V2 through %s before opening a room', async (flag) => {
    const child = launch([flag, '2']);
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
    const [code] = await once(child, 'exit');
    expect(code).not.toBe(0);
    expect(diagnostics).toContain('Only collaboration schema version 3 is supported');
    expect(await fs.readdir(dataDir)).toEqual([]);
  });
});
