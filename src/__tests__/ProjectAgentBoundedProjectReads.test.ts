import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AiConversationIpc } from '../api/types/ai-conversation-ipc';
import type { AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import type { ExternalLibraryMount } from '../api/types/project';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { createAiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import {
  createProjectAgentProjectReadPorts,
} from '../services/project-agent/ProjectAgentProjectReadPorts';
import { ProjectAgentNodeProjectFs } from '../services/project-agent/ProjectAgentNodeProjectFs';
import { ProjectAgentIFileAccessFs } from '../services/project-agent/ProjectAgentProjectFs';
import {
  isAiProseDraftPath,
  isCanonicalPathWithinRoot,
  isForbiddenProjectPath,
} from '../services/project-agent/ProjectAgentPathRules';
import { ProjectAgentReadTools } from '../services/project-agent/ProjectAgentReadTools';
import { ProjectAgentTaskState } from '../services/project-agent/ProjectAgentTaskState';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
} from '../services/project-agent-service/ProjectAgentService';
import {
  ProjectAgentTaskCoordinator,
  type ProjectAgentWindowController,
} from '../services/project-agent-service/ProjectAgentTaskCoordinator';
import { FileSystemProjectAgentJournalPort } from '../services/project-agent-service/FileSystemProjectAgentJournalPort';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';
import { createSymlinkFixture } from './helpers/symlinkFixtures';

const SCENE_DOCUMENT_ID = 'scene-doc-bounded';
const SCENE_ENTRY_ID = 'scene-entry-bounded';

interface Sandbox {
  root: string;
  write(relative: string, content: string | Buffer): void;
  mkdir(relative: string): void;
  symlink(target: string, relative: string): void;
  cleanup(): void;
}

function createSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bounded-reads-'));
  return {
    root,
    write(relative, content) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    },
    mkdir(relative) {
      fs.mkdirSync(path.join(root, relative), { recursive: true });
    },
    symlink(target, relative) {
      createSymlinkFixture(target, path.join(root, relative));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: { title: 'Bounded Scene', characters: [] },
    statements: [],
  };
}

function createTools(
  root: string,
  externalMounts: readonly ExternalLibraryMount[] = [],
): {
  tools: ProjectAgentReadTools;
  ports: ProjectAgentReadPorts;
} {
  const ports = createProjectAgentProjectReadPorts({
    fs: new ProjectAgentNodeProjectFs(),
    getProjectRoot: () => root,
    getExternalMounts: () => externalMounts,
  });
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'Bounded Project',
        projectVersion: 1,
        scenes: [],
        assetRoots: {},
      }),
    },
    files: ports.files,
    text: ports.text,
    textSearch: ports.textSearch,
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({ exists: false, reference, scope: 'project', bindable: false }),
    },
    scene: { getSnapshot: () => ({ document: makeDocument(), version: 1 }) },
    validation: { validate: () => [] },
  };
  return { tools: new ProjectAgentReadTools({ ports: readPorts, taskState: new ProjectAgentTaskState() }), ports: readPorts };
}

describe('ProjectAgentPathRules bounded project reads', () => {
  it('treats AI prose draft storage under the project asset root as forbidden', () => {
    // AiProseDraftPersistence writes drafts at <assetRoot.project>/ai-authoring/<sceneId>/<session>.json
    expect(isForbiddenProjectPath('project/ai-authoring/scene-1/abc123.json')).toBe(true);
    expect(isAiProseDraftPath('project/ai-authoring/scene-1/abc123.json')).toBe(true);
    expect(isAiProseDraftPath('ai-authoring/scene-1/abc123.json')).toBe(true);
  });

  it('contains canonical Windows paths without treating child resources as escapes', () => {
    expect(isCanonicalPathWithinRoot(
      'C:\\Library\\game\\background\\bg.png',
      'C:\\Library',
    )).toBe(true);
    expect(isCanonicalPathWithinRoot(
      'C:\\Library-archive\\game\\background\\bg.png',
      'C:\\Library',
    )).toBe(false);
    expect(isCanonicalPathWithinRoot(
      'C:\\Library\\game\\background\\bg.png',
      'C:\\',
    )).toBe(true);
  });
});

