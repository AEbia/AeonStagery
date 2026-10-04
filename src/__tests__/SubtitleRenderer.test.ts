/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import SubtitleRenderer from '../engine/SubtitleRenderer';

const stageState = vi.hoisted(() => ({
  subtitleLayer: null as any,
  executeHook: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getLayer: vi.fn((name: string) => {
      if (name !== 'subtitle') throw new Error(`Unexpected layer ${name}`);
      return stageState.subtitleLayer;
    }),
  },
}));

vi.mock('../api/hooks', () => ({
  hookSystem: {
    execute: stageState.executeHook,
  },
}));

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: {
    get: stageState.getSetting,
  },
}));

describe('SubtitleRenderer', () => {
  beforeEach(() => {
    stageState.subtitleLayer = new PIXI.Container();
    stageState.executeHook.mockClear();
    stageState.getSetting.mockImplementation((key: string) => {
      if (key === 'dialogueTextSpeed') return 0.01;
      return '';
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type: any) => {
      if (type !== '2d') return null;
      const context = new Proxy({
        canvas: document.createElement('canvas'),
        fillStyle: '',
        font: '',
        measureText: vi.fn(() => ({ width: 100 })),
      } as Record<string, any>, {
        get(target, prop) {
          if (prop in target) return target[prop as string];
          return vi.fn();
        },
        set(target, prop, value) {
          target[prop as string] = value;
          return true;
        },
      });
      return context as any;
    });
    vi.spyOn(PIXI.CanvasTextMetrics, 'measureText').mockReturnValue({
      lines: ['Hello'],
      lineWidths: [100],
      lineHeight: 60,
      maxLineWidth: 100,
      width: 100,
      height: 60,
      fontProperties: {
        ascent: 40,
        descent: 20,
        fontSize: 60,
      },
    } as any);
  });

  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.restoreAllMocks();
    stageState.subtitleLayer.destroy({ children: true });
    stageState.subtitleLayer = null;
  });

  it('rebuilds a cached dialogue when the same statement moves to another screen position', () => {
    const renderer = new SubtitleRenderer();
    const bottomTimeline = renderer.showDialogue({
      _id: 'statement-1',
      speaker: '',
      text: 'Hello',
      style: 'instant',
      template: 'minimal',
      position: 'bottom',
      duration: 2,
    });

    bottomTimeline.seek(0.001, false);
    expect(stageState.subtitleLayer.children).toHaveLength(1);
    const bottomContainer = stageState.subtitleLayer.children[0];

    const topTimeline = renderer.showDialogue({
      _id: 'statement-1',
      speaker: '',
      text: 'Hello',
      style: 'instant',
      template: 'minimal',
      position: 'top',
      duration: 2,
    });

    expect(topTimeline).not.toBe(bottomTimeline);
    topTimeline.seek(0.001, false);

    expect(stageState.subtitleLayer.children).toHaveLength(1);
    expect(stageState.subtitleLayer.children[0]).not.toBe(bottomContainer);
  });

  it('returns the cached timeline for an unchanged dialogue statement', () => {
    const renderer = new SubtitleRenderer();
    const config = {
      _id: 'statement-2',
      speaker: '',
      text: 'Cached',
      style: 'instant' as const,
      position: 'bottom' as const,
      duration: 2,
    };

    const firstTimeline = renderer.showDialogue(config);
    const secondTimeline = renderer.showDialogue(config);

    expect(secondTimeline).toBe(firstTimeline);
  });

  it('reattaches cached dialogue during seek restoration and applies the requested offset', () => {
    const renderer = new SubtitleRenderer();
    const config = {
      _id: 'statement-3',
      speaker: '',
      text: 'Restore me',
      style: 'instant' as const,
      position: 'bottom' as const,
      duration: 2,
    };
    const timeline = renderer.showDialogue(config);
    timeline.seek(0.001, false);

    renderer.hideDialogue(false);
    expect(stageState.subtitleLayer.children).toHaveLength(0);

    renderer.ensureDialogueOnStage(config, 1);

    expect(stageState.subtitleLayer.children).toHaveLength(1);
    expect(renderer.getCurrentTimeline()).toBe(timeline);
  });

  it('animates dialogue removal without destroying the cached timeline target', () => {
    const renderer = new SubtitleRenderer();
    const timeline = renderer.showDialogue({
      _id: 'statement-4',
      speaker: '',
      text: 'Hide me',
      style: 'instant',
      position: 'bottom',
      duration: 2,
    });
    timeline.seek(0.001, false);

    const hideTween = renderer.hideDialogue(true);
    expect(hideTween).not.toBeNull();
    expect(renderer.getCurrentTimeline()).toBeNull();

    hideTween!.progress(1);

    expect(stageState.subtitleLayer.children).toHaveLength(0);
    expect(stageState.executeHook).toHaveBeenCalledWith('dialogue:hide', {});
  });

  it('reuses loaded fonts across repeated prepared-scene preloads', async () => {
    const renderer = new SubtitleRenderer();
    class FakeFontFace {
      static instances: FakeFontFace[] = [];
      constructor(public family: string, public source: string) {
        FakeFontFace.instances.push(this);
      }
      async load(): Promise<FakeFontFace> { return this; }
    }
    const previousFontFace = (globalThis as any).FontFace;
    (globalThis as any).FontFace = FakeFontFace;
    const replacedFonts = !(document as any).fonts;
    try {
      const fonts = (document as any).fonts ?? { add: vi.fn() };
      if (replacedFonts) (document as any).fonts = fonts;
      const add = vi.spyOn(fonts, 'add');

      const scene = {
        kind: 'prepared-compiled-scene',
        sourceSchemaVersion: 3,
        sceneId: 'font-dialogue',
        meta: { title: 'Font Dialogue' },
        durationSeconds: 2,
        actions: [{
          id: 'dialogue:font',
          time: 0,
          action: 'dialogue',
          source: { statementId: 'font', outputKey: 'primary' },
          params: {
            text: 'Hello',
            duration: 2,
            presentation: {
              renderer: 'dialog-text-v1',
              text: { fontFile: { source: 'fonts/test.ttf', runtimeUri: 'asset://fonts/test.ttf' }, fontFamily: 'TestFont' },
            },
          },
        }],
      } as any;

      await renderer.preloadPreparedScene(scene);
      expect(FakeFontFace.instances.length).toBe(1);
      expect(add).toHaveBeenCalledTimes(1);

      // Second preload of the same family+uri must not rebuild the font.
      await renderer.preloadPreparedScene(scene);
      expect(FakeFontFace.instances.length).toBe(1);
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      // Restore the globals this test replaced; vi.restoreAllMocks() in
      // afterEach only undoes spies, not direct assignments.
      (globalThis as any).FontFace = previousFontFace;
      if (replacedFonts) delete (document as any).fonts;
    }
  });

  it('does not preload unavailable dialogue panel images even if they carry a runtime URI', async () => {
    const renderer = new SubtitleRenderer();
    const load = vi.spyOn(PIXI.Assets, 'load').mockResolvedValue({} as any);
    const scene = {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: 3,
      sceneId: 'missing-dialogue-image',
      meta: { title: 'Missing Dialogue Image' },
      durationSeconds: 2,
      actions: [{
        id: 'dialogue:missing-image',
        time: 0,
        action: 'dialogue',
        source: { statementId: 'missing-image', outputKey: 'primary' },
        params: {
          presentation: {
            renderer: 'image-dialogue-v1',
            textbox: {
              image: {
                source: 'images/missing.png',
                runtimeUri: 'asset://localhost/C:/project/images/missing.png',
                unavailable: true,
              },
            },
          },
        },
      }],
    } as any;

    try {
      await renderer.preloadPreparedScene(scene);
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it('preloads prepared dialogue UI textures before scheduling the scene', async () => {
    const renderer = new SubtitleRenderer();
    const load = vi.spyOn(PIXI.Assets, 'load').mockResolvedValue({} as any);

    await renderer.preloadPreparedScene({
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: 3,
      sceneId: 'image-dialogue',
      meta: { title: 'Image Dialogue' },
      durationSeconds: 2,
      actions: [{
        id: 'dialogue:image',
        time: 0,
        action: 'dialogue',
        source: { statementId: 'image', outputKey: 'primary' },
        params: {
          text: 'Hello',
          duration: 2,
          presentation: {
            renderer: 'image-dialogue-v1',
            textbox: { image: { source: 'images/textbox.png', runtimeUri: 'asset://images/textbox.png' } },
            namebox: { image: { source: 'images/namebox.png', runtimeUri: 'asset://images/namebox.png' } },
            text: {},
          },
        },
      }],
    } as any);

    expect(load).toHaveBeenCalledWith('asset://images/textbox.png');
    expect(load).toHaveBeenCalledWith('asset://images/namebox.png');
  });
});
