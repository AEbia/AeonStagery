/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import SubtitleRenderer from '../engine/SubtitleRenderer';
import { ImageDialogueTemplate } from '../engine/ImageDialogueTemplate';
import { parseDialogueImagePresentation } from '../services/semantic-scene/SceneStatementParamParsers';
import { translateWebGalTextboxScss } from '../services/import/webgal/WebGalTextboxScssTranslator';

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
  hookSystem: { execute: stageState.executeHook },
}));

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: { get: stageState.getSetting },
}));

/** Textbox/namebox panels read `PIXI.Texture.from(image)`; a stub keeps rendering offline. */
function stubTextures() {
  vi.spyOn(PIXI.Texture, 'from').mockReturnValue(PIXI.Texture.WHITE);
}

function collectTexts(container: PIXI.Container): PIXI.Text[] {
  return container.children.flatMap((child) => (
    child instanceof PIXI.Text ? [child]
      : child instanceof PIXI.Container ? collectTexts(child)
        : []
  ));
}

const PANEL = { image: 'namebox.svg', x: 200, y: 600, width: 400, minHeight: 96 };
const TEXT_LINE = { x: 260, y: 800, maxWidth: 1400, fontSize: 48, lineHeight: 68, align: 'center' as const };

function presentationWith(speaker: Record<string, unknown> | undefined) {
  return parseDialogueImagePresentation({
    renderer: 'image-dialogue-v1',
    styleId: 'test-style',
    textbox: { image: 'textbox.svg', x: 177, y: 799, width: 1566, height: 228 },
    namebox: PANEL,
    text: TEXT_LINE,
    speaker,
  }, 'dialogueStyles[0].presentation');
}

function renderTemplate(presentation: ReturnType<typeof presentationWith>) {
  const container = new PIXI.Container();
  const layout = ImageDialogueTemplate.render(container, {
    _id: 'nameplate', text: 'Hello', speaker: 'Hero', style: 'instant', duration: 3,
    presentation,
  } as any, { height: 60 } as any);
  return { container, layout, speakerText: collectTexts(container).find((text) => text.text === 'Hero')! };
}

describe('dialogue speaker style contract', () => {
  it('round-trips spacing, shadow direction and a measured panel anchor', () => {
    const source = presentationWith({ letterSpacing:2, dropShadowAngle:-Math.PI / 2 });
    const presentation = parseDialogueImagePresentation({
      ...source, namebox:{ ...PANEL, anchorX:0.5 },
      text:{ ...TEXT_LINE, letterSpacing:3, dropShadow:true, dropShadowAngle:Math.PI / 2 },
    }, 'presentation');
    expect(presentation?.namebox?.anchorX).toBe(0.5);
    expect(presentation?.speaker).toMatchObject({ letterSpacing:2, dropShadowAngle:-Math.PI / 2 });
    expect(ImageDialogueTemplate.resolveTextStyle?.({ speaker:'Hero', text:'Hello', presentation }))
      .toMatchObject({ letterSpacing:3, dropShadow:{ angle:Math.PI / 2 } });
    expect(() => presentationWith({ letterSpacing:NaN })).toThrow();
    expect(() => presentationWith({ dropShadowAngle:Infinity })).toThrow();
  });

  it('accepts the extended nameplate fields and keeps them on the presentation', () => {
    const presentation = presentationWith({
      color: '#FFFFFF',
      fontSize: 46,
      align: 'left',
      padding: [20, 8, 20, 8],
      strokeColor: '#FF3B72',
      strokeWidth: 5,
      dropShadow: true,
      dropShadowColor: '#000000',
      dropShadowAlpha: 0.85,
      dropShadowBlur: 8,
      dropShadowDistance: 0,
    });
    expect(presentation?.speaker).toMatchObject({
      align: 'left',
      strokeColor: '#FF3B72',
      strokeWidth: 5,
      dropShadow: true,
      dropShadowColor: '#000000',
      dropShadowAlpha: 0.85,
      dropShadowBlur: 8,
      dropShadowDistance: 0,
    });
  });

  it('still rejects fields outside the whitelist', () => {
    expect(() => presentationWith({ align: 'left', textStroke: 4 })).toThrow(/Unknown field/);
  });

  it('rejects an out-of-range drop shadow alpha', () => {
    expect(() => presentationWith({ dropShadow: true, dropShadowAlpha: 1.4 })).toThrow(/between 0 and 1/);
  });

  it('rejects an unsupported alignment value', () => {
    expect(() => presentationWith({ align: 'justify' })).toThrow(/Expected left, center, right/);
  });

  it('drops the whole speaker block when it is absent', () => {
    expect(presentationWith(undefined)?.speaker).toBeUndefined();
  });
});