describe('bounded project read ports (sandbox)', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.write('readme.md', '# Project\n');
    sandbox.write('notes/todo.txt', 'line one\ntodo item here\nline three');
    sandbox.write('images/bg.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    // Forbidden categories
    sandbox.write('project.json', '{"projectId":"secret-id"}');
    sandbox.write('scenes/main.scene.json', '{"formal":"scene"}');
    sandbox.write('project/ai-authoring/scene-1/abc123.json', '{"draft":"ai prose"}');
    sandbox.mkdir('.agent');
    sandbox.write('.agent/task.json', '{"journal":"agent"}');
    sandbox.write('.git/config', '[core]\n');
    sandbox.write('.env', 'SECRET=value');
    sandbox.write('credentials/secrets.json', '{"key":"secret"}');
    sandbox.write('keys/private.pem', 'PRIVATE KEY');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('lists allowed files recursively with deterministic order and metadata', async () => {
    const { tools } = createTools(sandbox.root);
    const result = await tools.listProjectFiles({ offset: 0, limit: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.data.entries.map((entry) => entry.path);
    expect(paths).toContain('readme.md');
    expect(paths).toContain('notes/todo.txt');
    expect(paths).toContain('images/bg.png');
    expect(paths).toEqual([...paths].sort());

    const binary = result.data.entries.find((entry) => entry.path === 'images/bg.png');
    expect(binary?.kind).toBe('file');
    expect(binary?.binary).toBe(true);
    expect(binary?.mimeType).toBe('image/png');
    expect(binary?.sizeBytes).toBeGreaterThan(0);
  });

  it('excludes every forbidden category from list, read and search', async () => {
    const { tools } = createTools(sandbox.root);
    const forbidden = [
      'project.json',
      'scenes/main.scene.json',
      'project/ai-authoring/scene-1/abc123.json',
      '.agent/task.json',
      '.git/config',
      '.env',
      'credentials/secrets.json',
      'keys/private.pem',
    ];

    const listed = await tools.listProjectFiles({ offset: 0, limit: 200 });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const listedPaths = new Set(listed.data.entries.map((entry) => entry.path));
      for (const forbiddenPath of forbidden) {
        expect(listedPaths.has(forbiddenPath)).toBe(false);
      }
    }

    for (const forbiddenPath of forbidden) {
      const read = await tools.readProjectText({ path: forbiddenPath });
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(['forbidden_path', 'invalid_arguments']).toContain(read.error.code);
        expect(read.error.message).not.toContain(sandbox.root);
      }
    }

    const searched = await tools.searchProjectText({ query: 'secret' });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      const hitPaths = searched.data.hits.map((hit) => hit.path);
      expect(hitPaths).not.toContain('project.json');
      expect(hitPaths).not.toContain('credentials/secrets.json');
      expect(hitPaths).not.toContain('.env');
    }
  });

  it('reports not_found for missing files even when the path category is forbidden', async () => {
    const { tools } = createTools(sandbox.root);

    // Existing protected files stay forbidden_path, without the misleading
    // fix_arguments suggestion (the path is inherently unreadable).
    for (const existing of ['project.json', 'scenes/main.scene.json', '.env', 'keys/private.pem']) {
      const read = await tools.readProjectText({ path: existing });
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error.code).toBe('forbidden_path');
        expect(read.error.suggestedAction).toBeUndefined();
      }
    }

    // Missing files under a forbidden category report not_found, not
    // forbidden_path: the agent learns the file is absent, not that its
    // argument was wrong.
    for (const missing of [
      'scenes/does-not-exist.scene.json',
      'scenes/missing.json',
      '.agent/missing.json',
      'keys/missing.pem',
    ]) {
      const read = await tools.readProjectText({ path: missing });
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error.code).toBe('not_found');
        expect(read.error.suggestedAction).toBeUndefined();
      }
    }
  });

  it('exposes transparent total and excludedCount for the file list', async () => {
    const { tools } = createTools(sandbox.root);
    const result = await tools.listProjectFiles({ offset: 0, limit: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sandbox writes 3 visible files plus 8 protected entries (5 files and
    // 3 whole forbidden directories: .agent, .git, credentials).
    expect(result.data.total).toBe(3);
    expect(result.data.excludedCount).toBe(8);
    expect(result.data.entries).toHaveLength(3);
  });

  it('distinguishes an empty project (total 0, excludedCount 0) from an all-forbidden view', async () => {
    const empty = createSandbox();
    const onlyForbidden = createSandbox();
    try {
      onlyForbidden.write('project.json', '{"projectId":"secret-id"}');
      onlyForbidden.write('scenes/main.scene.json', '{"formal":"scene"}');

      const emptyResult = await createTools(empty.root).tools.listProjectFiles({ offset: 0, limit: 200 });
      expect(emptyResult.ok).toBe(true);
      if (!emptyResult.ok) return;
      expect(emptyResult.data.total).toBe(0);
      expect(emptyResult.data.excludedCount).toBe(0);

      const forbiddenResult = await createTools(onlyForbidden.root).tools.listProjectFiles({ offset: 0, limit: 200 });
      expect(forbiddenResult.ok).toBe(true);
      if (!forbiddenResult.ok) return;
      expect(forbiddenResult.data.total).toBe(0);
      expect(forbiddenResult.data.excludedCount).toBeGreaterThan(0);
    } finally {
      empty.cleanup();
      onlyForbidden.cleanup();
    }
  });

  it('always returns nextStartLine on text reads, even on the last page', async () => {
    const { tools } = createTools(sandbox.root);
    const result = await tools.readProjectText({ path: 'notes/todo.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextStartLine).toBe(4);
  });

  it('always returns nextOffset on list and search results, even on the last page', async () => {
    const { tools } = createTools(sandbox.root);

    const listed = await tools.listProjectFiles({ offset: 0, limit: 100 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.hasMore).toBe(false);
    expect(listed.data.nextOffset).toBe(100);

    const searched = await tools.searchProjectText({ query: 'todo', offset: 0, limit: 100 });
    expect(searched.ok).toBe(true);
    if (!searched.ok) return;
    expect(searched.data.hasMore).toBe(false);
    expect(searched.data.nextOffset).toBe(100);
  });

  it('rejects absolute paths, traversal and escaping symlinks', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bounded-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
      fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'dir', 'inner.txt'), 'inner secret');
      sandbox.symlink(outside, 'escape-root');
      sandbox.symlink(path.join(outside, 'dir'), 'escape-dir');
      sandbox.write('inside.txt', 'inside content');

      const { tools } = createTools(sandbox.root);

      for (const raw of ['/etc/passwd', '../outside', 'C:/Windows/win.ini']) {
        const result = await tools.readProjectText({ path: raw });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['forbidden_path', 'invalid_arguments']).toContain(result.error.code);
        }
      }

      const escapingFile = await tools.readProjectText({ path: 'escape-root/secret.txt' });
      expect(escapingFile.ok).toBe(false);
      if (!escapingFile.ok) expect(escapingFile.error.code).toBe('forbidden_path');

      const escapingDirList = await tools.listProjectFiles({ offset: 0, limit: 200 });
      expect(escapingDirList.ok).toBe(true);
      if (escapingDirList.ok) {
        const paths = escapingDirList.data.entries.map((entry) => entry.path);
        expect(paths).not.toContain('escape-root/secret.txt');
        expect(paths).not.toContain('escape-dir/inner.txt');
        expect(paths).toContain('inside.txt');
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a registered external library text file through its stable mount reference', async () => {
    const mount = createSandbox();
    try {
      mount.write('docs/library-guide.txt', 'first line\nsecond line\nthird line');
      const { tools } = createTools(sandbox.root, [
        { id: 'shared-library', path: mount.root },
      ]);

      const result = await tools.readProjectText({
        path: '@mount/shared-library/docs/library-guide.txt',
        startLine: 2,
        lineCount: 1,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.path).toBe('@mount/shared-library/docs/library-guide.txt');
      expect(result.data.lines).toEqual(['second line']);
      expect(result.data.startLine).toBe(2);
      expect(result.data.endLine).toBe(2);
      expect(result.data.hasMore).toBe(true);
      expect(result.data.nextStartLine).toBe(3);
    } finally {
      mount.cleanup();
    }
  });

  it('keeps mounted text reads inside registered roots and protected paths', async () => {
    const mount = createSandbox();
    const outside = createSandbox();
    try {
      mount.write('.env', 'MOUNT_SECRET=value');
      mount.mkdir('docs');
      outside.write('secret.txt', 'outside secret');
      mount.symlink(outside.root, 'docs/escape');
      const { tools } = createTools(sandbox.root, [
        { id: 'shared-library', path: mount.root },
      ]);

      for (const reference of [
        '@mount/missing/docs/library-guide.txt',
        '@mount/shared-library/.env',
        '@mount/shared-library/docs/escape/secret.txt',
      ]) {
        const result = await tools.readProjectText({ path: reference });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['not_found', 'forbidden_path']).toContain(result.error.code);
          expect(result.error.message).not.toContain(mount.root);
          expect(result.error.message).not.toContain(outside.root);
        }
      }
    } finally {
      mount.cleanup();
      outside.cleanup();
    }
  });

  it('returns binary metadata only and bounded line windows with nextStartLine', async () => {
    const { tools } = createTools(sandbox.root);

    const binary = await tools.readProjectText({ path: 'images/bg.png' });
    expect(binary.ok).toBe(true);
    if (!binary.ok) return;
    expect(binary.data.binary).toBe(true);
    expect(binary.data.lines).toEqual([]);
    expect(binary.data.mimeType).toBe('image/png');
    expect(binary.data.sizeBytes).toBeGreaterThan(0);

    const text = await tools.readProjectText({ path: 'notes/todo.txt', startLine: 2, lineCount: 1 });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.data.lines).toEqual(['todo item here']);
    expect(text.data.startLine).toBe(2);
    expect(text.data.endLine).toBe(2);
    expect(text.data.hasMore).toBe(true);
    expect(text.data.nextStartLine).toBe(3);
    expect(text.data.totalLines).toBe(3);

    const beyond = await tools.readProjectText({ path: 'notes/todo.txt', startLine: 99 });
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.error.code).toBe('invalid_arguments');
  });

  it('marks list and search results truncated when the requested limit exceeds the max', async () => {
    const { tools } = createTools(sandbox.root);

    const listed = await tools.listProjectFiles({ offset: 0, limit: 5000 });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data.truncated).toBe(true);
      expect(listed.truncated).toBe(true);
      expect(listed.data.entries.length).toBeLessThanOrEqual(200);
    }

    const searched = await tools.searchProjectText({ query: 'line', limit: 5000 });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.data.truncated).toBe(true);
      expect(searched.truncated).toBe(true);
      expect(searched.data.hits.length).toBeLessThanOrEqual(100);
    }
  });

  it('paginates the file list with stable hasMore/nextOffset', async () => {
    for (let i = 0; i < 5; i += 1) {
      sandbox.write(`files/file-${String(i).padStart(2, '0')}.txt`, `content ${i}`);
    }
    const { tools } = createTools(sandbox.root);
    const first = await tools.listProjectFiles({ offset: 0, limit: 3 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.entries).toHaveLength(3);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextOffset).toBe(3);

    const second = await tools.listProjectFiles({ offset: 3, limit: 3 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const all = [...first.data.entries, ...second.data.entries];
    const sorted = [...all].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    expect(all.map((entry) => entry.path)).toEqual(sorted.map((entry) => entry.path));
    expect(new Set(all.map((entry) => entry.path)).size).toBe(all.length);
  });

  it('keeps the list revision stable when readdir order changes but the tree does not', async () => {
    for (let i = 0; i < 4; i += 1) {
      sandbox.write(`tree/file-${String(i).padStart(2, '0')}.txt`, `content ${i}`);
    }
    const base = new ProjectAgentNodeProjectFs();
    const state = { reverseOrder: false };
    const orderShufflingFs = {
      readDir: async (dir: string) => {
        const entries = await base.readDir(dir);
        return state.reverseOrder ? [...entries].reverse() : entries;
      },
      stat: (entryPath: string) => base.stat(entryPath),
      readTextFile: (filePath: string) => base.readTextFile(filePath),
      readHead: (filePath: string, maxBytes: number) => base.readHead(filePath, maxBytes),
      realpath: (entryPath: string) => base.realpath(entryPath),
      join: (...parts: string[]) => base.join(...parts),
    };
    const ports = createProjectAgentProjectReadPorts({
      fs: orderShufflingFs,
      getProjectRoot: () => sandbox.root,
    });
    const tools = new ProjectAgentReadTools({
      ports: {
        overview: { getOverview: () => ({ name: 'Bounded', projectVersion: 1, scenes: [], assetRoots: {} }) },
        files: ports.files,
        text: ports.text,
        textSearch: ports.textSearch,
        resources: { searchResources: () => [] },
        resourceInspect: {
          inspectResource: (reference) => ({ exists: false, reference, scope: 'project', bindable: false }),
        },
        scene: { getSnapshot: () => ({ document: makeDocument(), version: 1 }) },
        validation: { validate: () => [] },
      },
      taskState: new ProjectAgentTaskState(),
    });

    state.reverseOrder = true;
    const first = await tools.listProjectFiles({ offset: 0, limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.hasMore).toBe(true);

    state.reverseOrder = false;
    const second = await tools.listProjectFiles({ offset: 2, limit: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      expect(second.error.code).not.toBe('pagination_changed');
    }
  });

  it('detects underlying revision changes between pages as pagination_changed', async () => {
    sandbox.write('files/a.txt', 'aaaa');
    sandbox.write('files/b.txt', 'bbbb');
    sandbox.write('files/c.txt', 'cccc');
    const { tools } = createTools(sandbox.root);

    const first = await tools.listProjectFiles({ offset: 0, limit: 2 });
    expect(first.ok).toBe(true);

    sandbox.write('files/b.txt', 'bbbb-longer-content');
    const changed = await tools.listProjectFiles({ offset: 2, limit: 2 });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error.code).toBe('pagination_changed');
      expect(changed.error.suggestedAction).toBe('retry_from_offset_zero');
    }

    const restart = await tools.listProjectFiles({ offset: 0, limit: 2 });
    expect(restart.ok).toBe(true);
  });

  it('detects search result revision changes between pages', async () => {
    sandbox.write('files/a.txt', 'alpha one\nalpha two\nalpha three');
    const { tools } = createTools(sandbox.root);
    const first = await tools.searchProjectText({ query: 'alpha', offset: 0, limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.hits).toHaveLength(2);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextOffset).toBe(2);

    sandbox.write('files/a.txt', 'alpha one\nbeta changed\nalpha three');
    const changed = await tools.searchProjectText({ query: 'alpha', offset: 2, limit: 2 });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe('pagination_changed');
  });

  it('returns result_too_large instead of truncating oversized content', async () => {
    const hugeLine = 'x'.repeat(250_000);
    sandbox.write('huge.txt', `${hugeLine}\n`);
    const { tools } = createTools(sandbox.root);

    const result = await tools.readProjectText({ path: 'huge.txt', lineCount: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('result_too_large');
  });

  it('rejects files with invalid UTF-8 beyond the head window as binary metadata-only', async () => {
    // BINARY_SNIFF_BYTES is 8192; the invalid bytes must live beyond it.
    const prefix = 'a'.repeat(9000);
    sandbox.write('broken.txt', Buffer.concat([Buffer.from(prefix, 'utf-8'), Buffer.from([0xff, 0xfe])]));
    const { tools } = createTools(sandbox.root);

    const result = await tools.readProjectText({ path: 'broken.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.binary).toBe(true);
    expect(result.data.lines).toEqual([]);
    expect(result.data.mimeType).toBe('text/plain');

    const searched = await tools.searchProjectText({ query: 'a' });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.data.hits.some((hit) => hit.path === 'broken.txt')).toBe(false);
    }
  });

  it('refuses files above the 16MB port cap as result_too_large', async () => {
    sandbox.write('oversize.bin', Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    const { tools } = createTools(sandbox.root);

    const result = await tools.readProjectText({ path: 'oversize.bin' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('result_too_large');

    const listed = await tools.listProjectFiles({ offset: 0, limit: 200 });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const entry = listed.data.entries.find((item) => item.path === 'oversize.bin');
      expect(entry?.sizeBytes).toBe(16 * 1024 * 1024 + 1);
    }
  });

  it('surfaces typed errors without stack traces, absolute paths or file contents', async () => {
    const { tools } = createTools(sandbox.root);
    const cases = [
      await tools.readProjectText({ path: 'scenes/main.scene.json' }),
      await tools.readProjectText({ path: '/etc/hostname' }),
      await tools.listProjectFiles({ offset: -1 }),
      await tools.readProjectText({ path: 'missing.txt' }),
    ];
    for (const result of cases) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).not.toContain(sandbox.root);
      expect(result.error.message).not.toMatch(/at (async |[A-Za-z]+\.)?[A-Za-z]+\s*\(|Error:/);
      expect(result.error.message).not.toContain('secret');
    }
  });

  it('fails closed when the IFileAccess host cannot provide realpath/stat', async () => {
    const hostWithoutCapability = {
      readAsset: async (relativePath: string) => ({ data: '', path: relativePath }),
      readFile: async (filePath: string) => ({ data: fs.readFileSync(filePath, 'utf-8'), path: filePath }),
      showOpenDialog: async () => null,
      showSaveDialog: async () => null,
      writeFile: async () => undefined,
      ensureDir: async () => undefined,
      copyFile: async () => undefined,
      readDir: async (dir: string) =>
        fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: dir,
        })),
      exists: async () => true,
      join: async (...parts: string[]) => path.join(...parts),
      dirname: async (filePath: string) => path.dirname(filePath),
      basename: async (filePath: string) => path.basename(filePath),
      extname: async (filePath: string) => path.extname(filePath),
    };
    const fsSeam = new ProjectAgentIFileAccessFs(hostWithoutCapability as never);
    const ports = createProjectAgentProjectReadPorts({
      fs: fsSeam,
      getProjectRoot: () => sandbox.root,
    });
    const tools = new ProjectAgentReadTools({
      ports: {
        overview: { getOverview: () => ({ name: 'Bounded', projectVersion: 1, scenes: [], assetRoots: {} }) },
        files: ports.files,
        text: ports.text,
        textSearch: ports.textSearch,
        resources: { searchResources: () => [] },
        resourceInspect: {
          inspectResource: (reference) => ({ exists: false, reference, scope: 'project', bindable: false }),
        },
        scene: { getSnapshot: () => ({ document: makeDocument(), version: 1 }) },
        validation: { validate: () => [] },
      },
      taskState: new ProjectAgentTaskState(),
    });

    const read = await tools.readProjectText({ path: 'readme.md' });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe('not_found');
      expect(read.error.message).not.toContain('# Project');
    }

    const listed = await tools.listProjectFiles({ offset: 0, limit: 200 });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data.entries).toHaveLength(0);
      expect(JSON.stringify(listed.data)).not.toContain('readme.md');
    }

    const searched = await tools.searchProjectText({ query: 'Project' });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.data.hits).toHaveLength(0);
    }
  });
});

