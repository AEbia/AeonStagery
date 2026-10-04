import { beforeEach, describe, expect, it, vi } from 'vitest';

const pixiMocks = vi.hoisted(() => {
  class MockContainer {
    children: any[] = [];
    parent: any = null;
    mask: any = null;
    x = 0;
    y = 0;
    alpha = 1;
    width = 0;
    height = 0;

    addChild(...children: any[]) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
      return children[0];
    }
  }

  class MockGraphics extends MockContainer {
    filters: any[] | null = null;
    fillCalls: Array<{ color?: number; alpha?: number }> = [];

    beginFill(color?: number, alpha?: number) {
      this.fillCalls.push({ color, alpha });
      return this;
    }
    drawRoundedRect() { return this; }
    roundRect() { return this; }
    stroke() { return this; }
    drawRect() { return this; }
    endFill() { return this; }
    lineStyle() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    arcTo() { return this; }
  }

  class MockText extends MockContainer {
    anchor = { set: vi.fn() };
    resolution = 1;

    public text: string;
    public style: { fontSize?: number; fill?: string | number };

    constructor(
      textOrOptions: string | { text: string; style: { fontSize?: number; fill?: string | number } },
      legacyStyle?: { fontSize?: number; fill?: string | number },
    ) {
      super();
      this.text = typeof textOrOptions === 'string' ? textOrOptions : textOrOptions.text;
      this.style = typeof textOrOptions === 'string' ? legacyStyle ?? {} : textOrOptions.style;
      const fontSize = Number(this.style.fontSize ?? 16);
      this.width = this.text.length * fontSize * 0.6;
      this.height = fontSize;
    }
  }

  class MockBlurFilter {
    blur = 0;
  }

  class MockSprite extends MockContainer {
    constructor(public texture: unknown) { super(); }
  }

  class MockNineSlicePlane extends MockSprite {
    constructor(texture: unknown, public left: number, public top: number, public right: number, public bottom: number) {
      super(texture);
    }
  }

  return { MockContainer, MockGraphics, MockText, MockBlurFilter, MockSprite, MockNineSlicePlane };
});

vi.mock('pixi.js', () => ({
  Container: pixiMocks.MockContainer,
  Graphics: pixiMocks.MockGraphics,
  Text: pixiMocks.MockText,
  Sprite: pixiMocks.MockSprite,
  NineSlicePlane: pixiMocks.MockNineSlicePlane,
  Texture: { from: vi.fn((source: string) => ({ source })) },
  BlurFilter: pixiMocks.MockBlurFilter,
  filters: {
    BlurFilter: pixiMocks.MockBlurFilter,
  },
}));

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: {
    get: vi.fn(() => ''),
  },
}));

import * as PIXI from 'pixi.js';
import { templates } from '../engine/DialogueTemplates';
import { ImageDialogueTemplate } from '../engine/ImageDialogueTemplate';
import { settingsManager } from '../ui/SettingsStore';

const getSetting = vi.mocked(settingsManager.get);

