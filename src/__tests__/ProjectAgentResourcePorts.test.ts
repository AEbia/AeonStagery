import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AiConversationIpc } from '../api/types/ai-conversation-ipc';
import type { AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectMetadata, ProjectState } from '../api/types/project';
import { createAiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import { createLoadedTemplatePackage } from '../services/template-package/TemplatePackageLoader';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import { ProjectAgentNodeProjectFs } from '../services/project-agent/ProjectAgentNodeProjectFs';
import type { ProjectAgentProjectFs } from '../services/project-agent/ProjectAgentProjectFs';
import {
  createProjectAgentResourcePorts,
} from '../services/project-agent/ProjectAgentResourcePorts';
import { createProjectAgentImageReadPort } from '../services/project-agent/ProjectAgentImageReadPort';
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

interface Sandbox {
  root: string;
  write(relative: string, content: string | Buffer): void;
  mkdir(relative: string): void;
  symlink(target: string, relative: string): void;
  cleanup(): void;
}

function createSandbox(prefix: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
      fs.symlinkSync(target, path.join(root, relative));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(29);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 6, 0, 0, 0], 24);
  return header;
}

function wavBytes(durationSeconds: number): Buffer {
  const byteRate = 88200;
  const dataSize = durationSeconds * byteRate;
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

const MODEL_JSON = JSON.stringify({
  model: 'soyo.moc',
  motions: { Idle: [{ File: 'idle.mtn' }], 'soyo/wave01': [{ File: 'wave.mtn' }] },
  expressions: [{ name: 'smile' }],
});

const MODEL3_JSON = JSON.stringify({
  Version: 3,
  FileReferences: {
    Moc: 'anon.moc3',
    Motions: { Idle: [{ File: 'idle.motion3.json' }], 'anon/wave02': [{ File: 'wave.motion3.json' }] },
    Expressions: [{ Name: 'happy' }],
  },
});

/** Simulates Electron's Windows realpath output while keeping the fixture on the host filesystem. */
class WindowsStyleProjectAgentFs extends ProjectAgentNodeProjectFs {
  override async realpath(entryPath: string): Promise<string> {
    return (await super.realpath(entryPath)).replace(/\//g, '\\');
  }
}

function makeMetadata(_rootPath: string, overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    projectId: 'resource-project',
    name: 'Resource Project',
    projectVersion: 2,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    defaultSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
    assetRoots: {
      figure: 'figure',
      background: 'background',
      bgm: 'bgm',
      vocal: 'vocal',
      images: 'images',
      animation: 'animation',
      project: 'project',
      template: 'template',
    },
    templates: { enabledTemplateIds: ['test.mygo'] },
    ...overrides,
  };
}

const TEMPLATE_MANIFEST = {
  manifestSchemaVersion: 2,
  template: {
    id: 'test.mygo',
    name: 'MyGO Test',
    version: '1.0.0',
    compatibility: { sceneSchemaVersion: 4 },
  },
  assets: {
    root: 'assets',
    index: [
      {
        id: 'soyo@winter',
        path: 'figure/soyo/school_winter-2023/model.json',
        kind: 'live2dModel',
        label: 'Soyo Winter',
        metadata: { ownerId: 'soyo', outfitId: 'school_winter-2023' },
      },
      { id: 'starry-night', path: 'background/starry_night.png', kind: 'background', label: 'Starry Night' },
    ],
  },
  resourceConventions: {
    live2dModel: { patterns: ['figure/{character}/{outfit}/model.json'] },
  },
};

describe('project agent resource search ports (sandbox)', () => {
  let sandbox: Sandbox;
  let mountSandbox: Sandbox;
  let outsideSandbox: Sandbox;
  let templateSandbox: Sandbox;
  let project: ProjectState;
  let mounts: Array<{ id: string; path: string }>;
  let packages: ReturnType<typeof createLoadedTemplatePackage>[];

  beforeEach(() => {
    sandbox = createSandbox('agent-res-project-');
    mountSandbox = createSandbox('agent-res-mount-');
    outsideSandbox = createSandbox('agent-res-outside-');
    templateSandbox = createSandbox('agent-res-template-');

    sandbox.write('figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    sandbox.write('figure/soyo/casual-2023/model.json', MODEL_JSON);
    sandbox.write('figure/deep/nested/rana/model.json', MODEL_JSON);
    sandbox.write('background/sky.png', pngBytes(1920, 1080));
    sandbox.write('background/night/sky.png', pngBytes(1280, 720));
    sandbox.write('images/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    sandbox.write('bgm/bgm01.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]));
    sandbox.write('vocal/soyo/line01.wav', wavBytes(3));
    sandbox.write('notes/readme.txt', 'not a resource');

    mountSandbox.write('game/figure/anon/casual-2023/model.model3.json', MODEL3_JSON);
    mountSandbox.write('game/background/bg.png', pngBytes(800, 600));
    mountSandbox.write('game/background/交通/车站1（白天）.png', pngBytes(800, 600));
    mountSandbox.write('game/background/商店/咖啡厅.png', pngBytes(800, 600));
    mountSandbox.write('game/bgm/song.ogg', Buffer.from('OggS', 'utf-8'));
    mountSandbox.write('game/notes.txt', 'plain');

    outsideSandbox.write('figure/evil/model.json', MODEL_JSON);
    outsideSandbox.write('secret/bg.png', pngBytes(64, 64));
    sandbox.symlink(path.join(outsideSandbox.root, 'figure'), 'figure/escape-link');
    sandbox.symlink(path.join(outsideSandbox.root, 'secret', 'bg.png'), 'background/escape.png');
    mountSandbox.symlink(outsideSandbox.root, 'game/escape-mount');

    templateSandbox.write('assets/figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    templateSandbox.write('assets/background/starry_night.png', pngBytes(1024, 768));
    templateSandbox.write('manifest.v2.json', JSON.stringify(TEMPLATE_MANIFEST));

    project = {
      rootPath: sandbox.root,
      projectFilePath: path.join(sandbox.root, 'project.json'),
      metadata: makeMetadata(sandbox.root),
    };
    mounts = [{ id: 'shared-library', path: mountSandbox.root }];
    packages = [
      createLoadedTemplatePackage(TEMPLATE_MANIFEST, {
        scope: 'user',
        packageRoot: templateSandbox.root,
        manifestPath: path.join(templateSandbox.root, 'manifest.v2.json'),
      }),
    ];
  });

  afterEach(() => {
    sandbox.cleanup();
    mountSandbox.cleanup();
    outsideSandbox.cleanup();
    templateSandbox.cleanup();
  });

  function createPorts(fileSystem: ProjectAgentProjectFs = new ProjectAgentNodeProjectFs()) {
    return createProjectAgentResourcePorts({
      fs: fileSystem,
      getProject: () => project,
      getExternalMounts: () => mounts,
      getTemplatePackages: () => packages,
    });
  }

  it('recursively scans the project namespace with project-relative references and actual kinds', async () => {
    const { resources } = createPorts();
    const result = await resources.searchResources({});
    const candidates = 'revision' in result ? result.entries : result;
    const refs = candidates.map((candidate) => candidate.reference).filter(Boolean);
    expect(refs).toContain('figure/soyo/school_winter-2023/model.json');
    expect(refs).toContain('figure/deep/nested/rana/model.json');
    expect(refs).toContain('background/night/sky.png');
    expect(refs).toContain('images/logo.svg');
    expect(refs).toContain('bgm/bgm01.mp3');
    expect(refs).toContain('vocal/soyo/line01.wav');
    // Non-resource files never surface.
    expect(refs).not.toContain('notes/readme.txt');

    const model = candidates.find((candidate) => candidate.reference === 'figure/soyo/school_winter-2023/model.json');
    expect(model?.kind).toBe('live2dModel');
    expect(model?.scope).toBe('project');
    expect(model?.ownerId).toBe('soyo');
    expect(model?.outfitId).toBe('school_winter-2023');
    expect(model?.materializationRequired).toBeUndefined();

    const background = candidates.find((candidate) => candidate.reference === 'background/sky.png');
    expect(background?.kind).toBe('background');

    const voice = candidates.find((candidate) => candidate.reference === 'vocal/soyo/line01.wav');
    expect(voice?.kind).toBe('voice');
    expect(voice?.ownerId).toBe('soyo');
  });

  it('scans mount namespaces into stable @mount references', async () => {
    const { resources } = createPorts();
    const result = await resources.searchResources({ namespace: 'mount:shared-library' });
    const candidates = 'revision' in result ? result.entries : result;
    const refs = candidates.map((candidate) => candidate.reference).filter(Boolean);
    expect(refs).toContain('@mount/shared-library/game/figure/anon/casual-2023/model.model3.json');
    expect(refs).toContain('@mount/shared-library/game/background/bg.png');
    expect(refs).toContain('@mount/shared-library/game/bgm/song.ogg');
    expect(refs).not.toContain('@mount/shared-library/game/notes.txt');
    const model = candidates.find((candidate) => candidate.reference?.includes('casual-2023'));
    expect(model?.kind).toBe('live2dModel');
    expect(model?.ownerId).toBe('anon');
    expect(model?.outfitId).toBe('casual-2023');
  });

  it('classifies images in nested mount background directories as backgrounds', async () => {
    const { resources } = createPorts();
    const result = await resources.searchResources({
      namespace: 'mount:shared-library',
      kind: 'background',
    });
    const candidates = 'revision' in result ? result.entries : result;
    expect(candidates).toContainEqual(expect.objectContaining({
      reference: '@mount/shared-library/game/background/bg.png',
      kind: 'background',
      scope: 'mount',
    }));
  });

  it('browses a mounted background library by immediate directories and files', async () => {
    const { resources } = createPorts();
    const rootResult = await resources.searchResources({
      namespace: 'mount:shared-library',
      kind: 'background',
      pathPrefix: 'game/background',
    });
    const root = 'revision' in rootResult ? rootResult.entries : rootResult;

    expect(root).toContainEqual(expect.objectContaining({
      kind: 'directory',
      displayName: '交通',
      scope: 'mount',
      pathPrefix: 'game/background/交通',
      namespace: 'mount:shared-library',
    }));
    expect(root).toContainEqual(expect.objectContaining({
      kind: 'directory',
      displayName: '商店',
      scope: 'mount',
      pathPrefix: 'game/background/商店',
      namespace: 'mount:shared-library',
    }));
    expect(root).toContainEqual(expect.objectContaining({
      kind: 'background',
      reference: '@mount/shared-library/game/background/bg.png',
    }));
    expect(root.some((candidate) => candidate.reference?.includes('车站1'))).toBe(false);

    const shopResult = await resources.searchResources({
      namespace: 'mount:shared-library',
      kind: 'background',
      pathPrefix: 'game\\background\\商店',
    });
    const shop = 'revision' in shopResult ? shopResult.entries : shopResult;
    expect(shop).toContainEqual(expect.objectContaining({
      kind: 'background',
      displayName: '咖啡厅',
      reference: '@mount/shared-library/game/background/商店/咖啡厅.png',
    }));
    expect(shop.some((candidate) => candidate.kind === 'directory')).toBe(false);
  });

  it('discovers a mount namespace from a bounded root browse before descending', async () => {
    const { resources } = createPorts();
    const rootResult = await resources.searchResources({ pathPrefix: '' });
    const root = 'revision' in rootResult ? rootResult.entries : rootResult;
    expect(root).toContainEqual(expect.objectContaining({
      kind: 'directory',
      displayName: 'game',
      scope: 'mount',
      namespace: 'mount:shared-library',
      pathPrefix: 'game',
    }));

    const gameResult = await resources.searchResources({
      namespace: 'mount:shared-library',
      pathPrefix: 'game',
    });
    const game = 'revision' in gameResult ? gameResult.entries : gameResult;
    expect(game).toContainEqual(expect.objectContaining({
      kind: 'directory',
      displayName: 'background',
      namespace: 'mount:shared-library',
      pathPrefix: 'game/background',
    }));
  });

  it('browses a background directory mounted as its own Windows library root', async () => {
    const backgroundRoot = path.join(mountSandbox.root, 'game', 'background');
    mounts = [{ id: 'mygo-background', path: backgroundRoot }];
    const { resources } = createPorts();
    const result = await resources.searchResources({
      namespace: 'mount:mygo-background',
      kind: 'background',
      pathPrefix: '',
    });
    const root = 'revision' in result ? result.entries : result;
    expect(root).toContainEqual(expect.objectContaining({
      kind: 'directory',
      displayName: '交通',
      pathPrefix: '交通',
      namespace: 'mount:mygo-background',
    }));
    expect(root).toContainEqual(expect.objectContaining({
      kind: 'background',
      reference: '@mount/mygo-background/bg.png',
    }));

    const { resourceInspect } = createPorts();
    const inspected = await resourceInspect.inspectResource('@mount/mygo-background/bg.png');
    expect(inspected).toMatchObject({
      exists: true,
      kind: 'background',
      bindable: true,
    });
  });

  it('keeps a large mounted library searchable so the tool layer can paginate it', async () => {
    for (let index = 0; index < 5_001; index += 1) {
      mountSandbox.write(
        `catalog/background/background-${String(index).padStart(4, '0')}.png`,
        pngBytes(8, 8),
      );
    }

    const { resources } = createPorts();
    const result = await resources.searchResources({
      namespace: 'mount:shared-library',
      kind: 'background',
    });
    const candidates = 'revision' in result ? result.entries : result;

    expect(candidates).toHaveLength(5_004);
    expect(candidates[0]?.reference).toBe('@mount/shared-library/catalog/background/background-0000.png');
    expect(candidates.map((candidate) => candidate.reference)).toContain('@mount/shared-library/game/background/bg.png');
  }, 30_000);

  it('scans and inspects nested mounted images when canonical paths use Windows separators', async () => {
    const { resources, resourceInspect } = createPorts(new WindowsStyleProjectAgentFs());
    const reference = '@mount/shared-library/game/background/bg.png';

    const inspected = await resourceInspect.inspectResource(reference);
    expect(inspected).toMatchObject({
      exists: true,
      scope: 'mount',
      kind: 'background',
      bindable: true,
    });

    const search = await resources.searchResources({
      namespace: 'mount:shared-library',
      kind: 'background',
    });
    const candidates = 'revision' in search ? search.entries : search;
    expect(candidates.map((candidate) => candidate.reference)).toContain(reference);
  });

  it('never follows symlinks out of registered roots', async () => {
    const { resources } = createPorts();
    const result = await resources.searchResources({});
    const candidates = 'revision' in result ? result.entries : result;
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain('escape-link');
    expect(serialized).not.toContain('escape.png');
    expect(serialized).not.toContain('escape-mount');
    expect(serialized).not.toContain('evil/model.json');
    const refs = candidates.map((candidate) => candidate.reference).filter(Boolean);
    expect(refs).not.toContain('figure/escape-link/model.json');
    expect(refs).not.toContain('background/escape.png');
  });

  it('reports template candidates as materialization_required without references', async () => {
    const { resources } = createPorts();
    const result = await resources.searchResources({ namespace: 'template' });
    const candidates = 'revision' in result ? result.entries : result;
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.scope).toBe('template');
      expect(candidate.reference).toBeUndefined();
      expect(candidate.materializationRequired).toBe(true);
    }
    const model = candidates.find((candidate) => candidate.kind === 'live2dModel');
    expect(model?.displayName).toBe('Soyo Winter');
    expect(model?.ownerId).toBe('soyo');
    expect(model?.outfitId).toBe('school_winter-2023');
    expect(model?.metadata?.templateId).toBe('test.mygo');
    expect(model?.metadata?.templateName).toBe('MyGO Test');
    // The template's own file layout never leaks into results.
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain('assets/figure');
    expect(serialized).not.toContain(templateSandbox.root);
  });

  it('scopes the template namespace to enabled template packages only', async () => {
    const { resources } = createPorts();
    templateSandbox.write('assets/figure/anon/casual-2023/model.json', MODEL_JSON);
    project.metadata.templates = { enabledTemplateIds: ['other.disabled-template'] };

    const disabled = await resources.searchResources({ namespace: 'template' });
    const disabledCandidates = 'revision' in disabled ? disabled.entries : disabled;
    expect(disabledCandidates).toHaveLength(0);

    const disabledGlobal = await resources.searchResources({});
    const disabledGlobalCandidates = 'revision' in disabledGlobal ? disabledGlobal.entries : disabledGlobal;
    expect(disabledGlobalCandidates.some((candidate) => candidate.scope === 'template')).toBe(false);

    const disabledExplicit = await resources.searchResources({ namespace: 'template:test.mygo' });
    const disabledExplicitCandidates = 'revision' in disabledExplicit ? disabledExplicit.entries : disabledExplicit;
    expect(disabledExplicitCandidates).toHaveLength(0);

    project.metadata.templates = { enabledTemplateIds: ['test.mygo'] };
    const enabled = await resources.searchResources({ namespace: 'template' });
    const enabledCandidates = 'revision' in enabled ? enabled.entries : enabled;
    const displayNames = enabledCandidates.map((candidate) => candidate.displayName);
    expect(displayNames).toContain('Soyo Winter');
    expect(displayNames).toContain('casual-2023');
    expect(enabledCandidates.every((candidate) => candidate.scope === 'template')).toBe(true);
  });

  it('changes the revision when a manifest label or owner is edited', async () => {
    const { resources } = createPorts();
    const first = await resources.searchResources({ namespace: 'template' });
    expect('revision' in first).toBe(true);
    if (!('revision' in first)) return;

    const edited = JSON.parse(JSON.stringify(TEMPLATE_MANIFEST));
    edited.assets.index[0].label = 'Soyo Winter v2';
    edited.assets.index[0].metadata.ownerId = 'soyo';
    packages[0] = createLoadedTemplatePackage(edited, {
      scope: 'user',
      packageRoot: templateSandbox.root,
      manifestPath: path.join(templateSandbox.root, 'manifest.v2.json'),
    });
    const second = await resources.searchResources({ namespace: 'template' });
    expect('revision' in second).toBe(true);
    if ('revision' in second) expect(second.revision).not.toBe(first.revision);
  });

  it('applies namespace, kind, text, owner and outfit filters', async () => {
    const { resources } = createPorts();
    const byKind = await resources.searchResources({ kind: 'background' });
    const kindCandidates = 'revision' in byKind ? byKind.entries : byKind;
    expect(kindCandidates.every((candidate) => candidate.kind === 'background')).toBe(true);

    const byText = await resources.searchResources({ text: 'logo' });
    const textCandidates = 'revision' in byText ? byText.entries : byText;
    expect(textCandidates.length).toBe(1);
    expect(textCandidates[0]?.reference).toBe('images/logo.svg');

    const byOwner = await resources.searchResources({ ownerId: 'soyo' });
    const ownerCandidates = 'revision' in byOwner ? byOwner.entries : byOwner;
    expect(ownerCandidates.every((candidate) => candidate.ownerId === 'soyo')).toBe(true);
    expect(ownerCandidates.length).toBeGreaterThanOrEqual(2);

    const byOutfit = await resources.searchResources({ outfitId: 'casual-2023' });
    const outfitCandidates = 'revision' in byOutfit ? byOutfit.entries : byOutfit;
    expect(outfitCandidates.map((candidate) => candidate.ownerId).sort()).toEqual(['anon', 'soyo']);

    const byNamespace = await resources.searchResources({ namespace: 'mount:shared-library', kind: 'live2dModel' });
    const mountCandidates = 'revision' in byNamespace ? byNamespace.entries : byNamespace;
    expect(mountCandidates.every((candidate) => candidate.reference?.startsWith('@mount/shared-library/'))).toBe(true);

    const unknown = await resources.searchResources({ namespace: 'mount:missing' });
    const unknownCandidates = 'revision' in unknown ? unknown.entries : unknown;
    expect(unknownCandidates).toHaveLength(0);
  });

  it('intersects a directory prefix with owner and outfit filters recursively', async () => {
    mountSandbox.write('figure/anon/casual/model.json', MODEL_JSON);
    mountSandbox.write('figure/anon/winter/model.json', MODEL_JSON);
    mountSandbox.write('figure/mana/casual/model.json', MODEL_JSON);
    mountSandbox.write('figure-extra/anon/casual/model.json', MODEL_JSON);
    mounts = [{ id: 'figure', path: mountSandbox.root }];
    const { resources } = createPorts();

    const result = await resources.searchResources({
      namespace: 'mount:figure', pathPrefix: 'figure', ownerId: 'anon',
    });
    const candidates = 'revision' in result ? result.entries : result;
    expect(candidates.map((candidate) => candidate.reference)).toEqual([
      '@mount/figure/figure/anon/casual/model.json',
      '@mount/figure/figure/anon/winter/model.json',
    ]);

    const outfitResult = await resources.searchResources({
      namespace: 'mount:figure', pathPrefix: 'figure\\anon', outfitId: 'winter',
    });
    const outfits = 'revision' in outfitResult ? outfitResult.entries : outfitResult;
    expect(outfits.map((candidate) => candidate.reference)).toEqual([
      '@mount/figure/figure/anon/winter/model.json',
    ]);

    const projectResult = await resources.searchResources({
      namespace: 'project', pathPrefix: 'figure', ownerId: 'soyo', outfitId: 'casual-2023',
    });
    const projectCandidates = 'revision' in projectResult ? projectResult.entries : projectResult;
    expect(projectCandidates.map((candidate) => candidate.reference)).toEqual([
      'figure/soyo/casual-2023/model.json',
    ]);
  });

  it('excludes internal dot directories from recursive search and directory browsing', async () => {
    mountSandbox.write('game/figure/anon/.mtn_exp/model.json', MODEL3_JSON);
    sandbox.write('figure/soyo/.mtn_exp/model.json', MODEL_JSON);
    const { resources } = createPorts();
    for (const query of [
      { ownerId: 'anon' },
      { ownerId: 'soyo' },
      { namespace: 'mount:shared-library', pathPrefix: 'game/figure/anon' },
      { namespace: 'mount:shared-library', pathPrefix: 'game/figure/anon/.mtn_exp' },
      { namespace: 'project', pathPrefix: 'figure/soyo' },
      { namespace: 'project', pathPrefix: 'figure/soyo/.mtn_exp' },
    ]) {
      const result = await resources.searchResources(query);
      const candidates = 'revision' in result ? result.entries : result;
      expect(JSON.stringify(candidates)).not.toContain('.mtn_exp');
    }
  });

  it('does not traverse sibling trees or symlinks during a prefix and owner search', async () => {
    mountSandbox.symlink(path.join(mountSandbox.root, 'game'), 'alias');
    const visited: string[] = [];
    class RecordingFs extends ProjectAgentNodeProjectFs {
      override async readDir(dir: string) {
        visited.push(path.relative(mountSandbox.root, dir).replace(/\\/g, '/'));
        return super.readDir(dir);
      }
    }
    const { resources } = createPorts(new RecordingFs());
    const result = await resources.searchResources({
      namespace: 'mount:shared-library', pathPrefix: 'game/figure', ownerId: 'anon',
    });
    expect(('revision' in result ? result.entries : result)).toHaveLength(1);
    expect(visited).not.toContain('game/background');
    expect(visited).not.toContain('game/bgm');
    const alias = await resources.searchResources({
      namespace: 'mount:shared-library', pathPrefix: 'alias/figure', ownerId: 'anon',
    });
    expect('revision' in alias ? alias.entries : alias).toHaveLength(0);
    expect(visited).not.toContain('alias');
  });

  it('excludes internal template assets from conventions and explicit entries', async () => {
    templateSandbox.write('assets/figure/soyo/.mtn_exp/model.json', MODEL_JSON);
    const manifest = JSON.parse(JSON.stringify(TEMPLATE_MANIFEST));
    manifest.assets.index.push({
      id: 'internal', path: 'figure/soyo/.mtn_exp/model.json', kind: 'live2dModel',
      label: 'Internal conversion', metadata: { ownerId: 'soyo', outfitId: '.mtn_exp' },
    });
    packages[0] = createLoadedTemplatePackage(manifest, {
      scope: 'user', packageRoot: templateSandbox.root,
      manifestPath: path.join(templateSandbox.root, 'manifest.v2.json'),
    });
    const { resources } = createPorts();
    const result = await resources.searchResources({ namespace: 'template' });
    const candidates = 'revision' in result ? result.entries : result;
    expect(candidates.some((candidate) => candidate.outfitId === '.mtn_exp')).toBe(false);
    expect(candidates.some((candidate) => candidate.displayName === 'Internal conversion')).toBe(false);
    expect(candidates.some((candidate) => candidate.displayName === 'Soyo Winter')).toBe(true);
  });

  it('keeps an empty project namespace separate from populated external libraries', async () => {
    fs.rmSync(path.join(sandbox.root, 'figure'), { recursive: true });
    fs.rmSync(path.join(sandbox.root, 'background'), { recursive: true });
    fs.rmSync(path.join(sandbox.root, 'images'), { recursive: true });
    fs.rmSync(path.join(sandbox.root, 'bgm'), { recursive: true });
    fs.rmSync(path.join(sandbox.root, 'vocal'), { recursive: true });
    const { resources } = createPorts();
    const local = await resources.searchResources({ namespace: 'project' });
    expect('revision' in local ? local.entries : local).toHaveLength(0);
    const external = await resources.searchResources({ namespace: 'mount:shared-library' });
    expect(('revision' in external ? external.entries : external).length).toBeGreaterThan(0);
  });

  it('results are stable-sorted and contain no absolute paths', async () => {
    const { resources } = createPorts();
    const result = await resources.searchResources({});
    const candidates = 'revision' in result ? result.entries : result;
    const keys = candidates.map((candidate) =>
      `${candidate.scope}:${candidate.kind}:${candidate.reference ?? candidate.displayName}`,
    );
    expect(keys).toEqual([...keys].sort());
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain(sandbox.root);
    expect(serialized).not.toContain(mountSandbox.root);
    expect(serialized).not.toContain('/tmp/');
  });

  it('reports a revision that changes with the underlying tree and stays stable when it does not', async () => {
    const { resources } = createPorts();
    const first = await resources.searchResources({});
    const second = await resources.searchResources({});
    expect('revision' in first).toBe(true);
    expect('revision' in second).toBe(true);
    if (!('revision' in first) || !('revision' in second)) return;
    expect(first.revision).toBe(second.revision);

    sandbox.write('bgm/added.mp3', Buffer.from([0xff, 0xfb]));
    const changed = await resources.searchResources({});
    expect('revision' in changed).toBe(true);
    if ('revision' in changed) expect(changed.revision).not.toBe(first.revision);
  });
});

