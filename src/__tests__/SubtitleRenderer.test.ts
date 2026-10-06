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

function useRealTextMetrics() {
  vi.mocked(PIXI.CanvasTextMetrics.measureText).mockRestore();
  const context = {
    font: '',
    measureText(text: string) {
      const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 48);
      return { width: Array.from(text.replace(/\u200B/g, '')).length * size, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 };
    },
  };
  vi.spyOn(PIXI.CanvasTextMetrics, '_canvas', 'get').mockReturnValue({ getContext: () => context } as any);
  vi.spyOn(PIXI.CanvasTextMetrics, '_context', 'get').mockReturnValue(context as any);
  vi.spyOn(PIXI.CanvasTextMetrics, 'experimentalLetterSpacingSupported', 'get').mockReturnValue(false);
  vi.spyOn(PIXI.CanvasTextMetrics, 'measureFont').mockReturnValue({ ascent: 40, descent: 8, fontSize: 48 });
}

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

  it.each(['pink-nameplate', 'immersive-subtitle', 'glass', 'minimal', 'classic'])('wraps long Chinese text using real Pixi metrics for %s', (styleId) => {
    useRealTextMetrics();
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    const preset = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE.manifest.dialogueStyles!.find((style) => style.id === styleId)!;
    const content = '这是一段需要在舞台文本框内自动换行的中文对白'.repeat(3);
    const image = preset.renderer === 'image-dialogue-v1';
    const config = { _id: `real-wrap-${styleId}`, speaker: '', text: content, style: 'typewriter' as const, duration: 4, template: styleId,
      presentation: image ? { ...preset.params, renderer: 'image-dialogue-v1', styleId } as any : undefined };
    const renderer = new SubtitleRenderer();
    renderer.showDialogue(config).pause();
    renderer.ensureDialogueOnStage(config, 3);
    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const lines = container.children.filter((child) => child instanceof PIXI.Text) as PIXI.Text[];
    if (image) expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.text.replace(/\u200B/g, '')).join('')).toBe(content);
    for (const line of lines) {
      const metrics = PIXI.CanvasTextMetrics.measureText(line.text, line.style);
      expect(metrics.maxLineWidth).toBeLessThanOrEqual(line.style.wordWrapWidth);
      if (!image) expect(metrics.lines.length).toBeGreaterThan(1);
      expect(line.y + metrics.height).toBeLessThanOrEqual(1080);
    }
  });

  it('keeps large classic dialogue text within the stage', () => {
    useRealTextMetrics();
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueFontSize' ? 96 : key === 'dialogueTextSpeed' ? 0.01 : '');
    const content = '中文对白需要在大字号下根据经典文本框宽度换行'.repeat(2);
    const config = { _id: 'large-classic-dialogue', speaker: '', text: content, style: 'instant' as const, duration: 4, template: 'classic' };
    const renderer = new SubtitleRenderer();
    renderer.showDialogue(config).pause();
    renderer.ensureDialogueOnStage(config, 1);

    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const dialogueText = container.children.find((child) => child instanceof PIXI.Text) as PIXI.Text;
    const metrics = PIXI.CanvasTextMetrics.measureText(dialogueText.text, dialogueText.style);
    expect(metrics.lines.length).toBeGreaterThan(1);
    expect(dialogueText.y + metrics.height).toBeLessThanOrEqual(1080);
  });

  it.each(['typewriter', 'fadeIn', 'cinematic', 'instant'] as const)('wraps mixed text, explicit newlines and oversized words with %s subtitles', (style) => {
    useRealTextMetrics();
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    const content = `中文和🙂表情${'LongWord'.repeat(10)}\n保留换行`;
    const preset = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE.manifest.dialogueStyles!.find((preset) => preset.id === 'pink-nameplate')!;
    const config = { _id: `mixed-wrap-${style}`, speaker: '', text: content, style, duration: 4,
      presentation: { ...preset.params, renderer: 'image-dialogue-v1', styleId: preset.id } as any };
    const renderer = new SubtitleRenderer();
    renderer.showDialogue(config).pause();
    renderer.ensureDialogueOnStage(config, 3);
    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const texts = container.children.filter((child) => child instanceof PIXI.Text) as PIXI.Text[];
    const lines = texts.flatMap((text) => {
      const metrics = PIXI.CanvasTextMetrics.measureText(text.text, text.style);
      expect(metrics.maxLineWidth).toBeLessThanOrEqual(text.style.wordWrapWidth);
      return metrics.lines;
    });
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join('')).toBe(content.replace(/\n/g, ''));
    expect(lines.at(-1)).toBe('保留换行');
  });

  it('reflows active dialogue after a font change while preserving playback and the nameplate position', () => {
    useRealTextMetrics();
    let fontSize = 32;
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueFontSize' ? fontSize : key === 'dialogueTextSpeed' ? 0.01 : key === 'dialogueEntranceAnimation' ? false : '');
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    const content = '调整字号应当更新文本测量并保持对白在舞台内自动换行'.repeat(3);
    const preset = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE.manifest.dialogueStyles!.find((preset) => preset.id === 'pink-nameplate')!;
    const config = { _id: 'live-font-reflow', speaker: '角色', text: content, style: 'typewriter' as const, duration: 4,
      presentation: { ...preset.params, renderer: 'image-dialogue-v1', styleId: preset.id } as any };
    const renderer = new SubtitleRenderer();
    const original = renderer.showDialogue(config);
    const master = gsap.timeline({ paused: true }).add(original, 2);
    const coordinator = new DialogueCoordinator(renderer, { stop: vi.fn(), setTextMouthAt: vi.fn(), startAudioDrivenLipSync: vi.fn() });
    const sync = (offset: number) => {
      master.seek(2 + offset, true);
      coordinator.sync(2 + offset, { ...config, startTime: 2 }, false, vi.fn(), (path) => path, vi.fn());
    };
    sync(1);
    const before = stageState.subtitleLayer.children[0] as PIXI.Container;
    const firstLines = before.children.filter((child) => child instanceof PIXI.Text && child.style.fontSize === 32);
    expect(firstLines.length).toBeGreaterThan(1);
    fontSize = 72;
    renderer.forceUpdate();
    const after = stageState.subtitleLayer.children[0] as PIXI.Container;
    const lines = after.children.filter((child) => child instanceof PIXI.Text && child.style.fontSize === 72) as PIXI.Text[];
    expect(lines.length).toBeGreaterThan(firstLines.length);
    expect(lines.map((line) => line.text).join('')).toBe(content);
    expect(lines[0].style.lineHeight).toBe(93);
    const replacement = renderer.getCurrentTimeline()!;
    expect(replacement).not.toBe(original);
    expect(replacement.parent).toBe(master);
    expect(replacement.startTime()).toBe(2);
    expect(replacement.time()).toBeCloseTo(1);
    const box = after.children[0] as PIXI.Sprite;
    const namebox = after.children[1] as PIXI.Container;
    expect(box.y + box.height).toBeCloseTo(1040);
    expect(namebox.y - box.y).toBe(-78);
    expect(lines[0].y - box.y).toBe(38);
    expect(lines.at(-1)!.y + 93).toBeLessThanOrEqual(1040);
    sync(0.15);
    expect(lines.map((line) => line.text).join('')).toBe(content.slice(0, 15));
    sync(3);
    expect(lines.map((line) => line.text).join('')).toBe(content);
    expect(stageState.subtitleLayer.children).toHaveLength(1);
  });

  it.each(['glass', 'minimal', 'classic', 'pink-nameplate', 'immersive-subtitle'])('keeps the speaker font unchanged when adjusting dialogue font size for %s', (styleId) => {
    let fontSize = 32;
    stageState.getSetting.mockImplementation((key: string) => key === 'dialogueFontSize' ? fontSize : key === 'dialogueTextSpeed' ? 0.01 : '');
    vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
    const preset = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE.manifest.dialogueStyles!.find((preset) => preset.id === styleId)!;
    const config = { _id: `speaker-font-${styleId}`, speaker: '说话人', text: 'Hello', style: 'instant' as const, duration: 3, template: styleId,
      presentation: preset.renderer === 'image-dialogue-v1' ? { ...preset.params, renderer: 'image-dialogue-v1', styleId } as any : undefined };
    const renderer = new SubtitleRenderer();
    renderer.showDialogue(config).pause();
    const collectTexts = (container: PIXI.Container): PIXI.Text[] => container.children.flatMap((child) =>
      child instanceof PIXI.Text ? [child] : child instanceof PIXI.Container ? collectTexts(child) : []);
    const readTexts = () => collectTexts(stageState.subtitleLayer.children[0] as PIXI.Container);
    renderer.ensureDialogueOnStage(config, 1);
    const initialSpeaker = readTexts().find((text) => text.text.includes('说话人'))!;
    const speakerFontSize = initialSpeaker.style.fontSize;
    expect(readTexts().find((text) => text.text === 'Hello')!.style.fontSize).toBe(32);
    fontSize = 72;
    renderer.ensureDialogueOnStage(config, 1);
    expect(readTexts().find((text) => text.text.includes('说话人'))!.style.fontSize).toBe(speakerFontSize);
    expect(readTexts().find((text) => text.text === 'Hello')!.style.fontSize).toBe(72);
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
