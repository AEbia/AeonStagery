/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  TemplatePackageCatalog,
  createLoadedTemplatePackage,
} from '../services/template-package';
import { buildEnhancementCapabilityPorts } from '../ui/hooks/useEnhancementCapabilityPorts';
import { FormalSceneEnhancementPanel } from '../ui/FormalSceneEnhancementPanel';

const mocks = vi.hoisted(() => ({
  document: {
    schemaVersion: 5 as const,
    sceneId: 'scene-1',
    meta: {
      title: '测试场景',
      characters: [{
        id: 'char-hero',
        name: 'Hero',
        model: 'hero.model3.json',
      }],
    },
    statements: [],
  } as CurrentSceneDocument,
  composition: {
    llm: {},
    configuration: { requestBudget: { maxConcurrentRequests: 2 } },
  },
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({ motions: ['hero/wave01'], expressions: [] })),
  },
  templatePackages: null as TemplatePackageCatalog | null,
  documentVersion: 1,
}));

const orchestratorMocks = vi.hoisted(() => ({
  constructorOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    adapters: { character: mocks.characterAdapter },
    services: {
      aiProse: mocks.composition,
      templatePackages: mocks.templatePackages,
      semanticAuthoring: {},
    },
  }),
  useDocumentStore: () => ({ version: mocks.documentVersion }),
  useSemanticAuthoringService: () => ({}),
  useProjectWorkspaceService: () => undefined,
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: mocks.document }),
}));

vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({
    settings: { aiProse: { targetBatchSize: 4000 } },
    setSetting: vi.fn(),
  }),
}));

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../services/ai-authoring/FormalEnhancementOrchestrator', () => ({
  FormalEnhancementOrchestrator: class {
    constructor(options: Record<string, unknown>) {
      orchestratorMocks.constructorOptions = options;
    }

    resolveAutoSegmentation = vi.fn();
    runPerformance = vi.fn();
  },
}));

function profilePackage() {
  return createLoadedTemplatePackage({
    manifestSchemaVersion: 2,
    template: {
      id: 'test.profile',
      name: 'Profile Package',
      version: '1.0.0',
      compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
    },
    performanceProfiles: [{
      id: 'test.performance',
      name: 'Test Profile',
      schemaVersion: 1,
      characters: [{
        id: 'hero',
        canonicalName: 'Hero',
        motions: [{ key: 'hero/wave01', description: '挥手' }],
      }],
    }],
  }, { scope: 'user', packageRoot: '/tmp/test/profile' });
}

afterEach(() => {
  vi.clearAllMocks();
  orchestratorMocks.constructorOptions = undefined;
  mocks.templatePackages = null;
});

describe('buildEnhancementCapabilityPorts', () => {
  it('builds a performance profile provider from the template package catalog', () => {
    const ports = buildEnhancementCapabilityPorts({
      document: mocks.document,
      templatePackages: new TemplatePackageCatalog([profilePackage()]),
      modelCapabilities: {
        'char-hero': { motions: ['hero/wave01'], expressions: [], ready: true },
      },
    });

    expect(ports.profileProvider).not.toBeNull();
    const resolution = ports.profileProvider!.resolveCharacter({ id: 'char-hero', name: 'Hero' });
    expect(resolution.status).toBe('matched');
    expect(ports.modelCapabilityPort.hasModelConfigured('char-hero')).toBe(true);
    expect(ports.modelCapabilityPort.motionsForCharacter('char-hero')).toEqual(['hero/wave01']);
    expect(ports.modelCapabilityPort.capabilitiesReadyForCharacter!('char-hero')).toBe(true);
    expect(ports.cinematicCapabilityPort).toBeTruthy();
  });

  it('returns a null profile provider when the catalog exposes no performance profile', () => {
    const ports = buildEnhancementCapabilityPorts({
      document: mocks.document,
      templatePackages: new TemplatePackageCatalog([]),
    });
    expect(ports.profileProvider).toBeNull();
  });
});

describe('FormalSceneEnhancementPanel', () => {
  it('keeps formal enhancement focused on performance and omits the cinematic stage', async () => {
    mocks.templatePackages = new TemplatePackageCatalog([profilePackage()]);

    render(<FormalSceneEnhancementPanel />);

    await waitFor(() => expect(orchestratorMocks.constructorOptions).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });

    const options = orchestratorMocks.constructorOptions! as {
      modelCapabilities?: {
        hasModelConfigured: (characterId: string) => boolean;
        motionsForCharacter: (characterId: string) => readonly string[];
      };
      cinematicCapabilities?: Record<string, unknown>;
      profileProvider: { resolveCharacter: (identity: { id: string; name: string }) => { status: string } };
    };
    expect(options.modelCapabilities).toBeTruthy();
    expect(options.modelCapabilities?.hasModelConfigured('char-hero')).toBe(true);
    expect(options.modelCapabilities?.motionsForCharacter('char-hero')).toEqual(['hero/wave01']);
    expect(options.cinematicCapabilities).toBeUndefined();
    expect(options.profileProvider).toBeTruthy();
    const resolution = options.profileProvider.resolveCharacter({ id: 'char-hero', name: 'Hero' });
    expect(resolution.status).toBe('matched');
    expect(screen.getByText('正式增强')).toBeTruthy();
    expect(screen.queryByText('电影感')).toBeNull();
    expect(screen.getByText('预览应用')).toBeTruthy();
  });
});