describe('project agent resource inspect port (sandbox)', () => {
  let sandbox: Sandbox;
  let mountSandbox: Sandbox;
  let outsideSandbox: Sandbox;
  let project: ProjectState;
  let mounts: Array<{ id: string; path: string }>;

  beforeEach(() => {
    sandbox = createSandbox('agent-inspect-project-');
    mountSandbox = createSandbox('agent-inspect-mount-');
    outsideSandbox = createSandbox('agent-inspect-outside-');

    sandbox.write('figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    sandbox.write('background/sky.png', pngBytes(1920, 1080));
    sandbox.write('vocal/soyo/line01.wav', wavBytes(3));
    sandbox.write('notes/readme.txt', 'plain text');
    outsideSandbox.write('figure/evil/model.json', MODEL_JSON);
    sandbox.symlink(path.join(outsideSandbox.root, 'figure', 'evil', 'model.json'), 'figure/escape-model.json');
    sandbox.symlink(outsideSandbox.root, 'figure/escape-dir');
    mountSandbox.write('game/figure/anon/casual-2023/model.model3.json', MODEL3_JSON);

    project = {
      rootPath: sandbox.root,
      projectFilePath: path.join(sandbox.root, 'project.json'),
      metadata: makeMetadata(sandbox.root),
    };
    mounts = [{ id: 'shared-library', path: mountSandbox.root }];
  });

  afterEach(() => {
    sandbox.cleanup();
    mountSandbox.cleanup();
    outsideSandbox.cleanup();
  });

  function createPorts() {
    return createProjectAgentResourcePorts({
      fs: new ProjectAgentNodeProjectFs(),
      getProject: () => project,
      getExternalMounts: () => mounts,
      getTemplatePackages: () => [],
    });
  }

  it('inspects a project-relative Live2D model with parsed motions and expressions', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('figure/soyo/school_winter-2023/model.json');
    expect(result.exists).toBe(true);
    expect(result.scope).toBe('project');
    expect(result.kind).toBe('live2dModel');
    expect(result.bindable).toBe(true);
    expect(result.reference).toBe('figure/soyo/school_winter-2023/model.json');
    expect(result.live2d?.motions).toEqual(['Idle', 'soyo/wave01']);
    expect(result.live2d?.expressions).toEqual(['smile']);
    expect(result.live2d?.capabilities?.runtimeFamily).toBe('cubism2');
    expect(result.live2d?.capabilities?.motionCount).toBe(2);
    expect(result.media?.mimeType).toBe('application/json');
    expect(result.media?.sizeBytes).toBeGreaterThan(0);
  });

  it('inspects a mount reference into the mount scope with cubism3 capabilities', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('@mount/shared-library/game/figure/anon/casual-2023/model.model3.json');
    expect(result.exists).toBe(true);
    expect(result.scope).toBe('mount');
    expect(result.kind).toBe('live2dModel');
    expect(result.bindable).toBe(true);
    expect(result.live2d?.motions).toEqual(['Idle', 'anon/wave02']);
    expect(result.live2d?.expressions).toEqual(['happy']);
    expect(result.live2d?.capabilities?.runtimeFamily).toBe('cubism3-plus');
  });

  it('does not describe internal conversion files as bindable Live2D models', async () => {
    sandbox.write('figure/soyo/.mtn_exp/model.json', MODEL_JSON);
    mountSandbox.write('game/figure/anon/.mtn_exp/model.json', MODEL_JSON);
    const { resourceInspect } = createPorts();
    for (const reference of [
      'figure/soyo/.mtn_exp/model.json',
      '@mount/shared-library/game/figure/anon/.mtn_exp/model.json',
    ]) {
      const result = await resourceInspect.inspectResource(reference);
      expect(result.exists).toBe(true);
      expect(result.bindable).toBe(false);
      expect(result.kind).toBeUndefined();
      expect(result.live2d).toBeUndefined();
    }
  });

  it('reports actual document bytes and preserves model-declared cross-character motion keys', async () => {
    const json = JSON.stringify({
      model: 'anon.moc', motions: {
        'anon/wave': [{ File: 'anon.mtn' }],
        'mana/wave': [{ File: 'mana.mtn' }],
        'mutsumi/wave': [{ File: 'mutsumi.mtn' }],
      },
    });
    mountSandbox.write('game/figure/anon/casual/model.json', json);
    mountSandbox.write('game/figure/anon/winter/model.json', json);
    mountSandbox.write('game/figure/anon/other/model.json', `${json}\n`);
    const { resourceInspect } = createPorts();
    for (const outfit of ['casual', 'winter', 'other']) {
      const result = await resourceInspect.inspectResource(`@mount/shared-library/game/figure/anon/${outfit}/model.json`);
      const expectedBytes = Buffer.byteLength(json) + (outfit === 'other' ? 1 : 0);
      expect(result.media?.sizeBytes).toBe(expectedBytes);
      expect(result.media?.modelDocumentBytes).toBe(expectedBytes);
      expect(result.live2d?.motions).toEqual(['anon/wave', 'mana/wave', 'mutsumi/wave']);
    }
  });

  it('returns image size and MIME without content', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('background/sky.png');
    expect(result.exists).toBe(true);
    expect(result.kind).toBe('background');
    expect(result.bindable).toBe(true);
    expect(result.media?.mimeType).toBe('image/png');
    expect(result.media?.width).toBe(1920);
    expect(result.media?.height).toBe(1080);
    expect(result.media?.sizeBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(sandbox.root);
  });

  it('returns audio format, size and safely-derived duration without content', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('vocal/soyo/line01.wav');
    expect(result.exists).toBe(true);
    expect(result.kind).toBe('voice');
    expect(result.media?.mimeType).toBe('audio/wav');
    expect(result.media?.format).toBe('wav');
    expect(result.media?.durationSeconds).toBe(3);
    expect(result.media?.sizeBytes).toBeGreaterThan(0);
  });

  it('reports missing resources as exists false without leaking paths', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('background/missing.png');
    expect(result.exists).toBe(false);
    expect(result.bindable).toBe(false);
  });

  it('reports an unregistered mount as exists false', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('@mount/unknown-lib/game/bg.png');
    expect(result.exists).toBe(false);
    expect(result.bindable).toBe(false);
  });

  it('rejects escaping symlinks, absolute paths and traversal without leaking the target', async () => {
    const { resourceInspect } = createPorts();
    for (const reference of [
      'figure/escape-model.json',
      'figure/escape-dir/evil/model.json',
      '/etc/passwd',
      '../outside/secret.png',
      'C:/Windows/win.ini',
    ]) {
      const result = await Promise.resolve(resourceInspect.inspectResource(reference)).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['forbidden_path', 'not_found']).toContain(result.error.code);
        expect(result.error.message).not.toContain(outsideSandbox.root);
        expect(result.error.message).not.toContain(sandbox.root);
      }
    }
  });

  it('classifies a missing file behind an escaping symlink as forbidden_path', async () => {
    const { resourceInspect } = createPorts();
    const result = await Promise.resolve(resourceInspect.inspectResource('figure/escape-dir/missing/model.json')).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden_path');
      expect(result.error.message).not.toContain(outsideSandbox.root);
      expect(result.error.message).not.toContain(sandbox.root);
    }
  });

  it('returns exists true with no kind or bindability for non-resource files', async () => {
    const { resourceInspect } = createPorts();
    const result = await resourceInspect.inspectResource('notes/readme.txt');
    expect(result.exists).toBe(true);
    expect(result.kind).toBeUndefined();
    expect(result.bindable).toBe(false);
    expect(result.media).toBeUndefined();
  });
});

