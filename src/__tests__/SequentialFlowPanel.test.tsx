/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import SequentialFlowPanel from '../ui/SequentialFlowPanel';
import { AUTHORING_SCHEMA_VERSION, type SemanticAuthorIntent, type SemanticAuthorReceipt } from '../api/types/authoring';
import { DocumentStore } from '../ui/store/DocumentStore';
import { EditorStore } from '../ui/store/EditorStore';
import { PlaybackStore } from '../ui/store/PlaybackStore';
import { ValidationStore } from '../ui/store/ValidationStore';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';

function makeScene(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_1',
    meta: {
      title: 'Test Scene',
      characters: [{ id: 'tomori', name: '灯' }],
      markers: [],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 1,
        type: 'dialogue',
        params: { text: '已有。', durationSeconds: 2, style: 'typewriter' },
      },
    ],
  };
}

function makeReceipt(createdStatementIds: string[]): SemanticAuthorReceipt {
  return {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: 'intent_seq_1',
    intentType: 'append-sequential-lines',
    origin: 'sequential-flow',
    historyDescriptor: { key: 'timeline.author.appendSequentialLines', args: { count: createdStatementIds.length }, fallbackLabel: '顺序铺排' },
    warnings: [],
    resolvedScope: { kind: 'none' },
    createdStatementIds,
    updatedStatementIds: [],
    deletedStatementIds: [],
    createdCompanionLocators: [],
    updatedCompanionLocators: [],
    deletedCompanionLocators: [],
    createdMarkerIds: [],
    deletedMarkerIds: [],
    createdMarkers: [],
    deletedMarkers: [],
    sideEffects: [],
    timeRange: { start: 3, end: 7.8 },
  };
}

function renderPanel() {
  const documentStore = new DocumentStore();
  const editorStore = new EditorStore();
  const playbackStore = new PlaybackStore();
  const validationStore = new ValidationStore();
  documentStore._replaceCurrentSceneDocumentSnapshot(makeScene());

  const author = vi.fn(async (_intent: SemanticAuthorIntent) => makeReceipt(['dlg_2', 'dlg_3']));

  render(
    <AppProvider
      adapters={{
        playback: { getCurrentTime: () => 0, subscribeTime: () => () => {} } as any,
        camera: {} as any,
        character: {} as any,
        stage: {} as any,
        timeline: {
          select: vi.fn(),
          selectSingle: vi.fn(),
          toggleSelection: vi.fn(),
          clearSelection: vi.fn(),
          getSelectedIds: () => editorStore.selectedActionIds,
        },
        export: {} as any,
      }}
      stores={{
        document: documentStore,
        playback: playbackStore,
        editor: editorStore,
        validation: validationStore,
      }}
      services={{
        sceneFile: {} as any,
        semanticAuthoring: { author } as any,
      }}
    >
      <SequentialFlowPanel />
    </AppProvider>,
  );

  return { author };
}

