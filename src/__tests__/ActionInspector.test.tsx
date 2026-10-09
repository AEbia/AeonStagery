/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionInspector } from '../ui/timeline/ActionInspector';

const testState = vi.hoisted(() => {
  const semanticDocument = {
    schemaVersion: 4 as const,
    sceneId: 'scene_1',
    meta: {
      title: 'Inspector model loading',
      characters: [{ id: 'sakiko', name: 'Sakiko', model: 'models/sakiko.model3.json' }],
    },
    statements: [{
      id: 'dialogue_1',
      time: 1,
      type: 'dialogue' as const,
      params: { speakerId: 'sakiko', text: 'hello', durationSeconds: 1 },
    }],
  };

  const getModelDataFromPath = vi.fn(async () => ({ motions: ['idle'], expressions: ['smile'] }));
  const prepareDialogueStyle = vi.fn(async () => ({}));
  return {
    semanticDocument: semanticDocument as any,
    defaultSemanticDocument: semanticDocument,
    compiledScene: null as any,
    currentProject: null as any,
    prepareDialogueStyle,
    getModelDataFromPath,
    semanticAuthoring: { author: vi.fn(async () => ({ createdStatementIds: ['created-dependency'] })) },
    playbackAdapter: {
      getCurrentTime: vi.fn(() => 4),
      seek: vi.fn(),
      subscribeTime: vi.fn(() => () => {}),
    },
    characterAdapter: {
      getModelDataFromPath,
      playMotion: vi.fn(),
      stopAllMotions: vi.fn(),
      setExpression: vi.fn(),
    },
  };
});

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: { editor: { setCopyBuffer: vi.fn() } },
    services: {
      semanticAuthoring: testState.semanticAuthoring,
      projectWorkspace: {
        getCurrentProject: () => testState.currentProject,
        prepareDialogueStyle: testState.prepareDialogueStyle,
      },
      templatePackages: {
        getSummaries: () => [{
          id: 'aeonstagery.default',
          name: 'AeonStagery Default Templates',
          version: '2.0.0',
          scope: 'builtin',
          dialogueStyles: [
            { id: 'glass', name: 'Premium Glass', renderer: 'glass' },
            { id: 'minimal', name: 'Minimal', renderer: 'minimal' },
            { id: 'classic', name: 'Classic', renderer: 'classic' },
          ],
        }, {
          id: 'webgal.mygo.v3_1_0.portable',
          name: 'MyGO Portable',
          version: '3.1.0',
          scope: 'community',
          dialogueStyles: [{ id: 'mygo.static.v3_1_1', name: 'MyGO v3.1.1 Static', renderer: 'image-dialogue-v1' }],
        }],
      },
    },
  }),
  useCharacterAdapter: () => testState.characterAdapter,
  useCollaborationPresence: () => ({ peers: [] }),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => testState.semanticDocument,
    getCompiledSceneSnapshot: () => testState.compiledScene,
  }),
  usePlaybackAdapter: () => testState.playbackAdapter,
  useSceneAssetService: () => undefined,
  useResourceAuthoringService: () => undefined,
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: testState.semanticDocument, filePath: null }),
  useValidationIssues: () => ({ issues: [], loading: false }),
  useCustomMotionEditorActionId: () => null,
}));