describe('bounded project reads through the production service composition', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.write('readme.md', '# Bounded\n');
    sandbox.write('project.json', '{"projectId":"never-expose-me"}');
    sandbox.write('scenes/main.scene.json', '{"scene":"formal"}');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  async function runService(
    toolCalls: AiConversationResponse['message']['toolCalls'],
  ): Promise<{
    requests: AiConversationRequest[];
  }> {
    const tempJournal = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bounded-journal-'));
    try {
      const requests: AiConversationRequest[] = [];
      let round = 0;
      const conversationIpc: AiConversationIpc = {
        complete: async ({ request }) => {
          requests.push(request);
          round += 1;
          if (round === 1) {
            return {
              status: 'ok',
              response: {
                message: {
                  role: 'assistant',
                  content: [],
                  toolCalls: [...toolCalls],
                },
              },
            };
          }
          return {
            status: 'ok',
            response: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
                toolCalls: [],
              },
            },
          };
        },
        cancel: async () => 'alreadySettled',
      };
      const transport = createAiConversationElectronTransport({ conversation: conversationIpc } as never);

      const windowController: ProjectAgentWindowController = {
        openAgentWindow: () => undefined,
        sendToAgentWindow: () => undefined,
      };
      const main = new ProjectAgentTaskCoordinator({
        journalPort: new FileSystemProjectAgentJournalPort(tempJournal),
        lease: new InMemoryProjectAgentLeasePort(),
        window: windowController,
        now: () => 1000,
      });

      const document = makeDocument();
      const readPorts: ProjectAgentReadPorts = {
        overview: {
          getOverview: () => ({
            name: 'Bounded Project',
            projectVersion: 2,
            activeScene: { name: 'Main', relativePath: 'scenes/main.scene.json' },
            scenes: [{ name: 'Main', relativePath: 'scenes/main.scene.json' }],
            assetRoots: { figure: 'figure' },
          }),
        },
        files: createProjectAgentProjectReadPorts({
          fs: new ProjectAgentNodeProjectFs(),
          getProjectRoot: () => sandbox.root,
        }).files,
        text: createProjectAgentProjectReadPorts({
          fs: new ProjectAgentNodeProjectFs(),
          getProjectRoot: () => sandbox.root,
        }).text,
        textSearch: createProjectAgentProjectReadPorts({
          fs: new ProjectAgentNodeProjectFs(),
          getProjectRoot: () => sandbox.root,
        }).textSearch,
        resources: { searchResources: () => [] },
        resourceInspect: {
          inspectResource: (reference) => ({ exists: false, reference, scope: 'project', bindable: false }),
        },
        scene: { getSnapshot: () => ({ document, version: 1 }) },
        validation: { validate: () => [] },
      };
      const writePorts: ProjectAgentWritePorts = {
        scene: readPorts.scene,
        validation: readPorts.validation,
        authoring: { commit: () => ({ version: 2 }) },
      };

      const service = new ProjectAgentService({
        transport,
        host: main,
        readPorts,
        writePorts,
        systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' }),
        admission: { resolve: async () => ({ ok: true, endpoint: 'https://provider.test', model: 'agent-model' }) },
        resolveTargetIdentity: () => ({
          ok: true,
          projectId: 'bounded-project',
          sceneEntryId: SCENE_ENTRY_ID,
          sceneDocumentId: SCENE_DOCUMENT_ID,
          sceneName: 'Main',
        }),
        idFactory: () => 'bounded-task',
        now: () => 1000,
      } satisfies ProjectAgentServiceOptions);

      const started = await service.start({ taskText: 'Inspect the project' });
      expect(started.ok).toBe(true);
      await service.whenIdle();
      // Round semantics (ADR0023): the plain reply settled the execution
      // round; the Conversation is idle and ready for the next user message.
      expect(service.getTaskSnapshot()?.getLifecycle()).toBe('idle');
      return { requests };
    } finally {
      fs.rmSync(tempJournal, { recursive: true, force: true });
    }
  }

  it('delivers cleaned file listings and overviews to the model without local identities', async () => {
    const { requests } = await runService([
      { status: 'ready' as const, toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
      { status: 'ready' as const, toolCallId: 'c2', name: 'listProjectFiles', arguments: { limit: 100 } },
    ]);
    const toolMessages = requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool');
    const serialized = JSON.stringify(toolMessages);
    expect(serialized).not.toContain(sandbox.root);
    expect(serialized).not.toContain('never-expose-me');
    expect(serialized).not.toContain(SCENE_ENTRY_ID);
    expect(serialized).not.toContain(SCENE_DOCUMENT_ID);
    expect(serialized).toContain('Bounded Project');

    // The overview is allowed to expose scene display info (name + relative path).
    const overviewMessage = toolMessages.find((message) => message.name === 'readProjectOverview');
    expect(JSON.stringify(overviewMessage)).toContain('scenes/main.scene.json');

    // The generic file listing never exposes raw metadata or formal scene files.
    const listMessage = toolMessages.find((message) => message.name === 'listProjectFiles');
    expect(JSON.stringify(listMessage)).toContain('readme.md');
    expect(JSON.stringify(listMessage)).not.toContain('project.json');
    expect(JSON.stringify(listMessage)).not.toContain('scenes/main.scene.json');
  });
});
