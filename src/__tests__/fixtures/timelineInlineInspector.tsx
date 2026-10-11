import { render } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { sceneDocumentCodec, sceneStatementCompiler } from '../../services/semantic-scene';
import { SemanticTimelineAuthoringService } from '../../services/timeline-authoring/SemanticTimelineAuthoringService';
import { TimelineListView } from '../../ui/timeline/TimelineListView';
import { createInlineInspectorDocument } from './timelineInlineScene';

// This harness applies authoring transactions and substitutes a lightweight inspector.
// Import this fixture before UI modules so its mocks register before those modules load.
const state = vi.hoisted(() => ({
  document: null as any,
  compiledScene: null as any,
  authorMock: vi.fn(async (_intent: any) => ({})),
  setCopyBuffer: vi.fn(),
  collaborationStatus: 'disconnected',
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({
      motions: ['wave', 'nod', 'mygo/alice/greet', 'mygo/alice/bow', 'mygo/bob/idle'],
      expressions: ['smile', 'happy', 'mygo/alice/happy', 'mygo/bob/sad'],
    })),
    playMotion: vi.fn(), stopAllMotions: vi.fn(), setExpression: vi.fn(),
  },
}));

export { state };

vi.mock('../../ui/context/AppContext', () => ({
  usePlaybackAdapter: () => ({
    getCurrentTime: () => 0,
    subscribeTime: () => () => {},
    seek: vi.fn(),
    play: vi.fn(),
  }),
  useDocumentStore: () => ({
    version: 1,
    filePath: null,
    subscribe: () => () => {},
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  useSemanticAuthoringService: () => ({
    author: state.authorMock,
    authorTransaction: async (build: any) => {
      const intents = typeof build === 'function' ? build(state.document) : build;
      for (const intent of intents) {
        await state.authorMock(intent);
        state.document = new SemanticTimelineAuthoringService().author(state.document, intent).document;
        state.compiledScene = sceneStatementCompiler.compile(state.document);
      }
    },
    undo: vi.fn(),
    redo: vi.fn(),
  }),
  useProjectWorkspaceService: () => undefined,
  useIsCollaborationUndoDisabled: () => false,
  useCollaborationStatus: () => state.collaborationStatus,
  useCollaborationPresence: () => ({ peers: [] }),
  useOptionalApp: () => ({ stores: { editor: { copyBuffer: [], setCopyBuffer: state.setCopyBuffer } } }),
  useCharacterAdapter: () => state.characterAdapter,
}));

vi.mock('../../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: [] }),
  useCustomMotionEditorActionId: () => null,
}));

vi.mock('../../ui/SettingsStore', () => ({
  useSettings: () => ({
    settings: {
      workbenchTimelineLayoutMode: 'list',
      workbenchDialogueFlowMode: 'auto',
    },
    setSetting: vi.fn(),
  }),
}));

vi.mock('../../ui/timeline/ActionInspector', () => ({
  ActionInspector: ({ selectedActionIds, onClose }: any) => (
    <div data-testid="inline-action-inspector" data-action-id={Object.keys(selectedActionIds)[0]}>
      <span>内联属性检查器 - {Object.keys(selectedActionIds)[0]}</span>
      <button onClick={() => onClose()}>关闭内联详情</button>
    </div>
  ),
}));

export function loadStatements(statements: unknown[]) {
  state.document = sceneDocumentCodec.parseAndValidate({ ...createInlineInspectorDocument(), statements });
  state.compiledScene = sceneStatementCompiler.compile(state.document);
}
export function setCharacterModel(model: string) {
  state.document = sceneDocumentCodec.parseAndValidate({
    ...state.document,
    meta: { ...state.document.meta, characters: state.document.meta.characters.map((character: any) => (
      character.id === 'alice' ? { ...character, model } : character
    )) },
  });
  state.compiledScene = sceneStatementCompiler.compile(state.document);
}
export function renderList(extra: Partial<Parameters<typeof TimelineListView>[0]> = {}) {
  return render(<TimelineListView
    sceneData={{ sceneId: state.document.sceneId, meta: state.document.meta, timeline: [] }}
    selectedActionIds={{}} setSelectedIds={vi.fn()} addAction={vi.fn()} handleSelect={vi.fn()}
    setCurrentTime={vi.fn()} loadExample={vi.fn(async () => true)} {...extra}
  />);
}

export function setupInlineInspectorFixture() {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    state.document = createInlineInspectorDocument();
    state.compiledScene = sceneStatementCompiler.compile(state.document);
    state.authorMock.mockClear();
    state.setCopyBuffer.mockClear();
    Object.values(state.characterAdapter).forEach((mock) => mock.mockClear());
    state.collaborationStatus = 'disconnected';
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
}
