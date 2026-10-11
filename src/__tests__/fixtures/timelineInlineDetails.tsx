import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { sceneStatementCompiler } from '../../services/semantic-scene';
import { TimelineListView } from '../../ui/timeline/TimelineListView';
import { createTimelineSceneDocument } from './timelineInlineScene';

// This harness records authoring intents while rendering the real inspector controls.
// Import this fixture before UI modules so its mocks register before those modules load.
const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
  author: vi.fn(async (_intent: unknown) => ({})),
  setCustomMotionEditorActionId: vi.fn(),
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({ motions: ['wave'], expressions: ['smile'] })),
    playMotion: vi.fn(), stopAllMotions: vi.fn(), setExpression: vi.fn(),
  },
}));

export { state };

vi.mock('../../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: { editor: { setCopyBuffer: vi.fn(), setCustomMotionEditorActionId: state.setCustomMotionEditorActionId } },
    services: { semanticAuthoring: { author: state.author } },
  }),
  useOptionalApp: () => null,
  useCharacterAdapter: () => state.characterAdapter,
  usePlaybackAdapter: () => ({ getCurrentTime: () => 0, subscribeTime: () => () => {}, seek: vi.fn(), play: vi.fn() }),
  useDocumentStore: () => ({
    version: 1, filePath: null, subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  useSemanticAuthoringService: () => ({
    author: state.author,
    authorTransaction: async (build: any) => {
      for (const intent of build(state.document)) await state.author(intent);
    },
    undo: vi.fn(), redo: vi.fn(),
  }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => 'disconnected',
  useCollaborationPresence: () => ({ peers: [] }),
  useSceneAssetService: () => undefined,
  useResourceAuthoringService: () => undefined,
}));
vi.mock('../../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: [] }),
  useCustomMotionEditorActionId: () => null,
}));
vi.mock('../../ui/SettingsStore', () => ({
  useSettings: () => ({ settings: { workbenchTimelineLayoutMode: 'list', workbenchDialogueFlowMode: 'auto' }, setSetting: vi.fn() }),
  getDefaultDialogueDurationSeconds: () => 2,
}));

export function load(
  type: string,
  params: Record<string, unknown>,
  characters: Array<Record<string, unknown>> = [{ id: 'alice', name: 'Alice' }],
) {
  state.document = createTimelineSceneDocument({
    sceneId: 'inline-details',
    meta: { title: 'Inline details', characters },
    statements: [{ id: 'line', time: 0, type, params }],
  });
  state.compiledScene = sceneStatementCompiler.compile(state.document);
}
export function list(extra: Partial<Parameters<typeof TimelineListView>[0]> = {}) {
  return render(<TimelineListView sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
    selectedActionIds={{}} setSelectedIds={vi.fn()} addAction={vi.fn()} handleSelect={vi.fn()}
    setCurrentTime={vi.fn()} loadExample={vi.fn(async () => true)} {...extra} />);
}
export function expand(container: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
  return within(container.querySelector('.inspector-workspace__detail') as HTMLElement);
}

export function setupInlineDetailsFixture() {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    vi.stubGlobal('PointerEvent', MouseEvent);
    state.author.mockClear();
    state.setCustomMotionEditorActionId.mockClear();
    Object.values(state.characterAdapter).forEach((mock) => mock.mockClear());
    load('dialogue', { speakerId: 'alice', text: '第一句台词', durationSeconds: 2 });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
}
