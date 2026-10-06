/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import SubtitleRenderer from '../engine/SubtitleRenderer';
import { DialogueCoordinator } from '../engine/coordinators/DialogueCoordinator';
import { SEMANTIC_BUILTIN_TEMPLATE_PACKAGE } from '../services/template-package/BuiltinTemplatePackage';

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

  it.each(['typewriter', 'fadeIn', 'cinematic', 'instant'] as const)('plays %s subtitles in image dialogue with the entrance disabled', (style) => {
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueEntranceAnimation' ? false : key === 'dialogueTextSpeed' ? 0.01 : '');
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    const renderer = new SubtitleRenderer();
    const config = {
      _id: `pink-${style}`, speaker: '', text: 'Hello', style, duration: 2,
      presentation: {
        renderer: 'image-dialogue-v1' as const, styleId: 'pink-nameplate',
        textbox: { image: 'textbox.svg', x: 120, y: 792, width: 1680, height: 248 },
        text: { x: 198, y: 820, maxWidth: 1520, fontSize: 48, lineHeight: 68 },
      },
    };
    const timeline = renderer.showDialogue(config);
    timeline.pause();
    renderer.ensureDialogueOnStage(config, 0);
    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const text = container.children.find((child) => child instanceof PIXI.Text) as PIXI.Text;
    expect(container.alpha).toBe(1);
    expect(container.y).toBe(0);
    renderer.ensureDialogueOnStage(config, 0.001);
    if (style === 'typewriter') {
      expect(text.text).toBe('');
      expect(text.mask).toBeFalsy();
    }
    if (style === 'fadeIn' || style === 'cinematic') expect(text.alpha).toBeLessThan(1);
    if (style === 'cinematic') expect(text.y).toBeGreaterThan(config.presentation.text.y);
    renderer.ensureDialogueOnStage(config, 1);
    expect(text.alpha).toBe(1);
    expect(text.y).toBe(config.presentation.text.y);
    if (style === 'typewriter') expect(text.text).toBe('Hello');
    renderer.ensureDialogueOnStage(config, 0);
    expect(container.alpha).toBe(1);
    expect(container.y).toBe(0);
  });

  it('submits only revealed Chinese characters while the real dialogue playback coordinator advances', () => {
    const content = '粉色名牌应当逐字显示对白';
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueEntranceAnimation' ? false : key === 'dialogueTextSpeed' ? 0.1 : '');
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    vi.mocked(PIXI.CanvasTextMetrics.measureText).mockReturnValue({
      lines: [content], lineWidths: [content.length * 48], lineHeight: 62, maxLineWidth: content.length * 48,
      width: content.length * 48, height: 62, fontProperties: { ascent: 40, descent: 8, fontSize: 48 },
    } as any);
    const preset = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE.manifest.dialogueStyles!.find((style) => style.id === 'pink-nameplate')!;
    const presentation = { ...preset.params, renderer: 'image-dialogue-v1', styleId: preset.id } as any;
    const config = { _id: 'pink-playback', speaker: '', text: content, style: 'typewriter' as const, duration: 3, presentation };
    const renderer = new SubtitleRenderer();
    const timeline = renderer.showDialogue(config);
    const master = gsap.timeline({ paused: true }).add(timeline, 1);
    const coordinator = new DialogueCoordinator(renderer, { stop: vi.fn(), setTextMouthAt: vi.fn(), startAudioDrivenLipSync: vi.fn() });
    const sync = (offset: number) => {
      master.seek(1 + offset, true);
      coordinator.sync(1 + offset, { ...config, startTime: 1 }, false, vi.fn(), (path) => path, vi.fn());
    };
    sync(0.15);
    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const text = container.children.find((child) => child instanceof PIXI.Text) as PIXI.Text;
    expect(text.text.replace(/\u200B/g, '')).toBe(content.slice(0, 1));
    sync(0.35);
    expect(text.text.replace(/\u200B/g, '')).toBe(content.slice(0, 3));
    sync(2);
    expect(text.text.replace(/\u200B/g, '')).toBe(content);
    sync(0.15);
    expect(text.text.replace(/\u200B/g, '')).toBe(content.slice(0, 1));
  });

  it('keeps wrapped image dialogue lines aligned while revealing Unicode characters and seeking backwards', () => {
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueEntranceAnimation' ? false : key === 'dialogueTextSpeed' ? 0.1 : '');
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    vi.mocked(PIXI.CanvasTextMetrics.measureText).mockReturnValue({
      lines: ['你\u200B好\u200B🙂', '再\u200B见'], lineWidths: [144, 96], lineHeight: 62, maxLineWidth: 144,
      width: 144, height: 124, fontProperties: { ascent: 40, descent: 8, fontSize: 48 },
    } as any);
    const renderer = new SubtitleRenderer();
    const config = {
      _id: 'pink-wrap', speaker: '', text: '你好🙂再见', style: 'typewriter' as const, duration: 2,
      presentation: {
        renderer: 'image-dialogue-v1' as const, styleId: 'pink-nameplate',
        textbox: { image: 'textbox.svg', x: 120, y: 792, width: 1680, height: 248 },
        text: { x: 176, y: 830, maxWidth: 144, fontSize: 48, lineHeight: 62, align: 'center' as const },
      },
    };
    renderer.showDialogue(config).pause();
    renderer.ensureDialogueOnStage(config, 0.25);
    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const lines = container.children.filter((child) => child instanceof PIXI.Text) as PIXI.Text[];
    const content = () => lines.map((line) => line.text.replace(/\u200B/g, ''));
    expect(content()).toEqual(['你好', '']);
    const positions = lines.map((line) => [line.x, line.y]);
    expect(positions).toEqual([[176, 830], [200, 892]]);
    renderer.ensureDialogueOnStage(config, 0.35);
    expect(content()).toEqual(['你好🙂', '']);
    renderer.ensureDialogueOnStage(config, 0.45);
    expect(content()).toEqual(['你好🙂', '再']);
    renderer.ensureDialogueOnStage(config, 1);
    expect(content()).toEqual(['你好🙂', '再见']);
    renderer.ensureDialogueOnStage(config, 0.15);
    expect(content()).toEqual(['你', '']);
    expect(lines.map((line) => [line.x, line.y])).toEqual(positions);
    renderer.ensureDialogueOnStage(config, 0);
    expect(content()).toEqual(['', '']);
  });

  it('honors the global entrance switch for already scheduled dialogue', () => {
    let enabled = true;
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueEntranceAnimation' ? enabled : key === 'dialogueTextSpeed' ? 0.01 : '');
    const renderer = new SubtitleRenderer();
    const config = { _id: 'entrance-switch', speaker: '', text: 'Hello', style: 'instant' as const, duration: 2 };
    const timeline = renderer.showDialogue(config);
    timeline.pause();
    renderer.ensureDialogueOnStage(config, 0.05);
    expect(stageState.subtitleLayer.children[0].alpha).toBeLessThan(1);
    enabled = false;
    renderer.ensureDialogueOnStage(config, 0.05);
    expect(stageState.subtitleLayer.children[0].alpha).toBe(1);
    expect(stageState.subtitleLayer.children[0].y).toBe(0);
    enabled = true;
    renderer.ensureDialogueOnStage(config, 0.05);
    expect(stageState.subtitleLayer.children[0].alpha).toBeLessThan(1);
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
