/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProseWorkbench } from '../ui/AiProseWorkbench';
import type { AiProseLlmProgress } from '../services/ai-authoring/AiProseContracts';
import {
  confirmMainCharacters,
  createDraft,
  replaceCharacterExtraction,
  replaceEnhancementState,
  replaceNormalization,
  replacePreview,
  replaceRhythm,
  replaceSegmentation,
  setCharacterBindingPlan,
  type DraftSession,
} from '../services/ai-authoring/AiProseDraftSession';
import {
  createEmptyEnhancementState,
  withEnhancementBoundDocumentVersion,
} from '../services/ai-authoring/AiProseEnhancementState';
import type { AiProseCharacterBindingPlanV1 } from '../api/types/ai-prose-authoring';
import {
  TemplatePackageCatalog,
  createLoadedTemplatePackage,
} from '../services/template-package';

const mocks = vi.hoisted(() => ({
  project: {
    rootPath: '/projects/demo',
    projectFilePath: '/projects/demo/project.json',
    metadata: { name: '测试项目' },
  } as any,
  document: {
    schemaVersion: 4,
    sceneId: 'scene-1',
    meta: {
      title: '测试场景',
      characters: [{ id: 'char-linxia', name: '林夏' }],
    },
    statements: [],
  } as any,
  settings: {
    scriptReadingSpeed: 9,
    aiProse: {
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'test-model',
      jsonOutputSupported: false,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
      effort: 'medium',
    },
  },
  setSetting: vi.fn(),
  workspace: {
    getCurrentProject: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
  composition: undefined as any,
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({ motions: [], expressions: [] })),
  },
  templatePackages: null as any,
  currentTime: 12,
  documentVersion: 1,
}));

const enhancementMocks = vi.hoisted(() => ({
  constructorOptions: undefined as Record<string, unknown> | undefined,
  runPerformance: vi.fn(async ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
    ...snapshot,
    performance: {
      stage: 'performance',
      status: 'succeeded',
      patch: {
        version: 'semantic-scene-patch/v1',
        operations: [{
          kind: 'updateCompanion',
          line: 2,
          patch: { params: { motion: 'wave' } },
        }],
      },
    },
  })),
  runCinematic: vi.fn(),
}));

const restoreMocks = vi.hoisted(() => ({
  replayEnhancementState: vi.fn(async (_input: {
    document: unknown;
    state: unknown;
    ports?: {
      modelCapabilities?: unknown;
      cinematicCapabilities?: unknown;
      profileProvider?: unknown;
    };
  }) => ({ state: {}, candidate: {} })),
}));

const runnerMocks = vi.hoisted(() => ({
  constructorOptions: undefined as Record<string, unknown> | undefined,
}));

type TestAiProseProgress = AiProseLlmProgress & {
  delta?: string;
  content?: string;
  effort?: 'low' | 'medium' | 'high';
  error?: unknown;
  contextWindow?: number;
};

type TestDraftLoadResult =
  | { status: 'loaded'; draft: DraftSession }
  | { status: 'missing' };

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    adapters: { character: mocks.characterAdapter },
    services: {
      aiProse: mocks.composition,
      projectWorkspace: mocks.workspace,
      templatePackages: mocks.templatePackages,
    },
  }),
  useDocumentStore: () => ({ version: mocks.documentVersion }),
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: mocks.document }),
  useEditorTime: () => ({ currentTime: mocks.currentTime }),
}));

vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({ settings: mocks.settings, setSetting: mocks.setSetting }),
  normalizeScriptReadingSpeed: (value: number) => value,
}));

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../services/ai-authoring/FormalEnhancementOrchestrator', () => ({
  FormalEnhancementOrchestrator: class {
    constructor(options: Record<string, unknown>) {
      enhancementMocks.constructorOptions = options;
    }

    runPerformance = enhancementMocks.runPerformance;
    runCinematic = enhancementMocks.runCinematic;
  },
}));