describe('nameplate rendering', () => {
  beforeEach(() => {
    stubTextures();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type: any) => {
      if (type !== '2d') return null;
      return new Proxy({
        canvas: document.createElement('canvas'),
        font: '',
        measureText: vi.fn(() => ({ width: 100 })),
      } as Record<string, any>, {
        get(target, prop) { return prop in target ? target[prop as string] : vi.fn(); },
        set(target, prop, value) { target[prop as string] = value; return true; },
      }) as any;
    });
    vi.spyOn(PIXI.CanvasTextMetrics, 'measureText').mockReturnValue({
      lines: ['Hero'], lineWidths: [100], lineHeight: 60, maxLineWidth: 100, width: 100, height: 60,
      fontProperties: { ascent: 40, descent: 20, fontSize: 60 },
    } as any);
  });

  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.restoreAllMocks();
  });

  it.each([
    [40, 'left', 1, 0], [400, 'left', 1, 0],
    [40, 'right', 0, 0], [400, 'right', 0, 0],
    [40, '25%', 0.75, 0], [400, '25%', 0.75, 0],
    [40, '40px', 1, 15], [400, '40px', 1, 15],
  ])('applies the measured nameplate origin with minimum width %s and origin %s', (width, origin, anchor, offset) => {
    const { params } = translateWebGalTextboxScss(`
      .TextBox_main { left:0; right:0; padding:0; align-items:center; }
      .TextBox_showName { position:relative; min-width:${width}px; padding:0;
        font-size:20px !important; text-align:center; scale:0.5; transform-origin:${origin} top; }
    `).style;
    const presentation = parseDialogueImagePresentation({ renderer:'image-dialogue-v1', ...params }, 'presentation');
    const { container, speakerText } = renderTemplate(presentation);
    const panel = container.children[1];
    // A half-scale plate is anchored at its right edge for a left origin, at
    // its left edge for a right origin, or between them for a percentage origin.
    expect(panel.x + panel.width * anchor).toBe(960 + offset);
    if (width === 40) expect(panel.width).toBeGreaterThan(params.namebox!.width);
    expect(speakerText.x).toBe(panel.x + panel.width / 2);
  });

  it('keeps the measured transform origin inside the nameplate artwork shadow', () => {
    const { style, assetGeom } = translateWebGalTextboxScss(`
      .TextBox_main { left:0; right:0; padding:0; align-items:center;
        transform:scale(0.5); transform-origin:left top; }
      .TextBox_showName { position:relative; min-width:40px; padding:0;
        font-size:20px !important; scale:0.5; transform-origin:left top; }
      .TextBox_ShowName_Background { box-shadow:8px 0 4px black; }
    `);
    const presentation = parseDialogueImagePresentation({ renderer:'image-dialogue-v1', ...style.params }, 'presentation');
    const { container } = renderTemplate(presentation);
    const panel = container.children[1];
    const geometry = assetGeom.namebox;
    const content = geometry.content!;
    const shadowRight = geometry.width - content.x - content.width;
    expect(shadowRight).toBeGreaterThan(0);
    expect(panel.width).toBeGreaterThan(geometry.width);
    // The main transform halves the content center to 480; the nameplate's
    // scaled body still ends there, with the shadow extending beyond it.
    expect(panel.x + panel.width - shadowRight).toBe(480);
  });

  it.each([40, 400])('centers a measured nameplate with minimum width %s', (width) => {
    const source = presentationWith({ align:'center', letterSpacing:2, dropShadow:true, dropShadowAngle:Math.PI / 2 });
    const presentation = parseDialogueImagePresentation({
      ...source, namebox:{ ...PANEL, x:960, width, anchorX:0.5 },
    }, 'presentation');
    const { container, speakerText } = renderTemplate(presentation);
    const panel = container.children[1];
    expect(panel.x + panel.width / 2).toBe(960);
    expect(speakerText.x).toBe(960);
    expect(speakerText.style.letterSpacing).toBe(2);
    expect(speakerText.style.dropShadow).toMatchObject({ angle:Math.PI / 2 });
  });

  it('keeps legacy templates centered when no alignment is authored', () => {
    const { speakerText } = renderTemplate(presentationWith({ padding: [20, 8, 20, 8] }));
    expect(speakerText.anchor.x).toBe(0.5);
    // panelWidth falls back to the authored width (400) when the plate is wider than the name.
    expect(speakerText.x).toBe(PANEL.x + 20 + (400 - 40) / 2);
  });

  it('anchors the nameplate text to the left padding when alignment is left', () => {
    const { speakerText } = renderTemplate(presentationWith({ padding: [20, 8, 20, 8], align: 'left' }));
    expect(speakerText.anchor.x).toBe(0);
    expect(speakerText.x).toBe(PANEL.x + 20);
    expect(speakerText.style.align).toBe('left');
  });

  it('anchors the nameplate text to the right padding when alignment is right', () => {
    const { speakerText } = renderTemplate(presentationWith({ padding: [20, 8, 20, 8], align: 'right' }));
    expect(speakerText.anchor.x).toBe(1);
    expect(speakerText.x).toBe(PANEL.x + 20 + (400 - 40));
  });

  it('passes the nameplate outline through to the text style', () => {
    const { speakerText } = renderTemplate(presentationWith({ strokeColor: '#FF3B72', strokeWidth: 5 }));
    expect(speakerText.style.stroke).toMatchObject({ color: '#FF3B72', width: 5 });
  });

  it('passes the nameplate glow through to the text style', () => {
    const { speakerText } = renderTemplate(presentationWith({
      dropShadow: true, dropShadowColor: '#102030', dropShadowAlpha: 0.85,
      dropShadowBlur: 8, dropShadowDistance: 0,
    }));
    expect(speakerText.style.dropShadow).toMatchObject({
      color: '#102030', alpha: 0.85, blur: 8, distance: 0,
    });
  });

  it('disables the glow for plates that do not declare one', () => {
    const { speakerText } = renderTemplate(presentationWith({ color: '#FFFFFF' }));
    expect(speakerText.style.dropShadow).toBeFalsy();
  });

  it('reserves texture padding for the glow so it cannot be clipped', () => {
    const plain = renderTemplate(presentationWith({ strokeWidth: 0 }));
    const glowing = renderTemplate(presentationWith({
      strokeWidth: 0,
      dropShadow: true, dropShadowColor: '#000000', dropShadowAlpha: 0.85,
      dropShadowBlur: 8, dropShadowDistance: 0,
    }));

    // Pixi measures the stroke and the shadow distance, but not the blur, so the
    // texture needs room of its own or the glow is cut off at its edge.
    expect(plain.speakerText.style.padding).toBe(0);
    expect(glowing.speakerText.style.padding).toBe(8);
    // The room is texture-only: Pixi leaves the text bounds and position alone, so
    // the plate stays the size the glyphs asked for.
    expect(glowing.speakerText.width).toBe(plain.speakerText.width);
    expect(glowing.speakerText.x).toBe(plain.speakerText.x);
  });

  it('leaves a left-aligned nameplate position untouched by the glow padding', () => {
    const plain = renderTemplate(presentationWith({ align: 'left' }));
    const glowing = renderTemplate(presentationWith({
      align: 'left',
      dropShadow: true, dropShadowColor: '#000000', dropShadowAlpha: 0.85,
      dropShadowBlur: 8, dropShadowDistance: 0,
    }));

    expect(glowing.speakerText.anchor.x).toBe(0);
    expect(glowing.speakerText.x).toBe(plain.speakerText.x);
  });
});

