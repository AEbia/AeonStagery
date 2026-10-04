/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import AiScriptSegmentPanel from '../ui/AiScriptSegmentPanel';
import { AUTHORING_SCHEMA_VERSION, type SemanticAuthorReceipt } from '../api/types/authoring';
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
    statements: [],
  };
}

function renderPanel() {
  const documentStore = new DocumentStore();
  const editorStore = new EditorStore();
  const playbackStore = new PlaybackStore();
  const validationStore = new ValidationStore();
  documentStore._replaceCurrentSceneDocumentSnapshot(makeScene());

  const receipt: SemanticAuthorReceipt = {
    version: AUTHORING_SCHEMA_VERSION,
    correlationId: 'intent_ai_1',
    intentType: 'insert-script-segment',
    origin: 'ai-script-panel',
    historyDescriptor: { key: 'timeline.author.insertScriptSegment', args: { count: 1 }, fallbackLabel: 'AI 铺戏' },
    warnings: [],
    resolvedScope: { kind: 'none' },
    createdStatementIds: ['stmt_1'],
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
    timeRange: { start: 3.2, end: 5.4 },
  };
  const authorAiScriptSegment = vi.fn(async () => ({ document: makeScene(), receipt, issues: [] }));
  const select = vi.fn((ids: Record<string, boolean>) => editorStore._setSelectedIds(ids));

  render(
    <AppProvider
      adapters={{
        playback: {
          getCurrentTime: () => 3.2,
          subscribeTime: () => () => {},
        } as any,
        camera: {} as any,
        character: {} as any,
        stage: {} as any,
        timeline: {
          select,
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
        semanticAuthoring: {
          authorAiScriptSegment,
        } as any,
      }}
    >
      <AiScriptSegmentPanel apiKey="test-key" baseUrl="https://api.openai.com/v1/chat/completions" modelName="gpt-4o" />
    </AppProvider>,
  );

  return { authorAiScriptSegment, select };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('AiScriptSegmentPanel', () => {
  it('generates a structured preview and applies it through the AI authoring origin', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              version: 1,
              title: '练习室',
              summary: '灯说出自己的想法。',
              unresolvedNames: [],
              notes: [],
              steps: [
                { kind: 'dialogue', characterId: 'tomori', text: '我想继续唱下去。', pace: 'normal', position: null, label: null, markerRole: null },
              ],
            }),
          },
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { authorAiScriptSegment, select } = renderPanel();

    fireEvent.change(screen.getByLabelText('文本原案'), {
      target: { value: '灯：我想继续唱下去。' },
    });
    fireEvent.click(screen.getByText('生成预览'));

    expect(await screen.findByText('练习室')).toBeTruthy();
    expect(screen.getByText(/1 语义语句/)).toBeTruthy();

    const firstFetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(firstFetchCall[1].body));
    expect(requestBody.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
    }));

    fireEvent.click(screen.getByText('应用到当前时间'));

    await waitFor(() => expect(authorAiScriptSegment).toHaveBeenCalledTimes(1));
    const firstAuthorCall = authorAiScriptSegment.mock.calls[0] as unknown as [any, number, string, any];
    expect(firstAuthorCall[0]).toEqual(expect.objectContaining({
      statements: [
        expect.objectContaining({
          type: 'dialogue',
          params: expect.objectContaining({ speakerId: 'tomori' }),
        }),
      ],
    }));
    expect(firstAuthorCall[1]).toBe(3.2);
    expect(firstAuthorCall[3]).toEqual(expect.objectContaining({ origin: 'ai-script-panel' }));
    expect(select).toHaveBeenCalledWith({});
  });
});