vi.mock('../services/ai-authoring/AiProseEnhancementRestore', async () => {
  const actual = await vi.importActual<
    typeof import('../services/ai-authoring/AiProseEnhancementRestore')
  >('../services/ai-authoring/AiProseEnhancementRestore');
  return { ...actual, replayEnhancementState: restoreMocks.replayEnhancementState };
});

vi.mock('../services/ai-authoring/EnhancementProcessorRunner', async () => {
  const actual = await vi.importActual<
    typeof import('../services/ai-authoring/EnhancementProcessorRunner')
  >('../services/ai-authoring/EnhancementProcessorRunner');
  return {
    ...actual,
    EnhancementProcessorRunner: class {
      constructor(options: Record<string, unknown>) {
        runnerMocks.constructorOptions = options;
      }
    },
  };
});

function createComposition(options: {
  draft?: DraftSession;
  loadResult?: () => Promise<TestDraftLoadResult>;
} = {}) {
  let checkpointDraft: DraftSession | null = null;
  let progressHandler: ((progress: TestAiProseProgress) => void) | undefined;
  const persistence = {
    loadResult: vi.fn(options.loadResult ?? (async () => options.draft
      ? { status: 'loaded' as const, draft: options.draft }
      : { status: 'missing' as const })),
    saveCheckpoint: vi.fn(async () => undefined),
  };
  const segmentation = {
    status: 'succeeded' as const,
    planFingerprint: 'plan-1',
    targetSegmentCount: 1,
    candidates: [],
    boundaryIds: [],
    segments: [{ index: 0, startOffset: 0, endOffset: 20, sourceText: '林夏走进房间。\n“你好。”' }],
  };
  const extraction = { status: 'succeeded' as const, suggestedNames: ['林夏'] };
  const pipeline = {
    prepare: vi.fn(async (_sourceText: string, pipelineOptions: { existing?: DraftSession; onLlmProgress?: (progress: AiProseLlmProgress) => void }) => {
      progressHandler = pipelineOptions.onLlmProgress as ((progress: TestAiProseProgress) => void) | undefined;
      checkpointDraft = replaceCharacterExtraction(
        replaceSegmentation(pipelineOptions.existing!, segmentation),
        extraction,
      );
      return {
        sourceText: checkpointDraft.sourceText,
        sourceRevision: checkpointDraft.sourceRevision,
        anchorTime: checkpointDraft.anchorTime,
        targetBatchSize: checkpointDraft.targetBatchSize,
        segmentationFingerprint: segmentation.planFingerprint,
        segmentation,
        characterExtraction: extraction,
        segments: segmentation.segments,
        suggestedMainCharacters: extraction.suggestedNames,
      } as any;
    }),
    normalize: vi.fn(async () => undefined),
    retrySegment: vi.fn(async () => undefined),
    rhythm: vi.fn(async () => undefined),
  };
  const composition = {
    draftPersistence: persistence,
    configuration: {
      updateProvider: vi.fn(),
      updateProviderConfig: vi.fn(),
      updateRequestSettings: vi.fn(),
      probeCapabilities: vi.fn(),
    },
    createDraftCheckpoint: vi.fn((_project: unknown, draft: DraftSession) => {
      checkpointDraft = draft;
      return {
        getDraft: () => checkpointDraft!,
      };
    }),
    pipeline,
    applicator: {
      apply: vi.fn(async (draft: DraftSession) => ({
        appliedDraft: { ...draft, status: 'applied' as const },
        receipt: { createdStatementIds: ['statement-1'] },
      })),
    },
    llm: {},
  };
  return {
    composition,
    persistence,
    pipeline,
    emitProgress: (progress: TestAiProseProgress) => progressHandler?.(progress),
  };
}

