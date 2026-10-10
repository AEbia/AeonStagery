/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionInspector } from '../ui/timeline/ActionInspector';
import {
  getSemanticInspectorFields,
  materializeSemanticInspectorParams,
  SEMANTIC_INSPECTOR_FIELD_CATALOG,
} from '../ui/timeline/semanticInspectorFieldCatalog';
import type { StatementFamily } from '../api/types/semantic-scene';

const state = vi.hoisted(() => ({
  document: null as any,
  pickedAssetPath: "",
  compiledScene: null as any,
  characterAdapter: {
    getModelDataFromPath: vi.fn(async () => ({ motions: [], expressions: [] })),
    playMotion: vi.fn(),
    setExpression: vi.fn(),
  },
  semanticAuthoring: { author: vi.fn(async () => ({})) },
  playbackAdapter: {
    getCurrentTime: vi.fn(() => 0),
    seek: vi.fn(),
    subscribeTime: vi.fn(() => () => {}),
  },
  sceneAssetService: {
    importAssetPath: vi.fn(async (sourcePath: string) => sourcePath),
  },
}));

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    stores: { editor: { setCopyBuffer: vi.fn() } },
    services: { semanticAuthoring: state.semanticAuthoring },
  }),
  useCharacterAdapter: () => state.characterAdapter,
  useCollaborationPresence: () => ({ peers: [] }),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => state.document,
    getCompiledSceneSnapshot: () => state.compiledScene,
  }),
  usePlaybackAdapter: () => state.playbackAdapter,
  useSceneAssetService: () => state.sceneAssetService,
}));

vi.mock('../ui/AssetBrowserModal', () => ({
  AssetBrowserModal: ({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="资源浏览器">
      <button onClick={() => { onSelect(state.pickedAssetPath); onClose(); }}>使用选中资源</button>
    </div>
  ),
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: state.document, filePath: null }),
  useValidationIssues: () => ({ issues: [], loading: false }),
  useCustomMotionEditorActionId: () => null,
}));

const FAMILIES: readonly StatementFamily[] = [
  'dialogue',
  'dialogueVisibility',
  'characterPresence',
  'characterTransform',
  'characterPerformance',
  'camera',
  'environmentLayer',
  'filterAdd',
  'filterChange',
  'filterReset',
  'visualStyle',
  'lighting',
  'audio',
  'graphicLayer',
  'customAnimation',
];

function baseDocument(statement: any): any {
  return {
    schemaVersion: 4,
    sceneId: 'semantic-inspector-catalog',
    meta: {
      title: 'Semantic Inspector catalog',
      characters: [{ id: 'hero', name: 'Hero', model: 'figure/hero/model.json' }],
    },
    statements: [statement],
  };
}

