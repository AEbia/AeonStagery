/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../ui/context/AppContext';
import { StatementBlockLibrary } from '../ui/StatementBlockLibrary';
import {
  createSemanticStatementDraftForBlock,
  createSemanticStatementDraftForResource,
  SEMANTIC_STATEMENT_BLOCKS,
} from '../ui/timeline/semanticStatementBlocks';
import { useBlankContextMenu } from '../ui/timeline/useBlankContextMenu';
import { useBlockContextMenu } from '../ui/timeline/useBlockContextMenu';
import { useTimelineDrop } from '../ui/timeline/useTimelineDrop';
import { StatementLibraryMenu } from '../ui/timeline/StatementLibraryMenu';

const offlineContext = {
  adapters: {},
  stores: {},
  services: { sceneFile: {} },
  collaboration: { status: 'offline', self: null, peers: [] },
} as any;

describe('Statement authoring entry points', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([false, true])('imports template drops before authoring and aborts failed copies (failure=%s)', async (failure) => {
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const importFile = failure
      ? vi.fn().mockRejectedValue(new Error('Missing template resource'))
      : vi.fn().mockResolvedValue('background/templates/demo/assets/background/room.png');
    vi.stubGlobal('AeonStagery', { services: { templateResourceFiles: { importFile } } });
    const area = document.createElement('div');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect);
    const context = { ...offlineContext, collaboration: { status: 'disconnected', self: null, peers: [] }, services: { ...offlineContext.services, semanticAuthoring: { author } } };
    const { result } = renderHook(() => useTimelineDrop({
      areaRef: { current: area }, trackRefs: { current: new Map() },
      sceneData: { sceneId: 'scene', meta: { title: 'Template drop' }, timeline: [] }, pps: 50,
    }), { wrapper: ({ children }) => <AppProvider {...context}>{children}</AppProvider> });
    const templateResource = { templateId: 'demo', packageRelativePath: 'assets/background/room.png' };
    await act(async () => {
      await result.current.handleDrop({
        preventDefault: vi.fn(), clientX: 100, clientY: 20,
        dataTransfer: { getData: () => JSON.stringify({ type: 'resource', sourceKind: 'background', sourcePath: '/templates/demo/assets/background/room.png', templateResource }) },
      } as any);
    });
    expect(importFile).toHaveBeenCalledWith(templateResource, '/templates/demo/assets/background/room.png', 'background');
    if (failure) expect(author).not.toHaveBeenCalled();
    else expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement', statement: expect.objectContaining({ params: expect.objectContaining({ file: 'background/templates/demo/assets/background/room.png' }) }),
    }));
  });

  it('shows lifecycle and dependency blocks when no context filter was supplied', () => {
    render(<StatementBlockLibrary />);

    expect(screen.getByRole('button', { name: '角色退场' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '角色变换' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '角色表情' })).toBeTruthy();
  });

  it('creates character performance statements for library entries', () => {
    const context = {
      sceneMeta: { title: 'Performance entries', characters: [{ id: 'hero', name: 'Hero' }] },
      charId: 'hero',
    };

    expect(createSemanticStatementDraftForBlock('character.performance.expression', context)).toEqual({
      type: 'characterPerformance',
      params: { target: 'hero', expression: 'smile' },
    });

    expect(createSemanticStatementDraftForBlock('character.performance.look-at', context)).toEqual({
      type: 'characterPerformance',
      params: {
        target: 'hero',
        lookAt: {
          point: [0, 0],
          intensity: 1,
          enabled: true,
        },
      },
    });

    expect(createSemanticStatementDraftForBlock('character.performance.blink', context)).toEqual({
      type: 'characterPerformance',
      params: {
        target: 'hero',
        blink: {
          enabled: true,
          interval: 4,
        },
      },
    });
  });

  it('keeps explicit empty availability sets as a real context filter', () => {
    render(
      <StatementBlockLibrary
        availableLifecycleEndCommandIds={new Set()}
        availableStateSpanDependencyCommandIds={new Set()}
      />,
    );

    expect(screen.queryByRole('button', { name: '角色退场' })).toBeNull();
    expect(screen.queryByRole('button', { name: '角色变换' })).toBeNull();
  });

  it('offers audio resource entry points that create editable placeholder statements', () => {
    const onSelectAction = vi.fn();
    render(<StatementBlockLibrary activeCategory="audio" onSelectAction={onSelectAction} />);

    const bgmButton = screen.getByTitle(/背景音乐 - /);
    const sfxButton = screen.getByTitle(/音效 - /);
    expect(bgmButton.getAttribute('title')).toContain('选择有效音频');
    expect(sfxButton.getAttribute('title')).toContain('选择有效音频');
    fireEvent.click(bgmButton);

    expect(onSelectAction).toHaveBeenCalledWith('statement', { blockId: 'audio.bgm' });
  });

  it('blocks statement insertion while collaboration is offline', () => {
    const onSelectAction = vi.fn();
    render(
      <AppProvider {...offlineContext}>
        <StatementBlockLibrary onSelectAction={onSelectAction} />
      </AppProvider>,
    );

    expect(screen.getByRole('status').textContent).toContain('重新加入后才能插入语句');
    fireEvent.click(screen.getByRole('button', { name: '对话' }));

    expect(onSelectAction).not.toHaveBeenCalled();
  });

  it('keeps the blank insertion menu free of descriptions and hidden modulation entries', () => {
    render(
      <StatementLibraryMenu
        menu={{ x: 20, y: 20, time: 1 }}
        onSelectAction={vi.fn()}
        dataTestId="statement-library-menu"
        ariaLabel="语句库菜单"
      />,
    );

    expect(document.querySelector('.statement-block-library--menu .statement-block-library__action-description')).toBeNull();
    expect(screen.queryByRole('button', { name: '角色明暗融入' })).toBeNull();
    expect(screen.queryByRole('button', { name: '角色明暗融入变化' })).toBeNull();
    expect(screen.queryByRole('button', { name: '角色色彩融入变化' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加色彩叠加' })).toBeNull();
    expect(screen.queryByRole('button', { name: '变化色彩叠加' })).toBeNull();
    expect(screen.getByRole('button', { name: '背景音乐' })).toBeTruthy();
  });

  it('allows resource statement drafts without a resource for inspector completion', () => {
    expect(createSemanticStatementDraftForBlock('environment.set-background', {})).toMatchObject({
      type: 'environmentLayer',
      params: { mode: 'set', file: '' },
    });
    expect(createSemanticStatementDraftForBlock('graphic.image', {})).toMatchObject({
      type: 'graphicLayer',
      params: {
        kind: 'image',
        mode: 'set',
        file: '',
      },
    });
    expect(createSemanticStatementDraftForResource({ filePath: '  ', sourceKind: 'figure' })).toMatchObject({
      type: 'characterPresence',
      params: { mode: 'enter', model: '' },
    });
    expect(createSemanticStatementDraftForResource({ filePath: '  ', sourceKind: 'vocal' })).toMatchObject({
      type: 'dialogue',
      params: { voice: '' },
    });
    expect(createSemanticStatementDraftForResource({ filePath: '  ', sourceKind: 'animation' })).toMatchObject({
      type: 'customAnimation',
      params: { file: '' },
    });
    expect(createSemanticStatementDraftForResource({ filePath: '  ', sourceKind: 'background' })).toMatchObject({
      type: 'environmentLayer',
      params: { mode: 'set', file: '' },
    });
    expect(createSemanticStatementDraftForResource({ filePath: '  ', sourceKind: 'images' })).toMatchObject({
      type: 'graphicLayer',
      params: { kind: 'image', mode: 'set', file: '' },
    });

    expect(createSemanticStatementDraftForBlock('environment.set-background', {
      filePath: 'D:\\project\\images\\background.png',
    })).toMatchObject({
      type: 'environmentLayer',
      params: {
        mode: 'set',
        file: 'D:/project/images/background.png',
      },
    });
  });

  it('maps the sfx resource directory to an audio statement', () => {
    expect(createSemanticStatementDraftForResource({
      filePath: 'sfx/click.ogg',
      sourceKind: 'sfx/subdir',
    })).toMatchObject({
      type: 'audio',
      params: { role: 'sfx', mode: 'play', file: 'sfx/click.ogg' },
    });
  });

  it('exposes each camera operation as an independent semantic entry point', () => {
    const input = {
      sceneMeta: { title: 'Camera entry points', characters: [{ id: 'hero', name: 'Hero' }] },
      charId: 'hero',
    };
    const cameraEntries = [
      ['camera.focus', 'focus'],
      ['camera.move', 'move'],
      ['camera.follow', 'follow'],
      ['camera.stop-follow', 'follow'],
      ['camera.path', 'path'],
      ['camera.shake', 'shake'],
      ['camera.reset', 'reset'],
    ] as const;

    const onSelectAction = vi.fn();
    render(<StatementBlockLibrary activeCategory="camera" onSelectAction={onSelectAction} />);
    for (const [blockId] of cameraEntries) {
      expect(document.querySelector(`[data-block-id="${blockId}"]`)).toBeTruthy();
    }
    expect(document.querySelector('[data-block-id="camera.hitchcock"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '停止镜头跟随' }));
    expect(onSelectAction).toHaveBeenCalledWith('statement', { blockId: 'camera.stop-follow' });

    for (const [blockId, mode] of cameraEntries) {
      const draft = createSemanticStatementDraftForBlock(blockId, input);
      expect(draft).toMatchObject({ type: 'camera', params: { mode } });
    }

    expect(createSemanticStatementDraftForBlock('camera.move', input)).toMatchObject({
      type: 'camera',
      params: {
        mode: 'move',
        to: [0.5, 0.5],
        zoom: { kind: 'absolute', value: 1 },
        rotation: 0,
      },
    });
    expect(createSemanticStatementDraftForBlock('camera.follow', input)).toMatchObject({
      type: 'camera',
      params: { operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0.85 },
    });
    expect(createSemanticStatementDraftForBlock('camera.stop-follow', input)).toMatchObject({
      type: 'camera',
      params: { mode: 'follow', operation: 'stop' },
    });
    expect(SEMANTIC_STATEMENT_BLOCKS.find((block) => block.id === 'camera.stop-follow')).toMatchObject({
      lifecycleEndCommand: { presentationTypeKey: 'camera:follow', match: 'unique-active' },
    });
    expect(createSemanticStatementDraftForBlock('camera.path', input)).toMatchObject({
      type: 'camera',
      params: {
        keyframes: expect.arrayContaining([
          expect.objectContaining({ time: 0 }),
          expect.objectContaining({ time: 1 }),
        ]),
      },
    });
    expect((createSemanticStatementDraftForBlock('camera.path', input) as any)?.params.keyframes).toHaveLength(2);
  });

  it('exposes fixed visual and lighting authoring entry combinations', () => {
    const input = { sceneMeta: { title: 'Entry points', characters: [{ id: 'hero', name: 'Hero' }] }, charId: 'hero' };

    render(<StatementBlockLibrary activeCategory="visual" search="角色边光" onSearchChange={vi.fn()} />);
    expect(document.querySelector('[data-block-id="visual.character-rim-light"]')).toBeTruthy();
    expect(document.querySelector('[data-block-id="visual.modulate-character-rim-light"]')).toBeNull();
    expect(document.querySelector('[data-block-id="visual.reset-character-rim-light"]')).toBeTruthy();

    expect(createSemanticStatementDraftForBlock('visual.character-integration', input)).toMatchObject({
      type: 'visualStyle',
      params: {
        scope: 'object', target: 'hero', slot: 'integration', mode: 'set',
        recipeId: 'builtin:integration-soft', intensity: 0.8, warmth: 0, blend: 0.36, contamination: 0.18,
      },
    });
    expect(createSemanticStatementDraftForBlock('visual.character-rim-light', input)).toEqual({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'rim-light',
        mode: 'set',
        intensity: 1,
        color: '#ffffff',
        thickness: 10,
        angle: 45,
        softness: 2,
        durationSeconds: 0,
      },
    });
    expect(createSemanticStatementDraftForBlock('visual.reset-character-rim-light', input)).toEqual({
      type: 'visualStyle',
      params: { scope: 'object', target: 'hero', slot: 'rim-light', mode: 'reset', durationSeconds: 0.4 },
    });

    for (const [blockId, slot] of [
      ['visual.modulate-character-integration', 'integration'],
      ['visual.modulate-character-accent', 'accent'],
      ['visual.modulate-character-distortion', 'distortion'],
    ] as const) {
      expect(createSemanticStatementDraftForBlock(blockId, input)).toMatchObject({
        type: 'visualStyle',
        params: { target: 'hero', slot, mode: 'modulate', durationSeconds: 1 },
      });
    }

    expect(createSemanticStatementDraftForBlock('lighting.preset', {})).toBeNull();
    expect(createSemanticStatementDraftForBlock('lighting.godrays', {})).toBeNull();
    expect(createSemanticStatementDraftForBlock('lighting.modulate-godrays', {})).toBeNull();
    expect(createSemanticStatementDraftForBlock('lighting.reset-post', {})).toMatchObject({
      type: 'lighting', params: { effect: 'post', mode: 'reset', durationSeconds: 0.4 },
    });
    expect(createSemanticStatementDraftForBlock('lighting.overlay', { stateTarget: 'overlay-main' })).toMatchObject({
      type: 'lighting', params: { effect: 'overlay', mode: 'set', id: 'overlay-main', color: '#ffffff', blendMode: 'multiply', intensity: 0.5 },
    });
    expect(createSemanticStatementDraftForBlock('lighting.modulate-overlay', { stateTarget: 'overlay-main' })).toMatchObject({
      type: 'lighting', params: { effect: 'overlay', mode: 'modulate', id: 'overlay-main', intensity: 1 },
    });
    expect(createSemanticStatementDraftForBlock('lighting.remove-point-light', { stateTarget: 'key-light' })).toMatchObject({
      type: 'lighting', params: { effect: 'pointLight', mode: 'remove', id: 'key-light', durationSeconds: 0.4 },
    });
    expect(createSemanticStatementDraftForBlock('lighting.clear-point-light', {})).toEqual({
      type: 'lighting', params: { effect: 'pointLight', mode: 'clear', durationSeconds: 0.4 },
    });
  });

  it('does not offer a separate character rim-light modulation entry', () => {
    const input = { sceneMeta: { title: 'Entry points', characters: [{ id: 'hero', name: 'Hero' }] }, charId: 'hero' };

    render(<StatementBlockLibrary activeCategory="visual" search="角色边光" onSearchChange={vi.fn()} />);

    expect(document.querySelector('[data-block-id="visual.modulate-character-rim-light"]')).toBeNull();
    expect(createSemanticStatementDraftForBlock('visual.modulate-character-rim-light', input)).toBeNull();
  });

  it.each(['offline', 'reconnecting'] as const)(
    'blocks blank-menu opening and drag/drop insertion while %s',
    async (status) => {
      const collaborationContext = {
        ...offlineContext,
        collaboration: { ...offlineContext.collaboration, status },
      };
      const area = document.createElement('div');
      const target = document.createElement('div');
      const preventDefault = vi.fn();
      const trackRefs = { current: new Map<string, HTMLDivElement>() };
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AppProvider {...collaborationContext}>{children}</AppProvider>
      );
      const blank = renderHook(() => useBlankContextMenu({
        areaRef: { current: area },
        trackRefs,
        pps: 50,
      }), { wrapper });

      act(() => {
        blank.result.current.handleContextMenu({
          target,
          clientX: 20,
          clientY: 20,
          preventDefault,
        } as any);
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(blank.result.current.blankMenu).toBeNull();

      const author = vi.fn(async () => ({ createdStatementIds: [] }));
      const dropArea = document.createElement('div');
      vi.spyOn(dropArea, 'getBoundingClientRect').mockReturnValue({
        left: 0, right: 500, top: 0, bottom: 200, width: 500, height: 200, x: 0, y: 0,
        toJSON: () => ({}),
      });
      const drop = renderHook(() => useTimelineDrop({
        areaRef: { current: dropArea },
        trackRefs: { current: new Map() },
        sceneData: { sceneId: 'scene', meta: { title: 'Offline' }, timeline: [] },
        pps: 50,
      }), {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <AppProvider {...collaborationContext} services={{ ...collaborationContext.services, semanticAuthoring: { author } }}>
            {children}
          </AppProvider>
        ),
      });
      const dataTransfer = {
        getData: () => JSON.stringify({ type: 'template', templateId: 'template-1' }),
        dropEffect: 'copy',
      };
      const dragOverTransfer = { dropEffect: 'copy' };

      act(() => {
        drop.result.current.handleDragOver({
          preventDefault: vi.fn(),
          dataTransfer: dragOverTransfer,
        } as any);
      });
      expect(dragOverTransfer.dropEffect).toBe('none');

      await act(async () => {
        await drop.result.current.handleDrop({
          preventDefault: vi.fn(),
          dataTransfer,
          clientX: 100,
          clientY: 20,
        } as any);
      });
      expect(author).not.toHaveBeenCalled();
    },
  );

  it('imports dropped resources through the scene asset seam before authoring', async () => {
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const importAssetPath = vi.fn(async () => 'background/scene.png');
    const area = document.createElement('div');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 500, top: 0, bottom: 200, width: 500, height: 200, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const context = {
      ...offlineContext,
      collaboration: { status: 'disconnected', self: null, peers: [] },
      services: {
        ...offlineContext.services,
        semanticAuthoring: { author },
        sceneAssets: { importAssetPath },
      },
    };
    const { result } = renderHook(() => useTimelineDrop({
      areaRef: { current: area },
      trackRefs: { current: new Map() },
      sceneData: { sceneId: 'scene', meta: { title: 'Drop' }, timeline: [] },
      pps: 50,
    }), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <AppProvider {...context}>{children}</AppProvider>
      ),
    });

    await act(async () => {
      await result.current.handleDrop({
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: () => JSON.stringify({
            type: 'resource',
            sourcePath: 'D:\\library\\scene.png',
            sourceKind: 'background/subdir',
          }),
        },
        clientX: 100,
        clientY: 20,
      } as any);
    });

    expect(importAssetPath).toHaveBeenCalledWith('D:/library/scene.png', 'background');
    expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      statement: expect.objectContaining({
        type: 'environmentLayer',
        params: expect.objectContaining({ file: 'background/scene.png' }),
      }),
    }));
  });

  it('does not author a resource when collaboration goes offline during import', async () => {
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    let resolveImport!: (path: string) => void;
    const importAssetPath = vi.fn(() => new Promise<string>((resolve) => {
      resolveImport = resolve;
    }));
    let setStatus!: (status: 'disconnected' | 'offline') => void;
    const area = document.createElement('div');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 500, top: 0, bottom: 200, width: 500, height: 200, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const StatusProvider = ({ children }: { children: React.ReactNode }) => {
      const [status, updateStatus] = useState<'disconnected' | 'offline'>('disconnected');
      setStatus = updateStatus;
      return (
        <AppProvider
          {...offlineContext}
          collaboration={{ status, self: null, peers: [] }}
          services={{ ...offlineContext.services, semanticAuthoring: { author }, sceneAssets: { importAssetPath } }}
        >
          {children}
        </AppProvider>
      );
    };
    const { result } = renderHook(() => useTimelineDrop({
      areaRef: { current: area },
      trackRefs: { current: new Map() },
      sceneData: { sceneId: 'scene', meta: { title: 'Offline during import' }, timeline: [] },
      pps: 50,
    }), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <StatusProvider>{children}</StatusProvider>
      ),
    });

    let dropPromise!: Promise<void>;
    act(() => {
      dropPromise = result.current.handleDrop({
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: () => JSON.stringify({
            type: 'resource',
            sourcePath: 'D:\\library\\scene.png',
            sourceKind: 'background',
          }),
        },
        clientX: 100,
        clientY: 20,
      } as any);
    });

    act(() => {
      setStatus('offline');
    });

    await act(async () => {
      resolveImport('background/scene.png');
      await dropPromise;
    });

    expect(importAssetPath).toHaveBeenCalledWith('D:/library/scene.png', 'background');
    expect(author).not.toHaveBeenCalled();
  });

  it('authors a dropped resource fallback when the scene asset service is unavailable', async () => {
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const area = document.createElement('div');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 500, top: 0, bottom: 200, width: 500, height: 200, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const { result } = renderHook(() => useTimelineDrop({
      areaRef: { current: area },
      trackRefs: { current: new Map() },
      sceneData: { sceneId: 'scene', meta: { title: 'No asset service' }, timeline: [] },
      pps: 50,
    }), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <AppProvider
          {...offlineContext}
          collaboration={{ status: 'disconnected', self: null, peers: [] }}
          services={{ ...offlineContext.services, semanticAuthoring: { author } }}
        >
          {children}
        </AppProvider>
      ),
    });

    await act(async () => {
      await result.current.handleDrop({
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: () => JSON.stringify({
            type: 'resource',
            sourcePath: 'D:\\library\\background\\scene.png',
            sourceKind: 'background',
          }),
        },
        clientX: 100,
        clientY: 20,
      } as any);
    });

    expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      statement: expect.objectContaining({
        type: 'environmentLayer',
        params: expect.objectContaining({ file: 'D:/library/background/scene.png' }),
      }),
    }));
  });

  it('authors a dropped resource fallback when import fails', async () => {
    const author = vi.fn(async () => ({ createdStatementIds: [] }));
    const importAssetPath = vi.fn(async () => {
      throw new Error('asset import failed');
    });
    const area = document.createElement('div');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 500, top: 0, bottom: 200, width: 500, height: 200, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const { result } = renderHook(() => useTimelineDrop({
      areaRef: { current: area },
      trackRefs: { current: new Map() },
      sceneData: { sceneId: 'scene', meta: { title: 'Import failure' }, timeline: [] },
      pps: 50,
    }), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <AppProvider
          {...offlineContext}
          collaboration={{ status: 'disconnected', self: null, peers: [] }}
          services={{ ...offlineContext.services, semanticAuthoring: { author }, sceneAssets: { importAssetPath } }}
        >
          {children}
        </AppProvider>
      ),
    });

    await act(async () => {
      await result.current.handleDrop({
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: () => JSON.stringify({
            type: 'resource',
            sourcePath: 'D:\\library\\background\\scene.png',
            sourceKind: 'background',
          }),
        },
        clientX: 100,
        clientY: 20,
      } as any);
    });

    expect(importAssetPath).toHaveBeenCalled();
    expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      statement: expect.objectContaining({
        type: 'environmentLayer',
        params: expect.objectContaining({ file: 'D:/library/background/scene.png' }),
      }),
    }));
  });

  it.each(['offline', 'reconnecting'] as const)(
    'blocks mutating block-menu actions while %s',
    async (status) => {
      const author = vi.fn(async () => ({ createdStatementIds: [] }));
      const context = {
        ...offlineContext,
        collaboration: { ...offlineContext.collaboration, status },
        adapters: { playback: { getCurrentTime: () => 0 } },
        stores: {
          document: {
            getCurrentSceneDocumentSnapshot: () => ({ schemaVersion: 4, sceneId: 'scene', meta: { title: 'Offline' }, statements: [] }),
            getCompiledSceneSnapshot: () => ({ actions: [] }),
          },
          editor: { copyBuffer: [], setCopyBuffer: vi.fn() },
        },
        services: { ...offlineContext.services, semanticAuthoring: { author } },
      };
      const { result } = renderHook(() => useBlockContextMenu(), {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <AppProvider {...context}>{children}</AppProvider>
        ),
      });

      act(() => {
        result.current.handleBlockContextMenu({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 20,
          clientY: 20,
        } as any, 'missing-action');
      });
      await act(async () => {
        await result.current.dispatchMenuAction(1);
      });

      expect(author).not.toHaveBeenCalled();
      expect(result.current.menuState).toBeNull();
    },
  );
});
