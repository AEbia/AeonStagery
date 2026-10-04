import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectAgentReadPorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentReadTools } from '../services/project-agent/ProjectAgentReadTools';
import { ProjectAgentTaskState } from '../services/project-agent/ProjectAgentTaskState';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_agent',
    meta: {
      title: 'Agent Scene',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'cmp_a',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: '' },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 1,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
    ],
  };
}

function makeDialogueScene(lineCount: number, text = 'Line'): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_agent_many_lines',
    meta: {
      title: 'Large Agent Scene',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: Array.from({ length: lineCount }, (_, index) => ({
      id: `dlg_${index + 1}`,
      time: index,
      type: 'dialogue' as const,
      params: {
        speakerId: 'tomori',
        text,
        durationSeconds: 1,
      },
    })),
  };
}

function makeCustomMotionScene(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_agent_custom_motion',
    meta: {
      title: 'Custom Motion Scene',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 4,
        },
        companions: [
          {
            id: 'cmp_perf',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: {
                kind: 'custom',
                durationSeconds: 3.4,
                fadeInSeconds: 0.5,
                derivedFrom: { key: '点头_02.mtn' },
                tracks: [
                  {
                    parameterId: 'ParamAngleX',
                    fadeInSeconds: 0.4,
                    keyframes: [
                      { time: 0, value: 0 },
                      { time: 1, value: 12 },
                      { time: 2, value: 0 },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 1,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
    ],
  };
}

function makeDenseCustomMotionScene(keyframeCount: number): CurrentSceneDocument {
  const keyframes = Array.from({ length: keyframeCount }, (_, index) => ({
    time: index / 10,
    value: Math.sin(index),
  }));
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_agent_dense_motion',
    meta: {
      title: 'Dense Motion Scene',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 400,
        },
        companions: [
          {
            id: 'cmp_perf',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: {
                kind: 'custom',
                durationSeconds: 400,
                fadeInSeconds: 0.1,
                derivedFrom: { key: 'dense.mtn' },
                tracks: [{ parameterId: 'ParamAngleX', keyframes }],
              },
            },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 1,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
    ],
  };
}

function createPorts(overrides: Partial<ProjectAgentReadPorts> = {}): ProjectAgentReadPorts {
  let document = makeDocument();
  let version = 3;
  return {
    overview: {
      getOverview: () => ({
        name: 'Demo',
        projectVersion: 2,
        activeScene: { name: 'Main', relativePath: 'scenes/main.scene.json' },
        scenes: [
          { name: 'Main', relativePath: 'scenes/main.scene.json' },
          { name: 'Alt', relativePath: 'scenes/alt.scene.json' },
        ],
        assetRoots: { figure: 'figure', background: 'background' },
        templates: { enabledTemplateIds: ['aeonstagery.default'] },
      }),
    },
    files: {
      listFiles: () => [
        { path: 'readme.md', kind: 'file', sizeBytes: 12 },
        { path: 'project.json', kind: 'file', sizeBytes: 100 },
        { path: 'scenes/main.scene.json', kind: 'file', sizeBytes: 200 },
        { path: 'images/bg.png', kind: 'file', sizeBytes: 50, binary: true },
        { path: '.git/config', kind: 'file', sizeBytes: 10 },
        { path: 'notes/todo.txt', kind: 'file', sizeBytes: 5 },
      ],
    },
    text: {
      readText: (path) => {
        if (path === 'images/bg.png') {
          return { lines: [], binary: true, mimeType: 'image/png', sizeBytes: 50 };
        }
        return {
          lines: ['one', 'two', 'three', 'four'],
          binary: false,
          mimeType: 'text/plain',
          sizeBytes: 20,
        };
      },
    },
    textSearch: {
      searchText: () => [
        { path: 'notes/todo.txt', line: 1, text: 'todo item' },
        { path: 'project.json', line: 1, text: 'secret' },
      ],
    },
    resources: {
      searchResources: () => [
        {
          kind: 'background' as const,
          displayName: 'sky',
          scope: 'project' as const,
          reference: 'background/sky.png',
        },
        {
          kind: 'background' as const,
          displayName: 'template-sky',
          scope: 'template' as const,
          reference: 'should-not-leak',
          materializationRequired: true as const,
        },
        {
          kind: 'image' as const,
          displayName: 'mount-pic',
          scope: 'mount' as const,
          reference: '@mount/lib/images/pic.png',
        },
      ],
    },
    resourceInspect: {
      inspectResource: (reference) => ({
        exists: true,
        reference,
        scope: reference.startsWith('@mount/') ? 'mount' as const : 'project' as const,
        kind: 'image' as const,
        bindable: true,
        media: { mimeType: 'image/png', width: 64, height: 64 },
      }),
    },
    image: {
      readImage: ({ reference }) => ({
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        originalWidth: 64,
        originalHeight: 64,
        deliveredWidth: 64,
        deliveredHeight: 64,
        scaled: false,
        contentFingerprint: `fp:${reference}`,
      }),
    },
    scene: {
      getSnapshot: () => ({ document, version }),
    },
    validation: {
      validate: () => [],
    },
    ...overrides,
    // Allow tests to mutate snapshot
    __setDocument: (next: CurrentSceneDocument, nextVersion: number) => {
      document = next;
      version = nextVersion;
    },
  } as ProjectAgentReadPorts & { __setDocument: (d: CurrentSceneDocument, v: number) => void };
}

describe('ProjectAgentReadTools', () => {
  it('returns cleaned project overview without internal ids', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });
    const result = await tools.readProjectOverview();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe('Demo');
    expect(result.data.projectVersion).toBe(2);
    expect(result.data.activeScene?.relativePath).toBe('scenes/main.scene.json');
    expect(JSON.stringify(result.data)).not.toMatch(/projectId|defaultSceneId/);
  });

  it('forbids absolute paths, traversal, protected files, scenes, and VCS', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });

    for (const path of [
      '/etc/passwd',
      'C:/Windows',
      '../secret',
      'notes/../project.json',
      '@mount/x/project.json',
    ]) {
      const result = await tools.readProjectText({ path, startLine: 1, lineCount: 10 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(['forbidden_path', 'invalid_arguments']).toContain(result.error.code);
    }

    const projectJson = await tools.readProjectText({ path: 'project.json' });
    expect(projectJson.ok).toBe(false);
    if (!projectJson.ok) expect(projectJson.error.code).toBe('forbidden_path');

    const scene = await tools.readProjectText({ path: 'scenes/main.scene.json' });
    expect(scene.ok).toBe(false);
    if (!scene.ok) expect(scene.error.code).toBe('forbidden_path');

    const listed = await tools.listProjectFiles({ offset: 0, limit: 50 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const paths = listed.data.entries.map((entry) => entry.path);
    expect(paths).not.toContain('project.json');
    expect(paths).not.toContain('scenes/main.scene.json');
    expect(paths).not.toContain('.git/config');
    expect(paths).toContain('notes/todo.txt');
  });

  it('passes stable mount text references to the bounded text port', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });

    const result = await tools.readProjectText({
      path: '@mount/lib/docs/library-guide.txt',
      startLine: 2,
      lineCount: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.path).toBe('@mount/lib/docs/library-guide.txt');
    expect(result.data.lines).toEqual(['two']);
  });

  it('normalizes resource browse prefixes and rejects absolute or traversal input', async () => {
    let receivedPrefix: string | undefined;
    const ports = createPorts({
      resources: {
        searchResources: ({ pathPrefix }) => {
          receivedPrefix = pathPrefix;
          return [];
        },
      },
    });
    const tools = new ProjectAgentReadTools({ ports, taskState: new ProjectAgentTaskState() });

    const normalized = await tools.searchResources({ namespace: 'mount:lib', pathPrefix: '背景\\商店' });
    expect(normalized.ok).toBe(true);
    expect(receivedPrefix).toBe('背景/商店');

    for (const pathPrefix of ['/etc', 'C:/Windows', '../outside', '@mount/lib/root']) {
      const result = await tools.searchResources({ namespace: 'mount:lib', pathPrefix });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('forbidden_path');
    }
  });

  it('returns binary metadata only for binary files', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });
    const result = await tools.readProjectText({ path: 'images/bg.png' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.binary).toBe(true);
    expect(result.data.lines).toEqual([]);
    expect(result.data.mimeType).toBe('image/png');
  });

  it('paginates list results and reports pagination_changed on revision shift', async () => {
    let files = [
      { path: 'a.txt', kind: 'file' as const, sizeBytes: 1 },
      { path: 'b.txt', kind: 'file' as const, sizeBytes: 1 },
      { path: 'c.txt', kind: 'file' as const, sizeBytes: 1 },
    ];
    const ports = createPorts({
      files: { listFiles: () => files },
    });
    const tools = new ProjectAgentReadTools({ ports, taskState: new ProjectAgentTaskState() });

    const first = await tools.listProjectFiles({ offset: 0, limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.entries).toHaveLength(2);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextOffset).toBe(2);

    files = [
      { path: 'a.txt', kind: 'file', sizeBytes: 1 },
      { path: 'b.txt', kind: 'file', sizeBytes: 1 },
      { path: 'z.txt', kind: 'file', sizeBytes: 1 },
    ];
    const changed = await tools.listProjectFiles({ offset: 2, limit: 2 });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error.code).toBe('pagination_changed');
      expect(changed.error.suggestedAction).toBe('retry_from_offset_zero');
    }

    const restart = await tools.listProjectFiles({ offset: 0, limit: 2 });
    expect(restart.ok).toBe(true);
  });

  it('strips fake references from template resource candidates', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });
    const result = await tools.searchResources({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const template = result.data.entries.find((c) => c.scope === 'template');
    expect(template?.materializationRequired).toBe(true);
    expect(template?.reference).toBeUndefined();
    const mount = result.data.entries.find((c) => c.scope === 'mount');
    expect(mount?.reference).toBe('@mount/lib/images/pic.png');
  });

  it('binds scene snapshot on readScene and returns line view + version', async () => {
    const taskState = new ProjectAgentTaskState();
    const tools = new ProjectAgentReadTools({ ports: createPorts(), taskState });
    const result = await tools.readScene({ startLine: 1, lineCount: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('version' in result.data).toBe(false);
    expect(result.data.totalLines).toBeGreaterThan(0);
    expect(result.data.lines[0]?.kind).toBe('statement');
    expect(result.data.characters[0]?.id).toBe('tomori');
    expect(taskState.hasSceneRead()).toBe(true);
    expect(taskState.getSceneBinding()?.version).toBe(3);
  });

  it('returns a normal 346-line scene in one default broad read', async () => {
    const taskState = new ProjectAgentTaskState();
    const document = makeDialogueScene(346);
    const tools = new ProjectAgentReadTools({
      ports: createPorts({ scene: { getSnapshot: () => ({ document, version: 4 }) } }),
      taskState,
    });

    const result = await tools.readScene();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalLines).toBe(346);
    expect(result.data.lines).toHaveLength(346);
    expect(result.data.endLine).toBe(346);
    expect(result.data.hasMore).toBe(false);
    expect(result.data.truncated).toBe(false);
    expect(taskState.getSceneBinding()?.version).toBe(4);
  });

  it('caps scene reads at 500 lines and supplies a continuation', async () => {
    const document = makeDialogueScene(501);
    const tools = new ProjectAgentReadTools({
      ports: createPorts({ scene: { getSnapshot: () => ({ document, version: 4 }) } }),
      taskState: new ProjectAgentTaskState(),
    });

    const result = await tools.readScene({ startLine: 1, lineCount: 501 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines).toHaveLength(500);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextStartLine).toBe(501);
    expect(result.data.truncated).toBe(true);
  });

  it('continues a scene read when the serialized page reaches the byte cap', async () => {
    const document = makeDialogueScene(2, 'x'.repeat(140_000));
    const tools = new ProjectAgentReadTools({
      ports: createPorts({ scene: { getSnapshot: () => ({ document, version: 4 }) } }),
      taskState: new ProjectAgentTaskState(),
    });

    const result = await tools.readScene({ startLine: 1, lineCount: 500 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines).toHaveLength(1);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextStartLine).toBe(2);
    expect(result.data.truncated).toBe(true);
  });

  it('rejects an oversized first scene line without binding a writable snapshot', async () => {
    const taskState = new ProjectAgentTaskState();
    const document = makeDialogueScene(1, 'x'.repeat(210_000));
    const tools = new ProjectAgentReadTools({
      ports: createPorts({ scene: { getSnapshot: () => ({ document, version: 4 }) } }),
      taskState,
    });

    const result = await tools.readScene({ startLine: 1, lineCount: 500 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('result_too_large');
    expect(taskState.hasSceneRead()).toBe(false);
  });

  it('compacts custom-motion keyframes to keyframeCount in readScene results', async () => {
    const taskState = new ProjectAgentTaskState();
    const document = makeCustomMotionScene();
    const tools = new ProjectAgentReadTools({
      ports: createPorts({ scene: { getSnapshot: () => ({ document, version: 4 }) } }),
      taskState,
    });

    const result = await tools.readScene({ startLine: 1, lineCount: 500 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.data.lines);
    expect(json).not.toContain('keyframes');
    const perf = result.data.lines.find((line) => line.type === 'characterPerformance')!;
    const motion = (perf.params as { motion: Record<string, unknown> }).motion;
    expect(motion).toMatchObject({
      kind: 'custom',
      durationSeconds: 3.4,
      tracks: [{ parameterId: 'ParamAngleX', keyframeCount: 3 }],
    });
  });

  it('reads a scene whose custom motion has a keyframe payload beyond the page cap', async () => {
    const taskState = new ProjectAgentTaskState();
    const document = makeDenseCustomMotionScene(4000);
    const tools = new ProjectAgentReadTools({
      ports: createPorts({ scene: { getSnapshot: () => ({ document, version: 4 }) } }),
      taskState,
    });

    const result = await tools.readScene({ startLine: 1, lineCount: 500 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lines).toHaveLength(3);
    const perf = result.data.lines.find((line) => line.type === 'characterPerformance')!;
    const motion = (perf.params as { motion: Record<string, unknown> }).motion;
    expect(motion).toMatchObject({ kind: 'custom', tracks: [{ keyframeCount: 4000 }] });
  });

  it('returns vision_unavailable when image capability is off', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
      imageAvailable: false,
    });
    const result = await tools.readImage({ reference: 'images/bg.png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('vision_unavailable');
  });

  it('rejects network URLs, data URIs and scheme-style base64 input', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
      imageAvailable: true,
    });
    for (const reference of [
      'https://evil.example/x.png',
      'http://evil.example/x.png',
      'data:image/png;base64,AAAA',
      'base64:iVBORw0KGgo=',
      'ftp://files.example/x.png',
    ]) {
      const result = await tools.readImage({ reference });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['forbidden_path', 'invalid_arguments']).toContain(result.error.code);
      }
    }
  });

  it('reads images when capability is enabled', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
      imageAvailable: true,
    });
    const result = await tools.readImage({ reference: 'images/bg.png' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mimeType).toBe('image/png');
    expect(result.data.imagePayload.mimeType).toBe('image/png');
    // Image bytes never enter the tool result (journal/descriptor contract).
    expect('bytes' in result.data).toBe(false);
  });

  it('keeps image bytes in the session cache only, not in the tool result', async () => {
    const imageCache = new ProjectAgentImageSessionCache();
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
      imageAvailable: true,
      imageCache,
    });
    const result = await tools.readImage({ reference: 'images/bg.png', detail: 'low' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.detail).toBe('low');
    const cached = imageCache.get('images/bg.png', result.data.contentFingerprint, 'low');
    expect(cached).not.toBeNull();
    expect(cached?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(JSON.stringify(result.data)).not.toContain('bytes');
  });

  it('searches scene lines by family and text', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });
    const result = await tools.searchScene({ family: 'dialogue', text: 'hello' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits.length).toBeGreaterThan(0);
    expect(result.data.hits[0]?.line.type).toBe('dialogue');
  });

  it('distinguishes missing forbidden paths (not_found) from existing forbidden paths', async () => {
    const ports = createPorts({
      text: {
        readText: () => ({ lines: [], binary: false }),
        exists: (path) => Promise.resolve(path !== 'scenes/missing.json'),
      },
    });
    const tools = new ProjectAgentReadTools({ ports, taskState: new ProjectAgentTaskState() });

    const missing = await tools.readProjectText({ path: 'scenes/missing.json' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('not_found');
      expect(missing.error.suggestedAction).toBeUndefined();
    }

    const existing = await tools.readProjectText({ path: 'scenes/main.scene.json' });
    expect(existing.ok).toBe(false);
    if (!existing.ok) {
      expect(existing.error.code).toBe('forbidden_path');
      expect(existing.error.suggestedAction).toBeUndefined();
    }
  });

  it('applies the existence probe to forbidden inspectResource and readImage references', async () => {
    const ports = createPorts({
      resourceInspect: {
        inspectResource: () => ({
          exists: true,
          reference: 'x',
          scope: 'project',
          kind: 'image',
          bindable: true,
        }),
        exists: (reference) => Promise.resolve(reference !== 'scenes/missing.json'),
      },
      image: {
        readImage: ({ reference }) => ({
          mimeType: 'image/png',
          bytes: new Uint8Array([1]),
          originalWidth: 1,
          originalHeight: 1,
          deliveredWidth: 1,
          deliveredHeight: 1,
          scaled: false,
          contentFingerprint: `fp:${reference}`,
        }),
        exists: (reference) => Promise.resolve(reference !== 'scenes/missing.png'),
      },
    });
    const tools = new ProjectAgentReadTools({
      ports,
      taskState: new ProjectAgentTaskState(),
      imageAvailable: true,
    });

    const missingInspect = await tools.inspectResource({ reference: 'scenes/missing.json' });
    expect(missingInspect.ok).toBe(false);
    if (!missingInspect.ok) {
      expect(missingInspect.error.code).toBe('not_found');
      expect(missingInspect.error.suggestedAction).toBeUndefined();
    }

    const missingImage = await tools.readImage({ reference: 'scenes/missing.png' });
    expect(missingImage.ok).toBe(false);
    if (!missingImage.ok) {
      expect(missingImage.error.code).toBe('not_found');
      expect(missingImage.error.suggestedAction).toBeUndefined();
    }

    const existingInspect = await tools.inspectResource({ reference: 'scenes/main.scene.json' });
    expect(existingInspect.ok).toBe(false);
    if (!existingInspect.ok) {
      expect(existingInspect.error.code).toBe('forbidden_path');
      expect(existingInspect.error.suggestedAction).toBeUndefined();
    }

    const existingImage = await tools.readImage({ reference: 'scenes/main.scene.json' });
    expect(existingImage.ok).toBe(false);
    if (!existingImage.ok) {
      expect(existingImage.error.code).toBe('forbidden_path');
      expect(existingImage.error.suggestedAction).toBeUndefined();
    }
  });

  it('returns resource search results under the uniform entries key with an always-present nextOffset', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });
    const result = await tools.searchResources({ offset: 0, limit: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data.entries)).toBe(true);
    expect(result.data.entries.length).toBeGreaterThan(0);
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextOffset).toBe(100);
    expect(result.data.total).toBe(result.data.entries.length);
  });

  it('always returns nextOffset/nextStartLine on the last page of every paginated tool', async () => {
    const tools = new ProjectAgentReadTools({
      ports: createPorts(),
      taskState: new ProjectAgentTaskState(),
    });

    const text = await tools.readProjectText({ path: 'notes/todo.txt' });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.data.hasMore).toBe(false);
    expect(text.data.nextStartLine).toBe(5);

    const search = await tools.searchProjectText({ query: 'todo', offset: 0, limit: 100 });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.data.hasMore).toBe(false);
    expect(search.data.nextOffset).toBe(100);

    const scene = await tools.readScene({ startLine: 1, lineCount: 500 });
    expect(scene.ok).toBe(true);
    if (!scene.ok) return;
    expect(scene.data.hasMore).toBe(false);
    expect(scene.data.nextStartLine).toBe(scene.data.totalLines + 1);

    const sceneSearch = await tools.searchScene({ offset: 0, limit: 100 });
    expect(sceneSearch.ok).toBe(true);
    if (!sceneSearch.ok) return;
    expect(sceneSearch.data.hasMore).toBe(false);
    expect(sceneSearch.data.nextOffset).toBe(100);
  });
});