describe('ActionInspector', () => {
  beforeEach(() => {
    testState.semanticDocument = testState.defaultSemanticDocument;
    testState.compiledScene = null;
    testState.currentProject = null;
    testState.prepareDialogueStyle.mockReset();
    testState.semanticAuthoring.author.mockClear();
    testState.playbackAdapter.getCurrentTime.mockReturnValue(4);
  });

  it('loads model metadata only once when its own state updates', async () => {
    testState.getModelDataFromPath.mockClear();

    render(
      <ActionInspector
        sceneData={{
          sceneId: 'scene_1',
          meta: testState.semanticDocument.meta,
          timeline: [],
        }}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(testState.getModelDataFromPath).toHaveBeenCalledWith('models/sakiko.model3.json');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(testState.getModelDataFromPath).toHaveBeenCalledTimes(1);
  });

  it('adds a lifecycle target dependency for the selected start statement at the playhead', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: {
        title: 'Inspector dependency command',
        durationSeconds: 10,
        characters: [{ id: 'sakiko', name: 'Sakiko', model: 'models/sakiko.model3.json' }],
      },
      statements: [
        { id: 'enter_sakiko', time: 1, type: 'characterPresence', params: { mode: 'enter', id: 'sakiko' } },
        { id: 'exit_sakiko', time: 8, type: 'characterPresence', params: { mode: 'exit', id: 'sakiko' } },
      ],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ enter_sakiko: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '添加角色变换' }));

    await waitFor(() => expect(testState.semanticAuthoring.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      anchorTime: 4,
      statement: expect.objectContaining({
        type: 'characterTransform',
        params: expect.objectContaining({ id: 'sakiko', durationSeconds: 1 }),
      }),
    })));
  });

  it('inspects ordinary statements without StateSpan aggregate UI', () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: { title: 'Inspector ordinary statement', durationSeconds: 20 },
      statements: [
        {
          id: 'enter_sakiko',
          time: 2,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'sakiko', durationSeconds: 0.5 },
        },
        {
          id: 'exit_sakiko',
          time: 8,
          type: 'characterPresence',
          params: { mode: 'exit', id: 'sakiko', durationSeconds: 1 },
        },
      ],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [
        {
          id: 'compiled_enter_sakiko',
          time: 2,
          action: 'addCharacter',
          params: { id: 'sakiko', duration: 0.5 },
          source: { statementId: 'enter_sakiko', outputKey: 'primary' },
        },
        {
          id: 'compiled_exit_sakiko',
          time: 8,
          action: 'removeCharacter',
          params: { id: 'sakiko', duration: 1 },
          source: { statementId: 'exit_sakiko', outputKey: 'primary' },
        },
      ],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_enter_sakiko: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const root = document.querySelector('.selected-action-inspector');
    expect(root?.getAttribute('data-state-span-view')).toBeNull();
    expect(screen.queryByTestId('state-span-lifecycle-summary')).toBeNull();
    expect(screen.queryByTestId('state-span-transition-controls')).toBeNull();
    expect(screen.queryByTestId('state-span-derived-end-inspector')).toBeNull();
  });

  it('offers narrator binding and saves it without a speaker', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: {
        title: 'Speakerless narrator',
        durationSeconds: 20,
        characters: [{ id: 'sakiko', name: 'Sakiko', model: 'models/sakiko.model3.json' }],
      },
      statements: [{
        id: 'narration_1',
        time: 2,
        type: 'dialogue',
        params: { speakerId: 'sakiko', speaker: 'Sakiko', text: '旁白原文', durationSeconds: 2 },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_narration_1',
        id: 'compiled_narration_1',
        time: 2,
        action: 'dialogue',
        params: { speakerId: 'sakiko', speaker: 'Sakiko', text: '旁白原文', duration: 2 },
        source: { statementId: 'narration_1', outputKey: 'primary' },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_narration_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('action-param-speakerId')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('action-param-speakerId'));
    });
    expect(screen.getByRole('option', { name: '旁白' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: '旁白' }));
    });

    expect(replaceSourceParams).toHaveBeenCalledWith('compiled_narration_1', {
      text: '旁白原文',
      durationSeconds: 2,
    });
    expect(testState.semanticAuthoring.author).not.toHaveBeenCalled();
  });

  it('applies the project image dialogue style to an existing dialogue', async () => {
    const presentation = {
      renderer: 'image-dialogue-v1',
      textbox: { image: 'images/templates/mygo/textbox.svg', x: 120, y: 792, width: 1680, height: 248 },
      namebox: { image: 'images/templates/mygo/namebox.svg', x: 150, y: 714, width: 430, height: 90 },
      text: { x: 176, y: 830, maxWidth: 1510, fontFamily: 'MyGO JiangCheng' },
    };
    testState.currentProject = {
      metadata: {
        templates: {
          enabledTemplateIds: ['webgal.mygo.v3_1_0.portable'],
          defaults: { dialogueStyleId: 'mygo.static.v3_1_1' },
          dialoguePresentation: presentation,
        },
      },
    };
    testState.prepareDialogueStyle.mockResolvedValue({ dialoguePresentation: presentation });
    testState.semanticDocument = {
      schemaVersion: 3,
      sceneId: 'scene_1',
      meta: { title: 'Dialogue style', durationSeconds: 20 },
      statements: [{
        id: 'dialogue_1',
        time: 2,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 2, template: 'glass' },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('对话框样式'));
    fireEvent.click(screen.getByRole('option', { name: /MyGO v3\.1\.1 Static/ }));

    await waitFor(() => expect(replaceSourceParams).toHaveBeenCalledWith('dialogue_1', {
      text: 'hello',
      durationSeconds: 2,
      presentation,
    }));
  });

  it('clears an image presentation when switching an existing dialogue to a built-in style', () => {
    const presentation = {
      renderer: 'image-dialogue-v1',
      textbox: { image: 'images/templates/mygo/textbox.svg', x: 120, y: 792, width: 1680, height: 248 },
      text: { x: 176, y: 830, maxWidth: 1510 },
    };
    testState.currentProject = {
      metadata: {
        templates: {
          enabledTemplateIds: ['webgal.mygo.v3_1_0.portable'],
          defaults: { dialogueStyleId: 'mygo.static.v3_1_1' },
          dialoguePresentation: presentation,
        },
      },
    };
    testState.semanticDocument = {
      schemaVersion: 3,
      sceneId: 'scene_1',
      meta: { title: 'Dialogue style', durationSeconds: 20 },
      statements: [{
        id: 'dialogue_1',
        time: 2,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 2, presentation },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('对话框样式'));
    fireEvent.click(screen.getByRole('option', { name: /经典/ }));

    expect(replaceSourceParams).toHaveBeenCalledWith('dialogue_1', {
      text: 'hello',
      durationSeconds: 2,
      template: 'classic',
    });
  });

  it('shows the dialogue box style control when a dialogue has no stored style fields', () => {
    testState.semanticDocument = {
      schemaVersion: 3,
      sceneId: 'scene_1',
      meta: { title: 'Dialogue without style fields', durationSeconds: 20 },
      statements: [{
        id: 'dialogue_without_style',
        time: 2,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 2 },
      }],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ dialogue_without_style: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('对话框样式')).toBeTruthy();
  });

  it('lists and materializes an enabled template dialogue style directly from the Inspector', async () => {
    const presentation = {
      renderer: 'image-dialogue-v1',
      styleId: 'mygo.static.v3_1_1',
      textbox: { image: 'images/templates/mygo/textbox.svg', x: 120, y: 792, width: 1680, height: 248 },
      text: { x: 176, y: 830, maxWidth: 1510 },
    };
    testState.currentProject = {
      metadata: {
        templates: {
          enabledTemplateIds: ['webgal.mygo.v3_1_0.portable'],
          defaults: { dialogueStyleId: 'glass' },
        },
      },
    };
    testState.prepareDialogueStyle.mockResolvedValue({ dialoguePresentation: presentation });
    testState.semanticDocument = {
      schemaVersion: 3,
      sceneId: 'scene_1',
      meta: { title: 'Direct template style', durationSeconds: 20 },
      statements: [{
        id: 'dialogue_1',
        time: 2,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 2 },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('对话框样式'));
    expect(screen.getByRole('option', { name: 'MyGO v3.1.1 Static' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /MyGO Portable/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'MyGO v3.1.1 Static' }));

    await waitFor(() => expect(testState.prepareDialogueStyle).toHaveBeenCalledWith('mygo.static.v3_1_1'));
    expect(replaceSourceParams).toHaveBeenCalledWith('dialogue_1', {
      text: 'hello',
      durationSeconds: 2,
      presentation,
    });
  });

  it('does not duplicate built-in dialogue styles from enabled template manifests', () => {
    testState.currentProject = {
      metadata: {
        templates: {
          enabledTemplateIds: ['aeonstagery.default', 'webgal.mygo.v3_1_0.portable'],
          defaults: { dialogueStyleId: 'glass' },
        },
      },
    };
    testState.semanticDocument = {
      schemaVersion: 3,
      sceneId: 'scene_1',
      meta: { title: 'No duplicate built-ins', durationSeconds: 20 },
      statements: [{
        id: 'dialogue_1',
        time: 2,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 2 },
      }],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('对话框样式'));
    expect(screen.getAllByRole('option', { name: /玻璃/ })).toHaveLength(1);
    expect(screen.getAllByRole('option', { name: /极简/ })).toHaveLength(1);
    expect(screen.getAllByRole('option', { name: /经典/ })).toHaveLength(1);
    expect(screen.queryByRole('option', { name: 'Premium Glass' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Minimal' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Classic' })).toBeNull();
  });

  it('does not expose internal presentation asset paths as Inspector fields', () => {
    const presentation = {
      renderer: 'image-dialogue-v1',
      styleId: 'mygo.static.v3_1_1',
      textbox: { image: 'images/templates/mygo/textbox.svg', x: 120, y: 792, width: 1680, height: 248 },
      namebox: { image: 'images/templates/mygo/namebox.svg', x: 150, y: 714, width: 430, height: 90 },
      text: { fontFile: 'images/templates/mygo/dialogue.ttf', x: 176, y: 830, maxWidth: 1510 },
    };
    testState.semanticDocument = {
      schemaVersion: 3,
      sceneId: 'scene_1',
      meta: { title: 'Internal presentation fields', durationSeconds: 20 },
      statements: [{
        id: 'dialogue_1',
        time: 2,
        type: 'dialogue',
        params: { text: 'hello', durationSeconds: 2, presentation },
      }],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('presentation.textbox.image')).toBeNull();
    expect(screen.queryByText('presentation.namebox.image')).toBeNull();
    expect(screen.queryByText('presentation.text.fontFile')).toBeNull();
  });

  function renderPlayMotionInspector(motion: string) {
    testState.getModelDataFromPath.mockResolvedValue({ motions: ['idle', 'wave'], expressions: [] });
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: {
        title: 'Motion preview',
        durationSeconds: 20,
        characters: [{ id: 'sakiko', name: 'Sakiko', model: 'models/sakiko.model3.json' }],
      },
      statements: [{
        id: 'motion_1',
        time: 2,
        type: 'characterPerformance',
        params: { target: 'sakiko', motion: { kind: 'resource', key: motion } },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_motion_1',
        id: 'compiled_motion_1',
        time: 2,
        action: 'playMotion',
        params: { id: 'sakiko', motion },
        source: { statementId: 'motion_1', outputKey: 'motion' },
      }],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_motion_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it('does not play a motion while the option list is hovered', async () => {
    testState.characterAdapter.playMotion.mockClear();
    renderPlayMotionInspector('idle');

    await waitFor(() => expect(screen.getByTestId('action-param-motion')).toBeTruthy());
    fireEvent.click(screen.getByTestId('action-param-motion'));

    fireEvent.mouseEnter(screen.getByRole('option', { name: 'wave' }));
    fireEvent.mouseLeave(screen.getByRole('listbox', { name: '可选项' }));

    expect(testState.characterAdapter.playMotion).not.toHaveBeenCalled();
  });

  it('previews a motion from the row play button and restores the committed motion on leave', async () => {
    testState.characterAdapter.playMotion.mockClear();
    renderPlayMotionInspector('idle');

    await waitFor(() => expect(screen.getByTestId('action-param-motion')).toBeTruthy());
    fireEvent.click(screen.getByTestId('action-param-motion'));

    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    expect(testState.characterAdapter.playMotion).toHaveBeenLastCalledWith('sakiko', 'wave');

    fireEvent.mouseLeave(screen.getByRole('listbox', { name: '可选项' }));
    expect(testState.characterAdapter.playMotion).toHaveBeenLastCalledWith('sakiko', 'idle');
  });

  it('stops all motions when restoring an empty committed motion after a row preview', async () => {
    testState.characterAdapter.playMotion.mockClear();
    testState.characterAdapter.stopAllMotions.mockClear();
    renderPlayMotionInspector('');

    await waitFor(() => expect(screen.getByTestId('action-param-motion')).toBeTruthy());
    fireEvent.click(screen.getByTestId('action-param-motion'));

    fireEvent.click(screen.getByRole('button', { name: '预览 wave' }));
    expect(testState.characterAdapter.playMotion).toHaveBeenLastCalledWith('sakiko', 'wave');

    fireEvent.mouseLeave(screen.getByRole('listbox', { name: '可选项' }));
    expect(testState.characterAdapter.stopAllMotions).toHaveBeenCalledWith('sakiko');
    expect(testState.characterAdapter.playMotion).toHaveBeenCalledTimes(1);
  });

  it('does not offer narrator option for character action id select', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: {
        title: 'Character action id',
        durationSeconds: 20,
        characters: [{ id: 'sakiko', name: 'Sakiko', model: 'models/sakiko.model3.json' }],
      },
      statements: [{
        id: 'transform_1',
        time: 2,
        type: 'characterTransform',
        params: { id: 'sakiko', durationSeconds: 1 },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_transform_1',
        id: 'compiled_transform_1',
        time: 2,
        action: 'transformCharacter',
        params: { id: 'sakiko', duration: 1 },
        source: { statementId: 'transform_1', outputKey: 'primary' },
      }],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_transform_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const idSelect = screen.getByTestId('action-param-id');
    expect(idSelect).toBeTruthy();
    await act(async () => {
      fireEvent.click(idSelect);
    });

    expect(screen.queryByRole('option', { name: '旁白' })).toBeNull();
    expect(screen.getByRole('option', { name: /Sakiko/ })).toBeTruthy();
  });

  it('updates semantic source params when changing transition on character presence', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: {
        title: 'Presence transition',
        durationSeconds: 20,
        characters: [{ id: 'sakiko', name: 'Sakiko', model: 'models/sakiko.model3.json' }],
      },
      statements: [{
        id: 'enter_1',
        time: 2,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'sakiko', transition: 'none' },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_enter_1',
        id: 'compiled_enter_1',
        time: 2,
        action: 'addCharacter',
        params: { id: 'sakiko', enter: 'none' },
        semanticType: 'characterPresence',
        sourceParams: { mode: 'enter', id: 'sakiko', transition: 'none' },
        source: { statementId: 'enter_1', outputKey: 'primary' },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_enter_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const transitionSelect = screen.getByText(/无 \(立即出现\)/);
    expect(transitionSelect).toBeTruthy();
    await act(async () => {
      fireEvent.click(transitionSelect);
    });
    const fadeInOption = screen.getByRole('option', { name: /淡入/ });
    await act(async () => {
      fireEvent.click(fadeInOption);
    });

    expect(replaceSourceParams).toHaveBeenCalledWith('compiled_enter_1', {
      mode: 'enter',
      id: 'sakiko',
      transition: 'fadeIn',
    });
  });

  it('persists environment layer label when creating or updating an environment layer', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: { title: 'Env layer test', durationSeconds: 20 },
      statements: [{
        id: 'env_1',
        time: 2,
        type: 'environmentLayer',
        params: { layerId: 'background' },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_env_1',
        id: 'compiled_env_1',
        time: 2,
        action: 'setEnvironmentLayer',
        params: { layerId: 'background' },
        source: { statementId: 'env_1', outputKey: 'primary' },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_env_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('环境层名称');
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '夕阳天空' } });
    fireEvent.blur(input);

    expect(replaceSourceParams).toHaveBeenCalledWith('compiled_env_1', {
      layerId: 'environment-layer-1',
      label: '夕阳天空',
    });
  });

  it('clears label when switching an environment layer back to background', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: { title: 'Env layer clear test', durationSeconds: 20 },
      statements: [{
        id: 'env_1',
        time: 2,
        type: 'environmentLayer',
        params: { layerId: 'custom-sky', label: '夕阳天空' },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_env_1',
        id: 'compiled_env_1',
        time: 2,
        action: 'setEnvironmentLayer',
        params: { layerId: 'custom-sky', label: '夕阳天空' },
        source: { statementId: 'env_1', outputKey: 'primary' },
      }],
    };

    const replaceSourceParams = vi.fn();
    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: testState.compiledScene.actions as any }}
        selectedActionIds={{ compiled_env_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={replaceSourceParams}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByLabelText('环境层名称') as HTMLInputElement;
    expect(input.value).toBe('夕阳天空');
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '背景' } });
    fireEvent.blur(input);

    expect(replaceSourceParams).toHaveBeenCalledWith('compiled_env_1', {
      layerId: 'background',
    });
  });

  it('displays custom ease on camera path keyframe as a custom option', async () => {
    testState.semanticDocument = {
      schemaVersion: 4,
      sceneId: 'scene_1',
      meta: { title: 'Camera path custom ease', durationSeconds: 20 },
      statements: [{
        id: 'cam_path_1',
        time: 2,
        type: 'camera',
        params: {
          mode: 'path',
          keyframes: [
            { time: 0, position: [0, 0], zoom: 1, rotation: 0 },
            { time: 1, position: [0.5, 0.5], zoom: 1.2, rotation: 0, ease: 'power4.inOut' },
          ],
        },
      }],
    };
    testState.compiledScene = {
      sceneId: 'scene_1',
      meta: testState.semanticDocument.meta,
      actions: [{
        _id: 'compiled_cam_path_1',
        id: 'compiled_cam_path_1',
        time: 2,
        action: 'cameraPath',
        params: {
          keyframes: [
            { time: 0, position: [0, 0], zoom: 1, rotation: 0 },
            { time: 1, position: [0.5, 0.5], zoom: 1.2, rotation: 0, ease: 'power4.inOut' },
          ],
        },
        source: { statementId: 'cam_path_1', outputKey: 'primary' },
      }],
    };

    render(
      <ActionInspector
        sceneData={{ sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] }}
        selectedActionIds={{ compiled_cam_path_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={vi.fn()}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('power4.inOut (自定义)')).toBeTruthy();
  });

  it('renders the action header only in the docked panel, not in script-action priority', async () => {
    const props = {
      sceneData: { sceneId: 'scene_1', meta: testState.semanticDocument.meta, timeline: [] },
      selectedActionIds: { dialogue_1: true },
      setSelectedIds: vi.fn(),
      updateAction: vi.fn(),
      updateParam: vi.fn(),
      replaceSourceParams: vi.fn(),
      deleteAction: vi.fn(),
      onClose: vi.fn(),
    };

    const panel = render(<ActionInspector {...props} />);
    expect(panel.container.querySelector('.selected-action-header')).toBeTruthy();
    await act(async () => { panel.unmount(); });

    const inline = render(<ActionInspector {...props} presentation="inline" closeMode="close" />);
    // 剧本动作优先模式：语句行本身已提供标题/时间/播放/删除，头部不再渲染。
    expect(inline.container.querySelector('.selected-action-header')).toBeNull();
    // The property form still expands under the statement row.
    expect(inline.container.querySelector('.selected-action-inspector__content')).toBeTruthy();
    await act(async () => { inline.unmount(); });
  });
});