function createReadyDraft(): DraftSession {
  const segmentation = {
    status: 'succeeded' as const,
    planFingerprint: 'plan-ready',
    targetSegmentCount: 1,
    candidates: [],
    boundaryIds: [],
    segments: [{ index: 0, startOffset: 0, endOffset: 7, sourceText: '林夏：你好。' }],
  };
  let draft = createDraft({
    sceneId: 'scene-1',
    sessionId: 'session-ready',
    sourceText: '林夏：你好。',
    anchorMode: 'zero',
    now: '2026-08-04T00:00:00.000Z',
  });
  draft = replaceSegmentation(draft, segmentation);
  draft = replaceCharacterExtraction(draft, { status: 'succeeded', suggestedNames: ['林夏'] });
  draft = confirmMainCharacters(draft, ['林夏']);
  draft = replaceNormalization(draft, [{
    segmentIndex: 0,
    status: 'succeeded',
    statements: [{ speaker: '林夏', text: '你好。' }],
  }]);
  draft = replaceRhythm(draft, [{ segmentIndex: 0, status: 'succeeded', gapSeconds: [] }]);
  return replacePreview(draft, {
    statements: [{
      speaker: '林夏',
      text: '你好。',
      segmentIndex: 0,
      statementIndex: 0,
      time: 0,
      durationSeconds: 0.9,
      gapSecondsToNext: 0,
    }],
    anchorTime: 0,
    durationSeconds: 0.9,
  });
}

function createTraceProgress(overrides: Partial<TestAiProseProgress> = {}): TestAiProseProgress {
  return {
    requestId: 'request-a',
    stage: 'segmentation',
    phase: 'started',
    inputTokens: 10,
    outputTokens: 2,
    inputTokensSource: 'estimate',
    outputTokensSource: 'estimate',
    model: 'test-model',
    effort: 'medium',
    ...overrides,
  };
}

async function renderTraceWorkbench() {
  mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
  const created = createComposition();
  mocks.composition = created.composition;

  render(<AiProseWorkbench />);

  const source = await screen.findByRole('textbox', { name: '完整正文' });
  fireEvent.change(source, { target: { value: '林夏走进房间。\n“你好。”' } });
  fireEvent.click(screen.getAllByRole('button', { name: /开始分析/ })[0]);
  await waitFor(() => expect(created.pipeline.prepare).toHaveBeenCalledTimes(1));
  return created;
}

afterEach(() => {
  localStorage.clear();
  mocks.templatePackages = null;
  mocks.documentVersion = 1;
  vi.clearAllMocks();
});