describe('DialogueTemplates render contract', () => {
  beforeEach(() => {
    getSetting.mockReturnValue('');
  });

  it('renders registered templates into the requested vertical band', () => {
    const metrics = { width: 640, height: 120 } as PIXI.CanvasTextMetrics;
    const config = {
      speaker: 'Tomori',
      speakerId: '1',
      text: 'I need this line to stay inside the dialogue box.',
      fontSize: 44,
    };

    for (const template of Object.values(templates)) {
      const topContainer = new PIXI.Container();
      const centerContainer = new PIXI.Container();
      const bottomContainer = new PIXI.Container();

      const top = template.render(topContainer, { ...config, position: 'top' }, metrics);
      const center = template.render(centerContainer, { ...config, position: 'center' }, metrics);
      const bottom = template.render(bottomContainer, { ...config, position: 'bottom' }, metrics);

      expect(topContainer.children.length, template.id).toBeGreaterThan(0);
      expect(centerContainer.children.length, template.id).toBeGreaterThan(0);
      expect(bottomContainer.children.length, template.id).toBeGreaterThan(0);

      expect(top.boxY, template.id).toBeLessThan(center.boxY);
      expect(center.boxY, template.id).toBeLessThan(bottom.boxY);

      for (const layout of [top, center, bottom]) {
        expect(layout.textX, template.id).toBeGreaterThanOrEqual(0);
        expect(layout.textY, template.id).toBeGreaterThanOrEqual(layout.boxY);
        expect(layout.textWidth, template.id).toBeGreaterThan(0);
        expect(layout.textHeight, template.id).toBeGreaterThan(0);
        expect(layout.boxHeight, template.id).toBeGreaterThanOrEqual(metrics.height);
        expect(layout.boxY + layout.boxHeight, template.id).toBeLessThanOrEqual(1080);
      }
    }
  });

  it('renders the configured glass signature as two adjacent text runs', () => {
    getSetting.mockImplementation((key: string) => ({
      dialogueSignatureText1: 'AEON',
      dialogueSignatureColor1: '#B0E0FF',
      dialogueSignatureText2: 'STAGE',
      dialogueSignatureColor2: '#FFD1E8',
    }[key] ?? ''));

    const container = new PIXI.Container();
    templates.glass.render(container, {
      speaker: 'Tomori',
      text: 'A signature should travel with the glass dialogue style.',
      position: 'bottom',
    }, { width: 640, height: 120 } as PIXI.CanvasTextMetrics);

    const maskedBackground = container.children.find((child: any) => child.mask) as PIXI.Container | undefined;
    expect(maskedBackground).toBeDefined();
    const glassBox = maskedBackground!.children[0] as PIXI.Container;
    const signature = glassBox.children.find((child: any) => child.alpha === 0.8) as PIXI.Container | undefined;
    expect(signature).toBeDefined();
    const signatureTextRuns = signature!.children as PIXI.Text[];

    expect(signatureTextRuns.map((child) => child.text)).toEqual(['AEON', 'STAGE']);
    expect(signatureTextRuns[0].style.fill).toBe('#B0E0FF');
    expect(signatureTextRuns[1].style.fill).toBe('#FFD1E8');
    expect(signatureTextRuns[1].x).toBeGreaterThan(signatureTextRuns[0].x);
  });

  it('renders template-owned textbox and namebox images with a nine-slice panel', () => {
    const container = new PIXI.Container();
    const config = {
      speaker: 'Tomori',
      speakerColor: '#8db7ff',
      text: 'A package image defines the dialogue chrome.',
      presentation: {
        renderer: 'image-dialogue-v1' as const,
        textbox: { image: 'asset://textbox.png', nineSlice: [32, 32, 32, 32] as const, x: 120, y: 760, width: 1680, minHeight: 240 },
        namebox: { image: 'asset://namebox.png', x: 160, y: 690, width: 320, height: 88 },
        text: { fontFamily: 'Demo Dialogue', fontSize: 46, x: 190, y: 820, maxWidth: 1500 },
        speaker: { fontFamily: 'Demo Dialogue', fontSize: 40, color: '$characterColor' },
      },
    };

    const layout = ImageDialogueTemplate.render(container, config, { width: 640, height: 120 } as PIXI.CanvasTextMetrics);

    expect(container.children[0]).toBeInstanceOf(pixiMocks.MockNineSlicePlane);
    expect((container.children[0] as any).width).toBe(1680);
    expect(container.children[1]).toBeInstanceOf(pixiMocks.MockSprite);
    expect((container.children[2] as any).text).toBe('Tomori');
    expect((container.children[2] as any).style.fill).toBe('#8db7ff');
    expect(ImageDialogueTemplate.resolveTextStyle!(config)).toMatchObject({
      stroke: { color: 'transparent', width: 0 },
      dropShadow: false,
    });
    expect(layout).toMatchObject({ textX: 190, textY: 820, textWidth: 1500, boxY: 760 });
  });

  it('keeps speaker text inside the namebox safe area and extends the panel for long names', () => {
    const container = new PIXI.Container();
    ImageDialogueTemplate.render(container, {
      speaker: 'A very long speaker name',
      text: 'Dialogue',
      presentation: {
        renderer: 'image-dialogue-v1' as const,
        textbox: { image: 'asset://textbox.svg', x: 120, y: 760, width: 1680, height: 240 },
        namebox: {
          image: 'asset://namebox.svg',
          nineSlice: [45, 44, 110, 44] as const,
          x: 150,
          y: 690,
          width: 320,
          height: 90,
        },
        text: { x: 190, y: 820, maxWidth: 1500 },
        speaker: { fontSize: 40, padding: [48, 0, 120, 0] as const },
      },
    }, { width: 300, height: 60 } as PIXI.CanvasTextMetrics);

    const namebox = container.children[1] as any;
    const speaker = container.children[2] as any;
    expect(namebox).toBeInstanceOf(pixiMocks.MockNineSlicePlane);
    expect(namebox.width).toBeGreaterThan(320);
    expect(speaker.x).toBe(namebox.x + 48 + (namebox.width - 48 - 120) / 2);
    expect(speaker.y).toBe(namebox.y + namebox.height / 2);
  });

  it('applies controlled alignment, outline and shadow settings for cinematic image dialogue', () => {
    expect(ImageDialogueTemplate.resolveTextStyle!({
      speaker: '',
      text: 'Cinematic subtitle',
      presentation: {
        renderer: 'image-dialogue-v1' as const,
        textbox: { image: 'asset://transparent.svg', x: 100, y: 655, width: 1720, height: 425 },
        text: {
          x: 300,
          y: 725,
          maxWidth: 1320,
          align: 'center' as const,
          strokeColor: '#242424',
          strokeWidth: 8,
          dropShadow: true,
          dropShadowColor: '#000000',
          dropShadowAlpha: 0.9,
          dropShadowBlur: 15,
          dropShadowDistance: 4,
        },
      },
    })).toMatchObject({
      align: 'center',
      stroke: { color: '#242424', width: 8 },
      dropShadow: { color: '#000000', alpha: 0.9, blur: 15, distance: 4 },
    });
  });

  it('maintains constant nametag color defaulting to #FFD700 without choosing color by id', () => {
    const metrics = { width: 640, height: 120 } as PIXI.CanvasTextMetrics;

    // Test with various speakerIds ('1', '2', '3', 'custom_id') without explicit speakerColor
    for (const speakerId of ['1', '2', '3', 'hero_1']) {
      const config = {
        speaker: 'Hero',
        speakerId,
        text: 'Speaking line',
      };

      // Minimal template check
      const minimalContainer = new PIXI.Container();
      templates.minimal.render(minimalContainer, config, metrics);
      const minimalSpeakerText = minimalContainer.children.find((child: any) => child instanceof pixiMocks.MockText && child.text === 'Hero') as any;
      expect(minimalSpeakerText?.style.fill).toBe('#FFD700');

      // Classic template check
      const classicContainer = new PIXI.Container();
      templates.classic.render(classicContainer, config, metrics);
      const classicSpeakerText = classicContainer.children.find((child: any) => child instanceof pixiMocks.MockText && child.text === '【 Hero 】') as any;
      expect(classicSpeakerText?.style.fill).toBe('#FFD700');

      // Glass template check (plate fill)
      const glassContainer = new PIXI.Container();
      templates.glass.render(glassContainer, config, metrics);
      // In glass template, speaker plate graphics uses colorNum = 0xFFD700
      const allGraphics: Array<{ fillCalls: Array<{ color?: number; alpha?: number }> }> = [];
      const collectGraphics = (c: any) => {
        if (c instanceof pixiMocks.MockGraphics) allGraphics.push(c);
        if (c.children) c.children.forEach(collectGraphics);
      };
      collectGraphics(glassContainer);
      const hasGoldFill = allGraphics.some((g) => g.fillCalls.some((f: { color?: number }) => f.color === 0xFFD700));
      expect(hasGoldFill).toBe(true);
    }

    // Test with explicit speakerColor
    const customColorConfig = {
      speaker: 'Hero',
      speakerId: '1',
      speakerColor: '#336699',
      text: 'Speaking line',
    };

    const minimalContainer = new PIXI.Container();
    templates.minimal.render(minimalContainer, customColorConfig, metrics);
    const minimalSpeakerText = minimalContainer.children.find((child: any) => child instanceof pixiMocks.MockText && child.text === 'Hero') as any;
    expect(minimalSpeakerText?.style.fill).toBe('#336699');
  });
});