describe('body text alignment', () => {
  beforeEach(() => {
    stageState.subtitleLayer = new PIXI.Container();
    stageState.executeHook.mockClear();
    stageState.getSetting.mockImplementation((key: string) => (
      key === 'dialogueTextSpeed' ? 0.01 : ''
    ));
    stubTextures();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type: any) => {
      if (type !== '2d') return null;
      return new Proxy({
        canvas: document.createElement('canvas'),
        font: '',
        measureText: vi.fn(() => ({ width: 100 })),
      } as Record<string, any>, {
        get(target, prop) { return prop in target ? target[prop as string] : vi.fn(); },
        set(target, prop, value) { target[prop as string] = value; return true; },
      }) as any;
    });
    vi.spyOn(PIXI.CanvasTextMetrics, 'measureText').mockReturnValue({
      lines: ['Hello'], lineWidths: [100], lineHeight: 60, maxLineWidth: 100, width: 100, height: 60,
      fontProperties: { ascent: 40, descent: 20, fontSize: 60 },
    } as any);
  });

  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.restoreAllMocks();
    stageState.subtitleLayer.destroy({ children: true });
    stageState.subtitleLayer = null;
  });

  function renderBody(presentation: ReturnType<typeof presentationWith>, style: 'instant' | 'typewriter') {
    const renderer = new SubtitleRenderer();
    const config = {
      _id: `align-${style}`, text: 'Hello', speaker: '', style, duration: 3, presentation,
    } as any;
    renderer.showDialogue(config).pause();
    renderer.ensureDialogueOnStage(config, 1);
    return stageState.subtitleLayer.children[0] as PIXI.Container;
  }

  it('centers a single-line subtitle inside the authored text column', () => {
    const container = renderBody(presentationWith(undefined), 'instant');
    const body = collectTexts(container).find((text) => text.text === 'Hello')!;
    expect(body.anchor.x).toBe(0.5);
    expect(body.x).toBe(TEXT_LINE.x + TEXT_LINE.maxWidth / 2);
  });

  it('keeps left-aligned copy flush with the text column', () => {
    const presentation = parseDialogueImagePresentation({
      renderer: 'image-dialogue-v1',
      textbox: { image: 'textbox.svg', x: 177, y: 799, width: 1566, height: 228 },
      text: { ...TEXT_LINE, align: 'left' },
    }, 'dialogueStyles[0].presentation');
    const container = renderBody(presentation, 'instant');
    const body = collectTexts(container).find((text) => text.text === 'Hello')!;
    expect(body.anchor.x).toBe(0);
    expect(body.x).toBe(TEXT_LINE.x);
  });

  it('does not shift built-in templates that never author an alignment', () => {
    const renderer = new SubtitleRenderer();
    const config = {
      _id: 'builtin-align', text: 'Hello', speaker: '', style: 'instant', duration: 3, template: 'glass',
    } as any;
    renderer.showDialogue(config).pause();
    renderer.ensureDialogueOnStage(config, 1);
    const container = stageState.subtitleLayer.children[0] as PIXI.Container;
    const body = collectTexts(container).find((text) => text.text === 'Hello')!;
    expect(body.anchor.x).toBe(0);
  });

  it('centers every line while the typewriter reveals the body text', () => {
    const container = renderBody(presentationWith(undefined), 'typewriter');
    const body = collectTexts(container).find((text) => text.text === 'Hello')!;
    // The typewriter branch positions lines itself, so the sprite anchor is reset.
    expect(body.anchor.x).toBe(0);
    expect(body.x).toBe(TEXT_LINE.x + (TEXT_LINE.maxWidth - 100) / 2);
  });

  /**
   * A right-aligned column whose authored `maxWidth` overruns its own textbox:
   * the box ends at 1900, the column starts 50px inside it at 1650, so only
   * 200px can be wrapped even though 600px was authored.
   */
  function clampedAlignPresentation() {
    return parseDialogueImagePresentation({
      renderer: 'image-dialogue-v1',
      styleId: 'clamped-align',
      textbox: { image: 'textbox.svg', x: 1600, y: 800, width: 300, height: 200 },
      text: { ...TEXT_LINE, x: 1650, y: 850, maxWidth: 600, align: 'right' },
    }, 'dialogueStyles[0].presentation');
  }

  it('clamps a right-aligned body line to the column it actually wraps to', () => {
    const body = collectTexts(renderBody(clampedAlignPresentation(), 'instant'))
      .find((text) => text.text === 'Hello')!;
    expect(body.anchor.x).toBe(1);
    // 1650 + 200, not 1650 + 600 (which would end 330px off the 1920px stage).
    expect(body.x).toBe(1850);
    expect(body.x).toBeLessThanOrEqual(1920);
  });

  it('clamps a right-aligned typewriter line to the same column', () => {
    const body = collectTexts(renderBody(clampedAlignPresentation(), 'typewriter'))
      .find((text) => text.text === 'Hello')!;
    // The typewriter branch lays out each line itself against the same span.
    expect(body.anchor.x).toBe(0);
    expect(body.x).toBe(1650 + 200 - 100);
    expect(body.x + 100).toBeLessThanOrEqual(1920);
  });
});