describe('AiProseWorkbench', () => {
  afterEach(() => {
    mocks.composition = undefined;
  });

  it('starts at 9 chars/sec and carries slider changes into settings and the draft', async () => {
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    const { composition, persistence } = createComposition();
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    const slider = await screen.findByRole('slider', { name: 'scriptReadingSpeed' });
    expect((slider as HTMLInputElement).value).toBe('9');
    expect(slider.getAttribute('min')).toBe('1');
    expect(slider.getAttribute('max')).toBe('20');
    expect(slider.getAttribute('step')).toBe('0.5');

    fireEvent.change(slider, { target: { value: '12.5' } });

    await waitFor(() => expect(mocks.setSetting).toHaveBeenCalledWith('scriptReadingSpeed', 12.5));
    await waitFor(() => expect(persistence.saveCheckpoint).toHaveBeenCalledWith(
      mocks.project,
      expect.objectContaining({ scriptReadingSpeed: 12.5 }),
    ));
  });

  it('settles draft restoration when the document version changes while loading', async () => {
    const plan: AiProseCharacterBindingPlanV1 = {
      status: 'ready',
      bindings: {
        林夏: { name: '林夏', speakerId: 'char-linxia', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    let readyDraft = setCharacterBindingPlan(createReadyDraft(), plan);
    readyDraft = replaceEnhancementState(
      readyDraft,
      withEnhancementBoundDocumentVersion(createEmptyEnhancementState(readyDraft), 1),
    );
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    mocks.documentVersion = 1;
    let resolveLoad!: (result: TestDraftLoadResult) => void;
    const { composition } = createComposition({
      loadResult: () => new Promise<TestDraftLoadResult>((resolve) => {
        resolveLoad = resolve;
      }),
    });
    mocks.composition = composition;

    const rendered = render(<AiProseWorkbench />);
    expect(screen.getByRole('heading', { name: '正在恢复 AI 草稿' })).toBeTruthy();

    mocks.documentVersion = 2;
    mocks.document = { ...mocks.document };
    rendered.rerender(<AiProseWorkbench />);
    resolveLoad({ status: 'loaded', draft: readyDraft });

    await screen.findByRole('textbox', { name: '完整正文' });
    expect(screen.queryByRole('heading', { name: '正在恢复 AI 草稿' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    await waitFor(() => expect(screen.getByText('场景已变化，请重新运行增强。')).toBeTruthy());
    expect(restoreMocks.replayEnhancementState).not.toHaveBeenCalled();
  });

  it('keeps source edits in the draft and advances to the deterministic segmentation artifact', async () => {
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    const { composition, persistence, pipeline } = createComposition();
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    const source = await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.change(source, { target: { value: '林夏走进房间。\n“你好。”' } });
    expect((source as HTMLTextAreaElement).value).toBe('林夏走进房间。\n“你好。”');
    await waitFor(() => expect(persistence.saveCheckpoint).toHaveBeenCalled());

    expect(screen.queryByRole('button', { name: '继续下一阶段' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /开始分析/ })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: /开始分析/ })[0]);

    await waitFor(() => expect(pipeline.prepare).toHaveBeenCalledTimes(1));
    const segmentationTab = await screen.findByRole('tab', { name: /语义分段/ });
    expect(segmentationTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('故事段 1')).toBeTruthy();
    expect(screen.getByText('目标处理量')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /进入人物确认/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /人物确认/ }).getAttribute('aria-selected')).toBe('true'));
  });

  it('keeps generated statements read-only until the user confirms atomic application', async () => {
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    expect(screen.getByText('你好。')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /语句/ })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /写入正式时间线/ })[0]);
    expect(screen.getByRole('dialog').textContent).toContain('确认原子应用');

    fireEvent.click(screen.getByRole('button', { name: '确认原子应用' }));
    await waitFor(() => expect(composition.applicator.apply).toHaveBeenCalledWith(
      readyDraft,
      mocks.document,
      expect.any(Object),
    ));
  });

  it('drops an enhancement plan when the draft reading speed changes before application', async () => {
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    fireEvent.click(screen.getByRole('button', { name: '表演指导' }));
    fireEvent.click(screen.getByRole('button', { name: '运行可选增强' }));
    await waitFor(() => expect(enhancementMocks.runPerformance).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('slider', { name: 'scriptReadingSpeed' }), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /写入正式时间线/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '确认原子应用' }));

    await waitFor(() => expect(composition.applicator.apply).toHaveBeenCalledWith(
      expect.objectContaining({ scriptReadingSpeed: 10 }),
      mocks.document,
      {},
    ));
  });

  it('keeps the character input focused while editing a name', async () => {
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /人物确认/ }));

    const characterInput = screen.getByRole('textbox', { name: '主要人物 1' });
    characterInput.focus();
    expect(document.activeElement).toBe(characterInput);
    fireEvent.change(characterInput, { target: { value: '林夏A' } });

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '主要人物 1' }));
  });

  it('applies a draft enhancement bound to the current document version', async () => {
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    mocks.documentVersion = 5;
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    fireEvent.click(screen.getByRole('button', { name: '表演指导' }));
    fireEvent.click(screen.getByRole('button', { name: '运行可选增强' }));
    await waitFor(() => expect(enhancementMocks.runPerformance).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getAllByRole('button', { name: /写入正式时间线/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '确认原子应用' }));

    await waitFor(() => expect(composition.applicator.apply).toHaveBeenCalledTimes(1));
    expect(composition.applicator.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        enhancement: expect.objectContaining({ boundDocumentVersion: 5 }),
      }),
      mocks.document,
      expect.anything(),
    );
  });

  it('refuses to apply a draft enhancement bound to a stale document version', async () => {
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    mocks.documentVersion = 5;
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    fireEvent.click(screen.getByRole('button', { name: '表演指导' }));
    fireEvent.click(screen.getByRole('button', { name: '运行可选增强' }));
    await waitFor(() => expect(enhancementMocks.runPerformance).toHaveBeenCalledTimes(1));

    mocks.documentVersion = 6;
    fireEvent.click(screen.getAllByRole('button', { name: /写入正式时间线/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '确认原子应用' }));

    await waitFor(() => expect(screen.getByText('场景已变化，请重新运行增强')).toBeTruthy());
    expect(composition.applicator.apply).not.toHaveBeenCalled();
  });

  it('applies a draft without a bound document version as before', async () => {
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    mocks.documentVersion = 5;
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /写入正式时间线/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '确认原子应用' }));

    await waitFor(() => expect(composition.applicator.apply).toHaveBeenCalledWith(
      readyDraft,
      mocks.document,
      {},
    ));
  });

  it('runs the draft enhancement with the same capability ports the restore path replays', async () => {
    const plan: AiProseCharacterBindingPlanV1 = {
      status: 'ready',
      bindings: {
        林夏: { name: '林夏', speakerId: 'char-linxia', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    mocks.templatePackages = new TemplatePackageCatalog([createLoadedTemplatePackage({
      manifestSchemaVersion: 2,
      template: {
        id: 'test.profile',
        name: 'Profile Package',
        version: '1.0.0',
        compatibility: { sceneSchemaVersion: 4 },
      },
      performanceProfiles: [{
        id: 'test.performance',
        name: 'Test Profile',
        schemaVersion: 1,
        characters: [{
          id: 'char-linxia',
          canonicalName: '林夏',
          motions: [{ key: 'linxia/wave01', description: '挥手' }],
        }],
      }],
    }, { scope: 'user', packageRoot: '/tmp/test/profile' })]);
    let readyDraft = setCharacterBindingPlan(createReadyDraft(), plan);
    readyDraft = replaceEnhancementState(
      readyDraft,
      withEnhancementBoundDocumentVersion(createEmptyEnhancementState(readyDraft), 1),
    );
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    mocks.documentVersion = 1;
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    // Restore path replays with the shared capability ports.
    await waitFor(() => expect(restoreMocks.replayEnhancementState).toHaveBeenCalledTimes(1));
    const replayCall = restoreMocks.replayEnhancementState.mock.calls[0]![0]!;
    expect(replayCall.ports).toBeTruthy();
    expect(replayCall.ports!.modelCapabilities).toBeTruthy();
    expect(replayCall.ports!.cinematicCapabilities).toBeTruthy();
    expect(replayCall.ports!.profileProvider).not.toBeNull();

    // Run path passes the identical port objects to the processor runner.
    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    fireEvent.click(screen.getByRole('button', { name: '表演指导' }));
    fireEvent.click(screen.getByRole('button', { name: '运行可选增强' }));
    await waitFor(() => expect(enhancementMocks.runPerformance).toHaveBeenCalledTimes(1));

    const runnerOptions = runnerMocks.constructorOptions as {
      modelCapabilities?: unknown;
      cinematicCapabilities?: unknown;
      profileProvider?: unknown;
    };
    expect(runnerOptions.modelCapabilities).toBe(replayCall.ports!.modelCapabilities);
    expect(runnerOptions.cinematicCapabilities).toBe(replayCall.ports!.cinematicCapabilities);
    expect(runnerOptions.profileProvider).toBe(replayCall.ports!.profileProvider);
    expect(runnerOptions.profileProvider).not.toBeNull();
  });

  it('restricts enhancement placeholder materialization to draft-created statements', async () => {
    // The formal scene already has a bound dialogue that must never be
    // backfilled with a placeholder; only the draft-created dialogue is a target.
    mocks.document = {
      ...mocks.document,
      statements: [{
        id: 'formal-1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'char-linxia',
          speaker: '林夏',
          text: '既有台词。',
          durationSeconds: 1,
        },
      }],
    };
    const readyDraft = createReadyDraft();
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;
    enhancementMocks.runCinematic.mockResolvedValue({
      cinematic: {
        stage: 'cinematic',
        status: 'succeeded',
        patch: { version: 'semantic-scene-patch/v1', operations: [] },
      },
    });

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));
    fireEvent.click(screen.getByRole('button', { name: '表演指导' }));
    fireEvent.click(screen.getByRole('button', { name: '电影感' }));
    fireEvent.click(screen.getByRole('button', { name: '运行可选增强' }));
    await waitFor(() => expect(enhancementMocks.runPerformance).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(enhancementMocks.runCinematic).toHaveBeenCalledTimes(1));

    const performanceCall = enhancementMocks.runPerformance.mock.calls[0]![0] as {
      placeholderTargetStatementIds?: Set<string>;
    };
    expect(performanceCall.placeholderTargetStatementIds).toBeDefined();
    expect(performanceCall.placeholderTargetStatementIds!.has('formal-1')).toBe(false);
    expect(performanceCall.placeholderTargetStatementIds!.size).toBe(1);

    const cinematicCall = enhancementMocks.runCinematic.mock.calls[0]![0] as {
      placeholderTargetStatementIds?: Set<string>;
    };
    expect(cinematicCall.placeholderTargetStatementIds).toBe(performanceCall.placeholderTargetStatementIds);
  });

  it('does not restore an enhancement stage plan bound to a stale document version', async () => {
    const plan: AiProseCharacterBindingPlanV1 = {
      status: 'ready',
      bindings: {
        林夏: { name: '林夏', speakerId: 'char-linxia', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    let readyDraft = setCharacterBindingPlan(createReadyDraft(), plan);
    readyDraft = replaceEnhancementState(
      readyDraft,
      withEnhancementBoundDocumentVersion(createEmptyEnhancementState(readyDraft), 5),
    );
    localStorage.setItem('aeonstagery.ai-prose.scene-1.session', readyDraft.sessionId);
    mocks.workspace.getCurrentProject.mockReturnValue(mocks.project);
    mocks.documentVersion = 6;
    const { composition } = createComposition({ draft: readyDraft });
    mocks.composition = composition;

    render(<AiProseWorkbench />);

    await screen.findByRole('textbox', { name: '完整正文' });
    fireEvent.click(screen.getByRole('tab', { name: /时间编排/ }));

    await waitFor(() => expect(screen.getByText('场景已变化，请重新运行增强。')).toBeTruthy());
    expect(composition.applicator.apply).not.toHaveBeenCalled();
  });

  it('renders parallel request cards and merges deltas/final content by stable requestId', async () => {
    const { emitProgress } = await renderTraceWorkbench();

    act(() => {
      emitProgress(createTraceProgress({
        requestId: 'request-a',
        model: 'model-a',
        contextWindow: 1000,
        elapsedMs: 12,
      }));
      emitProgress(createTraceProgress({
        requestId: 'request-b',
        stage: 'characterExtraction',
        model: 'model-b',
        effort: 'high',
        inputTokens: 20,
        outputTokens: 4,
        inputTokensSource: 'provider',
        outputTokensSource: 'provider',
        elapsedMs: 45,
      }));
      emitProgress(createTraceProgress({ requestId: 'request-a', phase: 'chunk', model: undefined, delta: '{"answer":"' }));
      emitProgress(createTraceProgress({ requestId: 'request-a', phase: 'chunk', model: undefined, delta: 'ok"}' }));
    });

    const firstCard = await screen.findByTestId('ai-prose-trace-card-request-a');
    const secondCard = screen.getByTestId('ai-prose-trace-card-request-b');
    expect(document.querySelectorAll('.ai-prose-trace-card')).toHaveLength(2);
    expect(firstCard.getAttribute('data-status')).toBe('running');
    expect(within(firstCard).getByText('{"answer":"ok"}')).toBeTruthy();
    expect(firstCard.textContent ?? '').toContain('model-a');
    expect(within(firstCard).getByText('medium')).toBeTruthy();
    expect(within(firstCard).getByText('≈10')).toBeTruthy();
    expect(within(firstCard).getByText('model-a · 1.2% context used')).toBeTruthy();
    expect(within(firstCard).queryByText('request-a')).toBeNull();
    expect(within(firstCard).queryByText('segmentation')).toBeNull();
    expect(firstCard.querySelector('.ai-prose-trace-card-mark')).toBeNull();
    expect(within(firstCard).getByText('1.2%')).toBeTruthy();
    expect(within(firstCard).getByTestId('ai-prose-trace-context')).toBeTruthy();
    expect(within(secondCard).queryByTestId('ai-prose-trace-context')).toBeNull();

    act(() => {
      emitProgress(createTraceProgress({
        requestId: 'request-a',
        phase: 'completed',
        model: undefined,
        content: '{"final":true}',
        inputTokens: 14,
        outputTokens: 6,
        inputTokensSource: 'provider',
        outputTokensSource: 'provider',
        elapsedMs: 1200,
      }));
    });
    await waitFor(() => expect(firstCard.getAttribute('data-status')).toBe('completed'));
    expect(within(firstCard).queryByText('{"final":true}')).toBeNull();

    fireEvent.click(within(firstCard).getByRole('button', { name: 'request-a completed' }));
    expect(within(firstCard).getByText('{"final":true}')).toBeTruthy();

    act(() => {
      emitProgress(createTraceProgress({ requestId: 'request-b', phase: 'completed', content: '{"characters":[]}' }));
    });
    await waitFor(() => expect(secondCard.getAttribute('data-status')).toBe('completed'));
    expect(within(firstCard).getByText('{"final":true}')).toBeTruthy();
  });

  it('keeps partial stream content and reports a failed request without persisting trace state', async () => {
    const { emitProgress, persistence } = await renderTraceWorkbench();
    const saveCountBeforeProgress = persistence.saveCheckpoint.mock.calls.length;

    act(() => {
      emitProgress(createTraceProgress({ requestId: 'request-failed', phase: 'started' }));
      emitProgress(createTraceProgress({ requestId: 'request-failed', phase: 'chunk', delta: 'partial response' }));
      emitProgress(createTraceProgress({
        requestId: 'request-failed',
        phase: 'failed',
        error: { message: 'gateway timeout' },
        status: 504,
        elapsedMs: 2200,
      }));
    });

    const card = await screen.findByTestId('ai-prose-trace-card-request-failed');
    await waitFor(() => expect(card.getAttribute('data-status')).toBe('failed'));
    expect(within(card).getByText('partial response')).toBeTruthy();
    expect(within(card).getByText('gateway timeout')).toBeTruthy();
    expect(within(card).getByText('504')).toBeTruthy();
    expect(persistence.saveCheckpoint.mock.calls.length).toBe(saveCountBeforeProgress);
  });

  it('clears request results and expansion state when a new AI run starts', async () => {
    const { emitProgress, pipeline } = await renderTraceWorkbench();

    act(() => {
      emitProgress(createTraceProgress({ requestId: 'request-old', phase: 'started' }));
      emitProgress(createTraceProgress({ requestId: 'request-old', phase: 'completed', content: '{"old":true}' }));
    });
    const oldCard = await screen.findByTestId('ai-prose-trace-card-request-old');
    await waitFor(() => expect(oldCard.getAttribute('data-status')).toBe('completed'));
    fireEvent.click(within(oldCard).getByRole('button', { name: 'request-old completed' }));
    expect(within(oldCard).getByText('{"old":true}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(pipeline.prepare).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('ai-prose-trace-card-request-old')).toBeNull();

    act(() => {
      emitProgress(createTraceProgress({ requestId: 'request-new', phase: 'started', delta: 'fresh' }));
    });
    const newCard = await screen.findByTestId('ai-prose-trace-card-request-new');
    expect(screen.queryByTestId('ai-prose-trace-card-request-old')).toBeNull();
    expect(within(newCard).getByText('fresh')).toBeTruthy();
  });
});