function renderInspector(statement: any, compiledAction: any) {
  const document = baseDocument(statement);
  state.document = document;
  state.compiledScene = {
    sceneId: document.sceneId,
    meta: document.meta,
    actions: [compiledAction],
  };
  const updateParam = vi.fn();
  const replaceSourceParams = vi.fn();

  render(
    <ActionInspector
      sceneData={{ sceneId: document.sceneId, meta: document.meta, timeline: [] }}
      selectedActionIds={{ [compiledAction.id]: true }}
      setSelectedIds={vi.fn()}
      updateAction={vi.fn()}
      updateParam={updateParam}
      replaceSourceParams={replaceSourceParams}
      deleteAction={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  return { updateParam, replaceSourceParams };
}

describe('semantic Inspector field catalog contracts', () => {
  beforeEach(() => {
    state.document = null;
    state.compiledScene = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('covers exactly the current semantic families without legacy statement types', () => {
    expect(Object.keys(SEMANTIC_INSPECTOR_FIELD_CATALOG).sort()).toEqual([...FAMILIES].sort());
    expect(Object.keys(SEMANTIC_INSPECTOR_FIELD_CATALOG)).not.toContain('wait');
    expect(Object.keys(SEMANTIC_INSPECTOR_FIELD_CATALOG)).not.toContain('custom');
  });

  it.each([false, true])('edits only the subtitle transition duration while preserving visible=%s', (visible) => {
    const statement = {
      id: 'subtitle_visibility', time: 1, type: 'dialogueVisibility', params: { visible, durationSeconds: 0.3 },
    };
    const actionId = 'subtitle_visibility::primary';
    const { updateParam } = renderInspector(statement, {
      id: actionId, time: 1, action: 'setDialogueVisibility', params: { visible, duration: 0.3 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });
    expect(screen.queryByRole('checkbox', { name: '显示字幕框' })).toBeNull();
    expect(getSemanticInspectorFields('dialogueVisibility', statement.params).map((field) => field.key)).toEqual(['durationSeconds']);
    const duration = screen.getByRole('spinbutton', { name: '过渡时长' });
    fireEvent.keyDown(duration, { key: 'ArrowUp' });
    expect(updateParam).toHaveBeenCalledWith(actionId, 'durationSeconds', 0.4, false);
  });

  it('marks raw layer and audio identity fields as advanced while keeping semantic selectors authoring-facing', () => {
    const graphicId = getSemanticInspectorFields('graphicLayer', { kind: 'image', mode: 'set' })
      .find((field) => field.key === 'id');
    const audioInstanceId = getSemanticInspectorFields('audio', { role: 'sfx', mode: 'play' })
      .find((field) => field.key === 'instanceId');
    const visualSlot = getSemanticInspectorFields('visualStyle', { scope: 'object', target: 'hero', slot: 'integration', mode: 'set' })
      .find((field) => field.key === 'slot');
    const advancedOverride = getSemanticInspectorFields('visualStyle', { scope: 'object', target: 'hero', slot: 'integration', mode: 'set' })
      .find((field) => field.key === 'advancedOverride');

    expect(graphicId?.visibility).toBe('advanced');
    expect(audioInstanceId?.visibility).toBe('advanced');
    expect(visualSlot?.visibility).toBe('authoring');
    expect(visualSlot?.surface).toBe('semantic');
    expect(advancedOverride?.visibility).toBe('advanced');
  });

  it('keeps integration-only color controls out of lens and non-integration visual slots', () => {
    const atmosphereKeys = getSemanticInspectorFields('filterAdd', {
      recipeId: 'builtin:haze-godray',
    }).map((field) => field.key);
    const groundingKeys = getSemanticInspectorFields('visualStyle', {
      scope: 'object',
      slot: 'grounding',
      mode: 'set',
    }).map((field) => field.key);
    const integrationKeys = getSemanticInspectorFields('visualStyle', {
      scope: 'object',
      slot: 'integration',
      mode: 'set',
    }).map((field) => field.key);

    expect(atmosphereKeys).not.toEqual(expect.arrayContaining(['colorStops', 'colorBlendMode', 'color']));
    expect(atmosphereKeys).toEqual(expect.arrayContaining(['intensity', 'warmth', 'bloom', 'blend', 'contamination', 'durationSeconds']));
    expect(atmosphereKeys).not.toContain('rgbSplit');
    expect(groundingKeys).not.toEqual(expect.arrayContaining(['colorStops', 'colorBlendMode', 'color']));
    expect(integrationKeys).toEqual(expect.arrayContaining(['color', 'colorStops', 'colorBlendMode']));
  });

  it('exposes brightness only for integration and defaults it to zero', () => {
    for (const slot of ['grounding', 'accent', 'distortion', 'rim-light']) {
      const fields = getSemanticInspectorFields('visualStyle', {
        scope: 'object',
        target: 'hero',
        slot,
        mode: 'set',
      }).map((field) => field.key);
      expect(fields).not.toContain('brightness');
    }

    const integrationFields = getSemanticInspectorFields('visualStyle', {
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'set',
    });
    expect(integrationFields.map((field) => field.key)).toContain('brightness');
    expect(materializeSemanticInspectorParams('visualStyle', {
      scope: 'object',
      target: 'hero',
      slot: 'integration',
      mode: 'set',
      recipeId: 'builtin:integration-soft',
    }).brightness).toBe(0);
  });

  it('keeps semantic visual and lighting fields legal for each fixed operation', () => {
    const groundingKeys = getSemanticInspectorFields('visualStyle', {
      scope: 'object', target: 'hero', slot: 'grounding', mode: 'modulate',
    }).map((field) => field.key);
    const distortionKeys = getSemanticInspectorFields('visualStyle', {
      scope: 'object', target: 'hero', slot: 'distortion', mode: 'modulate',
    }).map((field) => field.key);
    const rimLightKeys = getSemanticInspectorFields('visualStyle', {
      scope: 'object', target: 'hero', slot: 'rim-light', mode: 'modulate',
    }).map((field) => field.key);
    const visualResetKeys = getSemanticInspectorFields('visualStyle', {
      scope: 'object', target: 'hero', slot: 'integration', mode: 'reset',
    }).map((field) => field.key);
    const postKeys = getSemanticInspectorFields('lighting', { effect: 'post', mode: 'set' }).map((field) => field.key);
    const overlayRemoveKeys = getSemanticInspectorFields('lighting', { effect: 'overlay', mode: 'remove' }).map((field) => field.key);

    expect(groundingKeys).toEqual(expect.arrayContaining(['intensity', 'blend', 'contamination', 'durationSeconds']));
    expect(groundingKeys).not.toEqual(expect.arrayContaining(['color', 'colorStops', 'bloom', 'rgbSplit']));
    expect(distortionKeys).toEqual(expect.arrayContaining(['intensity', 'bloom', 'rgbSplit', 'durationSeconds']));
    expect(distortionKeys).not.toContain('colorStops');
    expect(rimLightKeys).toEqual(expect.arrayContaining(['intensity', 'color', 'thickness', 'angle', 'softness', 'durationSeconds']));
    expect(rimLightKeys).not.toEqual(expect.arrayContaining(['recipeId', 'bloom', 'rgbSplit']));
    expect(visualResetKeys).toEqual(['scope', 'target', 'slot', 'mode', 'durationSeconds']);
    expect(postKeys).toEqual(expect.arrayContaining([
      'target',
      'bloomThreshold', 'bloomBloomScale', 'bloomBrightness', 'rgbSplitX', 'rgbSplitY',
      'godrayGain', 'godrayLacunarity', 'godrayAngle', 'adjGamma', 'adjContrast',
      'adjSaturation', 'adjBrightness', 'adjRed', 'adjGreen', 'adjBlue',
      'overlayColor', 'overlayBlendMode', 'overlayIntensity', 'durationSeconds',
    ]));
    expect(materializeSemanticInspectorParams('lighting', { effect: 'post', mode: 'set' })).toMatchObject({
      target: 'panorama',
      overlayBlendMode: 'multiply',
      overlayIntensity: 0,
    });
    expect(overlayRemoveKeys).toEqual(['effect', 'mode', 'id', 'durationSeconds']);
  });

  it('keeps rim-light fields compiler-compatible and materializes typed defaults', () => {
    const rimLightParams = {
      scope: 'object',
      target: 'hero',
      slot: 'rim-light',
      mode: 'set',
    };
    const rimLightFields = getSemanticInspectorFields('visualStyle', rimLightParams);
    const rimLightKeys = rimLightFields.map((field) => field.key);
    const materialized = materializeSemanticInspectorParams('visualStyle', rimLightParams);

    expect(rimLightKeys).toEqual([
      'scope',
      'target',
      'slot',
      'mode',
      'intensity',
      'color',
      'thickness',
      'angle',
      'softness',
      'durationSeconds',
    ]);
    expect(rimLightFields.find((field) => field.key === 'intensity')?.valueType).toBe('number');
    expect(rimLightFields.find((field) => field.key === 'thickness')?.valueType).toBe('number');
    expect(rimLightFields.find((field) => field.key === 'angle')?.valueType).toBe('number');
    expect(rimLightFields.find((field) => field.key === 'softness')?.valueType).toBe('number');
    expect(materialized).toMatchObject({
      intensity: 1,
      color: '#ffffff',
      thickness: 10,
      angle: 45,
      softness: 2,
      durationSeconds: 0,
    });
    expect(materialized).not.toHaveProperty('recipeId');
    expect(materialized).not.toHaveProperty('warmth');
    expect(materialized).not.toHaveProperty('bloom');
    expect(materialized).not.toHaveProperty('rgbSplit');
    expect(materialized).not.toHaveProperty('blend');
    expect(materialized).not.toHaveProperty('contamination');
    expect(materialized).not.toHaveProperty('colorStops');
    expect(materialized).not.toHaveProperty('colorBlendMode');
  });

  it.each([
    ['dialogue', { text: '保留对白', durationSeconds: 3 }, 'voice', undefined],
    ['characterPresence', { mode: 'enter', id: 'hero' }, 'position', [0.5, 1]],
    ['characterTransform', { id: 'hero', position: [0.2, 0.7] }, 'ease', 'smooth'],
    ['characterPerformance', { target: 'hero', motion: 'idle' }, 'expression', undefined],
    ['camera', { mode: 'shake', intensity: 0.4 }, 'direction', 'both'],
    ['environmentLayer', { mode: 'remove', layerId: 'background' }, 'transition', 'fadeOut'],
    ['filterAdd', { recipeId: 'builtin:soft-bloom-rgb' }, 'intensity', 1],
    ['lighting', { effect: 'preset', mode: 'set' }, 'preset', 'warm'],
    ['audio', { role: 'bgm', mode: 'play', file: 'music/theme.ogg' }, 'volume', 1],
    ['graphicLayer', { kind: 'text', mode: 'set', id: 'title' }, 'fontSize', 36],
    ['customAnimation', { target: 'hero', file: 'animation/intro.html' }, 'loop', false],
  ] satisfies ReadonlyArray<readonly [StatementFamily, Record<string, unknown>, string, unknown]>) (
    'materializes the absent %s field from its current factory/schema contract',
    (family, sourceParams, absentKey, expectedDefault) => {
      const fields = getSemanticInspectorFields(family, sourceParams);
      const materialized = materializeSemanticInspectorParams(family, sourceParams);

      expect(fields.map((field) => field.key)).toContain(absentKey);
      expect(Object.prototype.hasOwnProperty.call(sourceParams, absentKey)).toBe(false);
      if (expectedDefault === undefined) {
        expect(Object.prototype.hasOwnProperty.call(materialized, absentKey)).toBe(false);
      } else {
        expect(materialized[absentKey]).toEqual(expectedDefault);
      }
    },
  );

  it('preserves authored values and does not mutate nested source values while materializing', () => {
    const sourceParams = {
      recipeId: 'builtin:soft-bloom-rgb',
      intensity: 0.91,
      colorStops: ['#112233', '#445566'],
    };

    const materialized = materializeSemanticInspectorParams('filterAdd', sourceParams);

    expect(materialized.intensity).toBe(0.91);
    expect(materialized.colorStops).toEqual(['#112233', '#445566']);
    expect(materialized.colorStops).not.toBe(sourceParams.colorStops);
    expect(sourceParams).toEqual({
      recipeId: 'builtin:soft-bloom-rgb',
      intensity: 0.91,
      colorStops: ['#112233', '#445566'],
    });
  });

  it('keeps camera move and graphic remove defaults within their current contracts', () => {
    const sparseCameraMove = materializeSemanticInspectorParams('camera', {
      mode: 'move',
      position: [0.5, 0.5],
    });
    const sparseGraphicRemove = materializeSemanticInspectorParams('graphicLayer', {
      kind: 'image',
      mode: 'remove',
      id: 'image-1',
    });
    const graphicSet = materializeSemanticInspectorParams('graphicLayer', {
      kind: 'image',
      mode: 'set',
      id: 'image-1',
    });

    expect(sparseCameraMove).not.toHaveProperty('zoom');
    expect(sparseGraphicRemove).not.toHaveProperty('position');
    expect(sparseGraphicRemove).not.toHaveProperty('scale');
    expect(graphicSet.position).toEqual([0.5, 0.5]);
    expect(graphicSet.scale).toBe(1);
  });

  it('exposes sparse SFX loop as a boolean control without adding a source default', () => {
    const sfxFields = getSemanticInspectorFields('audio', { role: 'sfx', mode: 'play' });
    const sfxLoop = sfxFields.find((field) => field.key === 'loop');
    const sparseSfx = materializeSemanticInspectorParams('audio', {
      role: 'sfx',
      mode: 'play',
      instanceId: 'sfx-1',
      file: 'sfx/click.ogg',
    });
    const bgm = materializeSemanticInspectorParams('audio', {
      role: 'bgm',
      mode: 'play',
      file: 'bgm/theme.ogg',
    });

    expect(sfxLoop?.valueType).toBe('boolean');
    expect(sparseSfx).not.toHaveProperty('loop');
    expect(bgm.loop).toBe(true);

    const statement = {
      id: 'sfx_sparse',
      time: 0,
      type: 'audio',
      params: {
        role: 'sfx',
        mode: 'play',
        instanceId: 'sfx-1',
        file: 'sfx/click.ogg',
      },
    };
    const actionId = 'sfx_sparse::primary';
    const { updateParam } = renderInspector(statement, {
      id: actionId,
      time: 0,
      action: 'playAudio',
      params: { id: 'sfx-1', file: 'sfx/click.ogg' },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    const loopCheckbox = screen.getByLabelText('循环播放') as HTMLInputElement;
    expect(loopCheckbox.checked).toBe(false);
    fireEvent.click(loopCheckbox);
    expect(updateParam).toHaveBeenCalledWith(actionId, 'loop', true);
  });

  it('does not expose timing or playback policy controls for character motions', () => {
    const statement = {
      id: 'character_motion',
      time: 0,
      type: 'characterPerformance',
      params: {
        target: 'hero',
        motion: 'idle',
        durationSeconds: 2,
        loop: true,
        priority: 3,
      },
    };
    renderInspector(statement, {
      id: 'character_motion::motion',
      time: 0,
      action: 'playMotion',
      params: {
        id: 'hero',
        motion: 'idle',
        duration: 2,
        loop: true,
        priority: 3,
      },
      source: { statementId: statement.id, outputKey: 'motion' },
    });

    expect(getSemanticInspectorFields('characterPerformance', statement.params).map((field) => field.key))
      .not.toEqual(expect.arrayContaining(['durationSeconds', 'priority', 'loop']));
    expect(screen.queryByText('时长')).toBeNull();
    expect(screen.queryByText('优先级')).toBeNull();
    expect(screen.queryByText('循环播放')).toBeNull();
  });

  it('also hides timing or playback policy controls for legacy playMotion actions', () => {
    const statement = {
      id: 'legacy_character_motion',
      time: 0,
      type: 'characterPerformance',
      params: { target: 'hero', motion: 'idle' },
    };
    renderInspector(statement, {
      id: 'legacy_character_motion::motion',
      time: 0,
      action: 'playMotion',
      params: {
        id: 'hero',
        motion: 'idle',
        duration: 2,
        durationSeconds: 2,
        loop: true,
        priority: 3,
      },
      source: { statementId: statement.id, outputKey: 'motion' },
    });

    expect(screen.queryByText('时长')).toBeNull();
    expect(screen.queryByText('优先级')).toBeNull();
    expect(screen.queryByText('循环播放')).toBeNull();
  });

  it('renders a catalog-only sparse transform control and keeps edits on the existing callback seam', () => {
    const statement = {
      id: 'transform_sparse',
      time: 0,
      type: 'characterTransform',
      params: { id: 'hero', position: [0.2, 0.7] },
    };
    const actionId = 'transform_sparse::primary';
    const { updateParam } = renderInspector(statement, {
      id: actionId,
      time: 0,
      action: 'transformCharacter',
      params: { id: 'hero', position: [0.2, 0.7] },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByText('缓动曲线')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '缓动曲线' }).textContent).toContain('三次缓入缓出');
    expect(screen.getByText('基础变换')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '缩放' }), { key: 'ArrowUp' });

    expect(updateParam).toHaveBeenCalledWith(actionId, 'scale', 1.05, false);
  });

  it('routes sparse custom animation resources through the animation picker and source seam', async () => {
    const statement = {
      id: 'custom_animation_sparse',
      time: 0,
      type: 'customAnimation',
      params: { target: 'hero', durationSeconds: 1 },
    };
    const actionId = 'custom_animation_sparse::primary';
    const { updateParam, replaceSourceParams } = renderInspector(statement, {
      id: actionId,
      time: 0,
      action: 'playCustomAnimation',
      params: { target: 'hero', duration: 1 },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.getByText('动画资源')).toBeTruthy();
    state.pickedAssetPath = 'animation/intro.html';
    fireEvent.click(screen.getByRole('button', { name: '动画资源' }));
    fireEvent.click(screen.getByRole('button', { name: '使用选中资源' }));

    await waitFor(() => {
      expect(replaceSourceParams).toHaveBeenCalledWith(actionId, {
        target: 'hero',
        durationSeconds: 1,
        animation: 'animation/intro.html',
      });
    });
    expect(updateParam).not.toHaveBeenCalledWith(actionId, 'animation', expect.anything());
  });

  it('keeps advancedOverride out of the ordinary visual authoring form', () => {
    const statement = {
      id: 'visual_advanced_override',
      time: 0,
      type: 'filterAdd',
      params: {
        recipeId: 'builtin:soft-bloom-rgb',
        advancedOverride: 'debug-only',
      },
    };

    renderInspector(statement, {
      id: 'visual_advanced_override::primary',
      time: 0,
      action: 'addLensFilter',
      params: { recipeId: 'builtin:soft-bloom-rgb', advancedOverride: 'debug-only' },
      source: { statementId: statement.id, outputKey: 'primary' },
    });

    expect(screen.queryByText('高级参数')).toBeNull();
  });

  it('omits motion and expression fields for pure character lookAt statements', () => {
    const params = {
      target: 'hero',
      lookAt: { point: [0.5, 0.5], intensity: 1, enabled: true },
    };
    const fields = getSemanticInspectorFields('characterPerformance', params).map((f) => f.key);
    expect(fields).toContain('target');
    expect(fields).toContain('lookAt');
    expect(fields).not.toContain('motion');
    expect(fields).not.toContain('expression');
    expect(fields).not.toContain('blink');
  });

  it('omits motion and expression fields for pure character blink statements', () => {
    const params = {
      target: 'hero',
      blink: { enabled: true, interval: 4 },
    };
    const fields = getSemanticInspectorFields('characterPerformance', params).map((f) => f.key);
    expect(fields).toContain('target');
    expect(fields).toContain('blink');
    expect(fields).not.toContain('motion');
    expect(fields).not.toContain('expression');
    expect(fields).not.toContain('lookAt');
  });

  it('hides motion/expression inputs and cross-control buttons when inspecting a pure lookAt statement', () => {
    const statement = {
      id: 'look_at_statement',
      time: 0,
      type: 'characterPerformance',
      params: {
        target: 'hero',
        lookAt: { point: [0.2, 0.3], intensity: 0.8, enabled: true },
      },
    };

    renderInspector(statement, {
      id: 'look_at_statement::lookAt',
      time: 0,
      action: 'characterLookAt',
      params: {
        id: 'hero',
        point: [0.2, 0.3],
        intensity: 0.8,
        enabled: true,
      },
      source: { statementId: statement.id, outputKey: 'lookAt' },
    });

    expect(screen.queryByText('动作名')).toBeNull();
    expect(screen.queryByText('表情名')).toBeNull();
    expect(screen.queryByText('视线控制')).not.toBeNull();
    expect(screen.queryByText('+ 添加眨眼控制')).toBeNull();
    expect(screen.queryByText('+ 添加视线控制')).toBeNull();
  });

  it('hides motion/expression inputs and cross-control buttons when inspecting a pure blink statement', () => {
    const statement = {
      id: 'blink_statement',
      time: 0,
      type: 'characterPerformance',
      params: {
        target: 'hero',
        blink: { enabled: true, interval: 4 },
      },
    };

    renderInspector(statement, {
      id: 'blink_statement::blink',
      time: 0,
      action: 'characterBlink',
      params: {
        id: 'hero',
        enabled: true,
        interval: 4,
      },
      source: { statementId: statement.id, outputKey: 'blink' },
    });

    expect(screen.queryByText('动作名')).toBeNull();
    expect(screen.queryByText('表情名')).toBeNull();
    expect(screen.queryByText('眨眼控制')).not.toBeNull();
    expect(screen.queryByText('+ 添加视线控制')).toBeNull();
    expect(screen.queryByText('+ 添加眨眼控制')).toBeNull();
  });
});