function renderPanelWithScene(scene: CurrentSceneDocument) {
  const documentStore = new DocumentStore();
  const editorStore = new EditorStore();
  const playbackStore = new PlaybackStore();
  const validationStore = new ValidationStore();
  documentStore._replaceCurrentSceneDocumentSnapshot(scene);

  const author = vi.fn(async (_intent: SemanticAuthorIntent) => makeReceipt(['dlg_2', 'dlg_3']));

  render(
    <AppProvider
      adapters={{
        playback: { getCurrentTime: () => 0, subscribeTime: () => () => {} } as any,
        camera: {} as any,
        character: {} as any,
        stage: {} as any,
        timeline: {
          select: vi.fn(),
          selectSingle: vi.fn(),
          toggleSelection: vi.fn(),
          clearSelection: vi.fn(),
          getSelectedIds: () => editorStore.selectedActionIds,
        },
        export: {} as any,
      }}
      stores={{
        document: documentStore,
        playback: playbackStore,
        editor: editorStore,
        validation: validationStore,
      }}
      services={{
        sceneFile: {} as any,
        semanticAuthoring: { author } as any,
      }}
    >
      <SequentialFlowPanel />
    </AppProvider>,
  );

  return { author };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('SequentialFlowPanel', () => {
  it('appends a pasted block of lines through the sequential-flow authoring origin', async () => {
    const { author } = renderPanel();

    const textarea = screen.getByLabelText('顺序铺排整段文本');
    fireEvent.change(textarea, { target: { value: '你好。\n我想把这句话说清楚。' } });
    fireEvent.click(screen.getByRole('button', { name: /整段追加/ }));

    await waitFor(() => {
      expect(author).toHaveBeenCalledTimes(1);
    });
    const intent = author.mock.calls[0][0];
    expect(intent).toEqual(expect.objectContaining({
      kind: 'append-sequential-lines',
      origin: 'sequential-flow',
      lines: ['你好。', '我想把这句话说清楚。'],
    }));

    await waitFor(() => {
      expect(screen.getByText(/已追加/)).toBeTruthy();
    });
    expect(screen.getByText(/2 条对白/)).toBeTruthy();
  });

  it('appends a single line on Enter and clears the input', async () => {
    const { author } = renderPanel();

    const input = screen.getByLabelText('单句追加输入');
    fireEvent.change(input, { target: { value: '单句对白。' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(author).toHaveBeenCalledTimes(1);
    });
    const intent = author.mock.calls[0][0];
    expect(intent).toEqual(expect.objectContaining({
      kind: 'append-sequential-lines',
      lines: ['单句对白。'],
    }));
  });

  it('does not append when Enter confirms an IME composition', async () => {
    const { author } = renderPanel();

    const input = screen.getByLabelText('单句追加输入');
    fireEvent.change(input, { target: { value: '单句对白。' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(author).not.toHaveBeenCalled();
  });

  it('shows a preview of the paced append before applying', () => {
    renderPanel();

    const textarea = screen.getByLabelText('顺序铺排整段文本');
    fireEvent.change(textarea, { target: { value: '你好。\n我想把这句话说清楚。' } });

    expect(screen.getByText(/追加预览/)).toBeTruthy();
    expect(screen.getByText(/2 句对白 · 预计/)).toBeTruthy();
    expect(screen.getByText(/从 3\.0s 开始/)).toBeTruthy();
  });

  it('disables submit for empty or whitespace-only input', async () => {
    const { author } = renderPanel();

    const textarea = screen.getByLabelText('顺序铺排整段文本');
    fireEvent.change(textarea, { target: { value: '   \n' } });
    const appendButton = screen.getByRole('button', { name: /整段追加/ });
    expect((appendButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(appendButton);

    expect(author).not.toHaveBeenCalled();
  });

  it('switches the scene pace tier through an update-scene-pace-tier intent', async () => {
    const { author } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '慢' }));

    await waitFor(() => {
      expect(author).toHaveBeenCalledTimes(1);
    });
    const intent = author.mock.calls[0][0];
    expect(intent).toEqual(expect.objectContaining({
      kind: 'update-scene-pace-tier',
      origin: 'sequential-flow',
      tier: 'slow',
    }));
  });

  it('does not author when the current tier is selected again', async () => {
    const { author } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: '正常' }));

    expect(author).not.toHaveBeenCalled();
  });

  it('previews paced durations with the scene tier', () => {
    renderPanelWithScene({
      ...makeScene(),
      meta: { ...makeScene().meta, paceTier: 'slow' },
    });

    const textarea = screen.getByLabelText('顺序铺排整段文本');
    fireEvent.change(textarea, { target: { value: '你好。' } });

    expect(screen.getByText(/追加预览/)).toBeTruthy();
    expect(screen.getByText(/1 句对白 · 预计 2\.8s/)).toBeTruthy();
    expect(screen.getByText(/从 3\.0s 开始/)).toBeTruthy();
  });
});