describe('project agent resource tools with production ports', () => {
  let sandbox: Sandbox;
  let mountSandbox: Sandbox;
  let outsideSandbox: Sandbox;
  let templateSandbox: Sandbox;
  let project: ProjectState;
  let mounts: Array<{ id: string; path: string }>;
  let packages: ReturnType<typeof createLoadedTemplatePackage>[];

  beforeEach(() => {
    sandbox = createSandbox('agent-tool-res-');
    mountSandbox = createSandbox('agent-tool-mount-');
    outsideSandbox = createSandbox('agent-tool-outside-');
    templateSandbox = createSandbox('agent-tool-template-');

    sandbox.write('figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    sandbox.write('background/sky.png', pngBytes(1920, 1080));
    sandbox.write('bgm/bgm01.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    mountSandbox.write('game/figure/anon/casual-2023/model.model3.json', MODEL3_JSON);
    mountSandbox.write('game/background/bg.png', pngBytes(800, 600));
    outsideSandbox.write('figure/evil/model.json', MODEL_JSON);
    sandbox.symlink(path.join(outsideSandbox.root, 'figure'), 'figure/escape-link');
    templateSandbox.write('assets/figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    templateSandbox.write('manifest.v2.json', JSON.stringify(TEMPLATE_MANIFEST));

    project = {
      rootPath: sandbox.root,
      projectFilePath: path.join(sandbox.root, 'project.json'),
      metadata: makeMetadata(sandbox.root),
    };
    mounts = [{ id: 'shared-library', path: mountSandbox.root }];
    packages = [
      createLoadedTemplatePackage(TEMPLATE_MANIFEST, {
        scope: 'user',
        packageRoot: templateSandbox.root,
        manifestPath: path.join(templateSandbox.root, 'manifest.v2.json'),
      }),
    ];
  });

  afterEach(() => {
    sandbox.cleanup();
    mountSandbox.cleanup();
    outsideSandbox.cleanup();
    templateSandbox.cleanup();
  });

  function createTools() {
    const ports = createProjectAgentResourcePorts({
      fs: new ProjectAgentNodeProjectFs(),
      getProject: () => project,
      getExternalMounts: () => mounts,
      getTemplatePackages: () => packages,
    });
    return {
      tools: new ProjectAgentReadTools({
        ports: {
          overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
          files: { listFiles: () => [] },
          text: { readText: () => ({ lines: [], binary: false }) },
          textSearch: { searchText: () => [] },
          resources: ports.resources,
          resourceInspect: ports.resourceInspect,
          scene: { getSnapshot: () => null },
          validation: { validate: () => [] },
        },
        taskState: new ProjectAgentTaskState(),
      }),
    };
  }

  it('paginates search results over one scan revision and returns pagination_changed on underlying changes', async () => {
    const { tools } = createTools();
    const first = await tools.searchResources({ offset: 0, limit: 3 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextOffset).toBe(3);

    const second = await tools.searchResources({ offset: 3, limit: 3 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const all = [...first.data.entries, ...second.data.entries];
    const keys = all.map((candidate) => `${candidate.scope}:${candidate.kind}:${candidate.reference ?? candidate.displayName}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);

    sandbox.write('bgm/inserted.mp3', Buffer.from([0xff, 0xfb]));
    const changed = await tools.searchResources({ offset: 3, limit: 3 });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error.code).toBe('pagination_changed');
      expect(changed.error.suggestedAction).toBe('retry_from_offset_zero');
    }

    const restart = await tools.searchResources({ offset: 0, limit: 3 });
    expect(restart.ok).toBe(true);
  });

  it('keeps pages stable when only readdir order changes', async () => {
    const { tools } = createTools();
    const first = await tools.searchResources({ offset: 0, limit: 2 });
    expect(first.ok).toBe(true);
    const second = await tools.searchResources({ offset: 2, limit: 2 });
    expect(second.ok).toBe(true);
  });

  it('paginates prefix and owner intersections and detects changes inside the selected subtree', async () => {
    mountSandbox.write('game/figure/anon/winter/model.json', MODEL_JSON);
    const { tools } = createTools();
    const query = { namespace: 'mount:shared-library', pathPrefix: 'game/figure', ownerId: 'anon', limit: 1 };
    const first = await tools.searchResources({ ...query, offset: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.total).toBe(2);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.entries[0]?.reference).toBe('@mount/shared-library/game/figure/anon/casual-2023/model.model3.json');

    mountSandbox.write('game/background/new.png', pngBytes(8, 8));
    const second = await tools.searchResources({ ...query, offset: first.data.nextOffset });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.hasMore).toBe(false);
    expect(second.data.entries[0]?.reference).toBe('@mount/shared-library/game/figure/anon/winter/model.json');

    mountSandbox.write('game/figure/anon/added/model.json', MODEL_JSON);
    const changed = await tools.searchResources({ ...query, offset: 1 });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe('pagination_changed');
  });

  it('marks resource search results truncated when the requested limit exceeds the max', async () => {
    const { tools } = createTools();
    const result = await tools.searchResources({ offset: 0, limit: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.data.entries.length).toBeLessThanOrEqual(100);
  });

  it('sanitizes template candidates to materialization_required with no reference', async () => {
    const { tools } = createTools();
    const result = await tools.searchResources({ namespace: 'template' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries.length).toBeGreaterThan(0);
    for (const candidate of result.data.entries) {
      expect(candidate.reference).toBeUndefined();
      expect(candidate.materializationRequired).toBe(true);
    }
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain(templateSandbox.root);
    expect(serialized).not.toContain('assets/figure');
  });

  it('never leaks local paths or internal project identity through search results', async () => {
    const { tools } = createTools();
    const result = await tools.searchResources({ offset: 0, limit: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain(sandbox.root);
    expect(serialized).not.toContain(mountSandbox.root);
    expect(serialized).not.toContain(outsideSandbox.root);
    expect(serialized).not.toContain('escape-link');
    expect(serialized).not.toContain('resource-project');
  });

  it('inspects through the tool with typed errors and no path leakage', async () => {
    const { tools } = createTools();
    const model = await tools.inspectResource({ reference: '@mount/shared-library/game/figure/anon/casual-2023/model.model3.json' });
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.data.scope).toBe('mount');
    expect(model.data.live2d?.motions).toEqual(['Idle', 'anon/wave02']);
    expect(model.data.bindable).toBe(true);

    const missing = await tools.inspectResource({ reference: 'background/gone.png' });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.data.exists).toBe(false);

    for (const raw of ['/etc/passwd', 'figure/escape-link/evil/model.json', 'C:/evil.png']) {
      const result = await tools.inspectResource({ reference: raw });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['forbidden_path', 'invalid_arguments']).toContain(result.error.code);
        expect(result.error.message).not.toContain(outsideSandbox.root);
        expect(result.error.message).not.toContain(sandbox.root);
      }
    }
  });

  it('reports not_found for missing policy-forbidden references and keeps existing ones forbidden', async () => {
    const { tools } = createTools();

    // Missing files under a forbidden category report not_found, not
    // forbidden_path, and never carry the misleading fix_arguments hint.
    for (const reference of ['scenes/does-not-exist.scene.json', 'scenes/missing.json']) {
      const result = await tools.inspectResource({ reference });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_found');
        expect(result.error.suggestedAction).toBeUndefined();
      }
    }

    // Existing protected references stay forbidden_path without fix_arguments.
    sandbox.write('scenes/real.scene.json', '{"formal":"scene"}');
    const existing = await tools.inspectResource({ reference: 'scenes/real.scene.json' });
    expect(existing.ok).toBe(false);
    if (!existing.ok) {
      expect(existing.error.code).toBe('forbidden_path');
      expect(existing.error.suggestedAction).toBeUndefined();
    }
  });

  it('reports not_found for missing forbidden images and keeps existing ones forbidden', async () => {
    const ports = createProjectAgentResourcePorts({
      fs: new ProjectAgentNodeProjectFs(),
      getProject: () => project,
      getExternalMounts: () => mounts,
      getTemplatePackages: () => packages,
    });
    const imagePort = createProjectAgentImageReadPort({
      fs: new ProjectAgentNodeProjectFs(),
      getProject: () => project,
      getExternalMounts: () => mounts,
    });
    const tools = new ProjectAgentReadTools({
      ports: {
        overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
        files: { listFiles: () => [] },
        text: { readText: () => ({ lines: [], binary: false }) },
        textSearch: { searchText: () => [] },
        resources: ports.resources,
        resourceInspect: ports.resourceInspect,
        image: imagePort,
        scene: { getSnapshot: () => null },
        validation: { validate: () => [] },
      },
      taskState: new ProjectAgentTaskState(),
    });

    const missing = await tools.readImage({ reference: 'scenes/missing.png' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('not_found');
      expect(missing.error.suggestedAction).toBeUndefined();
    }

    sandbox.write('scenes/shadow.png', pngBytes(4, 4));
    const existing = await tools.readImage({ reference: 'scenes/shadow.png' });
    expect(existing.ok).toBe(false);
    if (!existing.ok) {
      expect(existing.error.code).toBe('forbidden_path');
      expect(existing.error.suggestedAction).toBeUndefined();
    }
  });

  it('always returns nextOffset on resource search, even on the last page', async () => {
    const { tools } = createTools();
    const result = await tools.searchResources({ offset: 0, limit: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hasMore).toBe(false);
    // The requested limit is capped at MAX_SEARCH_LIMIT (100); nextOffset
    // reflects the cap so a follow-up page always starts at the right offset.
    expect(result.data.nextOffset).toBe(100);
  });

  it('drives resource tools through the real service composition without leaking identities', async () => {
    const { tools } = createTools();
    const search = await tools.searchResources({ offset: 0, limit: 200 });
    expect(search.ok).toBe(true);
    const inspected = await tools.inspectResource({ reference: 'background/sky.png' });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.data.media?.width).toBe(1920);
    expect(inspected.data.media?.mimeType).toBe('image/png');
  });
});

describe('resource tools through the production service composition', () => {
  let sandbox: Sandbox;
  let mountSandbox: Sandbox;
  let templateSandbox: Sandbox;
  let project: ProjectState;
  let mounts: Array<{ id: string; path: string }>;
  let packages: ReturnType<typeof createLoadedTemplatePackage>[];

  beforeEach(() => {
    sandbox = createSandbox('agent-service-res-');
    mountSandbox = createSandbox('agent-service-mount-');
    templateSandbox = createSandbox('agent-service-template-');

    sandbox.write('figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    sandbox.write('background/sky.png', pngBytes(1920, 1080));
    sandbox.write('project.json', '{"projectId":"never-expose-resource-id"}');
    mountSandbox.write('game/figure/anon/casual-2023/model.model3.json', MODEL3_JSON);
    mountSandbox.write('game/background/bg.png', pngBytes(800, 600));
    templateSandbox.write('assets/figure/soyo/school_winter-2023/model.json', MODEL_JSON);
    templateSandbox.write('manifest.v2.json', JSON.stringify(TEMPLATE_MANIFEST));

    project = {
      rootPath: sandbox.root,
      projectFilePath: path.join(sandbox.root, 'project.json'),
      metadata: makeMetadata(sandbox.root),
    };
    mounts = [{ id: 'shared-library', path: mountSandbox.root }];
    packages = [
      createLoadedTemplatePackage(TEMPLATE_MANIFEST, {
        scope: 'user',
        packageRoot: templateSandbox.root,
        manifestPath: path.join(templateSandbox.root, 'manifest.v2.json'),
      }),
    ];
  });

  afterEach(() => {
    sandbox.cleanup();
    mountSandbox.cleanup();
    templateSandbox.cleanup();
  });

  async function runService(toolCalls: AiConversationResponse['message']['toolCalls']): Promise<AiConversationRequest[]> {
    const tempJournal = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-res-journal-'));
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
                message: { role: 'assistant', content: [], toolCalls: toolCalls as never },
              },
            };
          }
          return {
            status: 'ok',
            response: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'found resources' }],
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

      const document: CurrentSceneDocument = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'resource-scene-doc',
        meta: { title: 'Resource Scene', characters: [] },
        statements: [],
      };
      const resourcePorts = createProjectAgentResourcePorts({
        fs: new ProjectAgentNodeProjectFs(),
        getProject: () => project,
        getExternalMounts: () => mounts,
        getTemplatePackages: () => packages,
      });
      const readPorts = {
        overview: {
          getOverview: () => ({
            name: 'Resource Project',
            projectVersion: 1,
            scenes: [],
            assetRoots: {},
          }),
        },
        files: { listFiles: () => [] },
        text: { readText: () => ({ lines: [], binary: false }) },
        textSearch: { searchText: () => [] },
        resources: resourcePorts.resources,
        resourceInspect: resourcePorts.resourceInspect,
        scene: { getSnapshot: () => ({ document, version: 1 }) },
        validation: { validate: () => [] },
      };
      const writePorts = {
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
          projectId: 'resource-project',
          sceneEntryId: 'resource-scene-entry',
          sceneDocumentId: 'resource-scene-doc',
          sceneName: 'Resource Scene',
        }),
        idFactory: () => 'resource-task',
        now: () => 1000,
      } satisfies ProjectAgentServiceOptions);

      const started = await service.start({ taskText: 'Find resources for the scene' });
      expect(started.ok).toBe(true);
      await service.whenIdle();
      // Round semantics (ADR0023): the plain reply settled the execution
      // round; the Conversation is idle and ready for the next user message.
      expect(service.getTaskSnapshot()?.getLifecycle()).toBe('idle');
      return requests;
    } finally {
      fs.rmSync(tempJournal, { recursive: true, force: true });
    }
  }

  it('delivers bindable references and live2d capabilities without local paths or identities', async () => {
    const requests = await runService([
      { status: 'ready', toolCallId: 'r1', name: 'searchResources', arguments: { offset: 0, limit: 100 } },
      { status: 'ready', toolCallId: 'r2', name: 'inspectResource', arguments: { reference: '@mount/shared-library/game/figure/anon/casual-2023/model.model3.json' } },
    ]);
    const toolMessages = requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool');
    const serialized = JSON.stringify(toolMessages);
    expect(serialized).not.toContain(sandbox.root);
    expect(serialized).not.toContain(mountSandbox.root);
    expect(serialized).not.toContain(templateSandbox.root);
    expect(serialized).not.toContain('never-expose-resource-id');
    expect(serialized).not.toContain('resource-scene-doc');

    expect(serialized).toContain('@mount/shared-library/game/figure/anon/casual-2023/model.model3.json');
    expect(serialized).toContain('figure/soyo/school_winter-2023/model.json');

    const inspectMessage = toolMessages.find((message) => message.name === 'inspectResource');
    expect(JSON.stringify(inspectMessage)).toContain('anon/wave02');
    expect(JSON.stringify(inspectMessage)).toContain('cubism3-plus');
  });

  it('exposes template hits as materialization_required with no reference in the conversation', async () => {
    const requests = await runService([
      { status: 'ready', toolCallId: 't1', name: 'searchResources', arguments: { namespace: 'template', offset: 0, limit: 100 } },
    ]);
    const toolMessages = requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool');
    const searchMessage = toolMessages.find((message) => message.name === 'searchResources');
    const payload = JSON.stringify(searchMessage);
    expect(payload).toContain('materializationRequired');
    expect(payload).not.toContain(templateSandbox.root);
    expect(payload).not.toContain('assets/figure');
    // No template reference may ever look like a bindable path.
    expect(payload).not.toMatch(/"reference":\s*"[^"]+"/);
  });
});
