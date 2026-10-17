import { describe, expect, it } from 'vitest';
import { translateWebGalTextboxScss } from '../services/import/webgal/WebGalTextboxScssTranslator';
import { buildWebGalScssAssetTable } from '../services/import/webgal/WebGalTextboxScssAssets';

/**
 * A synthetic template exercising every branch the converter cares about:
 * `transform: scale()`, a gradient nameplate, a corner ornament, a
 * `background-clip: text` body colour, an outline plus a zero-offset glow, and
 * `align-items: flex-start`.
 */
const FIXTURE = `
.TextBox_main {
  position: absolute;
  left: 120px;
  right: 120px;
  bottom: 60px;
  height: 300px;
  padding: 40px;
  font-size: 40px;
  transform: scale(0.5);
  align-items: flex-start;
}
.text { font-size: 240% !important; line-height: 1.4; padding-left:0 !important; }
.TextBox_Background {
  background: rgba(255, 255, 255, 0.8);
  border: 2px solid black;
  border-radius: 24px;
  box-shadow: 0 6px 20px rgba(190, 190, 190, 0.8);
}
.TextBox_Background::after {
  width: 105px; height: 105px; right: 8px; bottom: -5px; opacity: 0.4;
  background-image: url('assets/textbox-meteor.svg');
}
.outer { color: transparent; background: #123456; background-clip: text; }
.inner { -webkit-text-stroke: 4px white; text-shadow: 0 0 12px rgba(0,0,0,.9); }
.TextBox_showName {
  left: 24px;
  top: -72px;
  min-width: 10em;
  padding-left: 1.5em;
  font-size: 100%;
}
.outerName { color: #FFFFFFCC; }
.TextBox_ShowName_Background {
  background: linear-gradient(180deg, #ff9ec4, #ff3b72);
  border-radius: 9999px;
}
.innerName { -webkit-text-stroke: 6px #ff3b72; }
`;

describe('translateWebGalTextboxScss', () => {
  it.each([
    ['right:200px', -150],
    ['left:200px', 150],
    ['left:200px; right:100px', 150],
  ])('moves relative text without changing its wrapping width: %s', (offsets, shift) => {
    const scss = `
      .TextBox_main { left:0; right:0; padding:0; }
      .text { position:relative; padding:0 !important; }
    `;
    const baseline = translateWebGalTextboxScss(scss).style.params.text;
    const moved = translateWebGalTextboxScss(`${scss} .text { ${offsets}; }`).style.params.text;
    expect(moved.maxWidth).toBe(baseline.maxWidth);
    expect(moved.x).toBe(baseline.x + shift);
  });

  it.each([
    ['static', 'border-box', '', 600],
    ['relative', 'border-box', '', 600],
    ['absolute', 'border-box', '', 600],
    ['static', 'border-box', 'border:10px solid black;', 584],
    ['static', 'content-box', '', 750],
  ])('resolves explicit %s text content width with %s and %s', (position, boxSizing, border, maxWidth) => {
    const { text } = translateWebGalTextboxScss(`
      .TextBox_main { left:0; right:0; padding:0; }
      .text { position:${position}; width:1000px; box-sizing:${boxSizing};
        padding:0 100px !important; ${border} }
    `).style.params;
    expect(text).toMatchObject({ x:border ? 83 : 75, maxWidth });
  });

  it('centers a relative explicit-width text box before applying its offset', () => {
    const { text } = translateWebGalTextboxScss(`
      .TextBox_main { left:0; right:0; padding:0; align-items:center; }
      .text { position:relative; right:200px; width:1000px; box-sizing:border-box; padding:0 100px !important; }
    `).style.params;
    expect(text).toMatchObject({ x:510, maxWidth:600 });
  });

  it('positions absolute border-box text using its outer width', () => {
    const { text } = translateWebGalTextboxScss(`
      .TextBox_main { left:0; right:0; padding:0; }
      .text { position:absolute; right:200px; width:1000px; box-sizing:border-box; padding:0 100px !important; }
    `).style.params;
    expect(text).toMatchObject({ x:1095, maxWidth:600 });
  });

  it('centers a nameplate inside the main content box', () => {
    const { namebox } = translateWebGalTextboxScss(`
      .TextBox_main { left:0; right:0; padding:0 0 0 200px; align-items:center; }
      .TextBox_showName { position:relative; }
    `).style.params;
    expect(namebox).toMatchObject({ x:1035, anchorX:0.5 });
  });

  it('converts important colors, alignment and font weights without falling back', () => {
    const { style, theme } = translateWebGalTextboxScss(`
      .TextBox_main {
        font-size: 40px; color: black !important; background: red !important;
        text-align: right !important; font-weight: 700 !important;
      }
      .TextBox_main { color: white; background: blue; text-align: left; font-weight: 400; }
      .TextBox_showName { color: red !important; text-align: right !important; font-weight: 700 !important; }
      .TextBox_showName { color: blue; text-align: center; font-weight: 400; }
    `);
    expect(style.params.text).toMatchObject({ color: '#000000', align: 'right', fontWeight: '700' });
    expect(style.params.speaker).toMatchObject({ color: '#FF0000', align: 'right', fontWeight: '700' });
    expect(theme.textbox.fill).toEqual({ kind: 'solid', color: '#FF0000FF' });
  });

  it('uses the root font size for rem typography and nameplate geometry', () => {
    const { style } = translateWebGalTextboxScss(`
      .TextBox_main { font-size: 40px; }
      .text { font-size: 2rem !important; }
      .TextBox_showName {
        font-size: 1rem !important; height: 4rem; min-width: 10rem;
        padding-left: 2rem; padding-right: 2rem;
      }
    `);
    expect(style.params.text.fontSize).toBe(30);
    expect(style.params.speaker).toMatchObject({ fontSize: 15, padding: [30, 0, 30, 0] });
    expect(style.params.namebox).toMatchObject({ width: 150, minHeight: 60 });
  });

  it('uses explicit body declarations before inherited parent values', () => {
    const { style } = translateWebGalTextboxScss(`
      .TextBox_main { font-size:40px; line-height:2 !important; text-align:right !important; font-family:Parent !important; }
      .text { font-size: 100% !important; line-height:1.5; text-align:left; font-family:Child; }
    `);
    expect(style.params.text).toMatchObject({
      fontSize: 30, lineHeight: 45, align: 'left', fontFamily: 'Child',
    });
  });

  it('falls back to inherited body declarations when the child declares none', () => {
    const { style } = translateWebGalTextboxScss(`
      .TextBox_main { font-size:40px; line-height:2; text-align:right; font-family:Parent; }
      .text { font-size: 100% !important; }
    `);
    expect(style.params.text).toMatchObject({
      fontSize: 30, lineHeight: 60, align: 'right', fontFamily: 'Parent',
    });
  });

  it('matches the golden presentation for a scaled template', () => {
    const { style, assetGeom } = translateWebGalTextboxScss(FIXTURE, { sourceName: 'textbox.scss' });

    expect(style).toMatchObject({ id: 'webgal-textbox', renderer: 'image-dialogue-v1' });
    expect(style.params).toEqual({
      // `scale(0.5)` is folded into every coordinate, so the authored
      // `left: 120 / width: 1740 / height: 300` becomes these values.
      textbox: {
        image: 'ui/dialogue/webgal/textbox.svg',
        // `.TextBox_Background { border-radius: 24px }` is the panel the artwork is
        // drawn from: 24 → 18 stage px → 9 once the 0.5 scale is folded in.
        // The nameplate rule alone declares no radius, which read as 0.
        nineSlice: [14, 14, 48, 37],
        x: 525,
        y: 866,
        width: 870,
        height: 116,
        opacity: 1,
      },
      namebox: {
        image: 'ui/dialogue/webgal/namebox.svg',
        // `.TextBox_ShowName_Background { border-radius: 9999px }` is a pill, so
        // the radius is half the 57px plate — not the 0 the nameplate rule
        // alone would have produced.
        nineSlice: [28, 19, 28, 19],
        x: 534,
        y: 839,
        width: 300,
        minHeight: 57,
      },
      text: {
        fontFamily: 'sans-serif',
        // `.text { font-size: 240% }` is a declaration of its own, resolved
        // against `.TextBox_main`'s 40px: 40 → 30 stage px → 96 stage px → 36
        // once the 0.5 container scale is folded in. Reading only the parent
        // would give 30.
        fontSize: 36,
        // CSS initial font weight is normal and is inherited by both layers.
        fontWeight: '400',
        color: '#123456',
        x: 540,
        y: 881,
        maxWidth: 840,
        // 1.4 × the resolved 36px body size.
        lineHeight: 51,
        align: 'left',
        // `-webkit-text-stroke: 4px white`
        strokeColor: '#FFFFFF',
        strokeWidth: 2,
        dropShadow: true,
        dropShadowColor: '#000000',
        dropShadowAlpha: 0.902,
        dropShadowBlur: 5,
        dropShadowDistance: 0,
      },
      speaker: {
        fontFamily: 'sans-serif',
        fontSize: 30,
        fontWeight: '400',
        color: '#FFFFFF',
        align: 'left',
        // `padding-left: 1.5em` is relative to the nameplate's own 60px size
        // (90 → 45 once the 0.5 container scale is folded in), not to a value
        // that already carries the stage scale.
        padding: [45, 0, 0, 0],
        strokeColor: '#FF3B72',
        // 6px raw WebGAL length: the stage scale and the template's scale(0.5)
        // each apply once, which is what the body outline gets too.
        strokeWidth: 2,
      },
    });

    // The artwork canvas matches what the engine draws; the textbox reserves the
    // downward box-shadow so it is not clipped.
    expect(assetGeom).toEqual({
      // Both radii come from the background layers: 24px on the textbox, a
      // 9999px pill on the nameplate (clamped to half its 57px height).
      textbox: { width: 870, height: 116, nineSlice: [14, 14, 48, 37] },
      namebox: { width: 300, height: 57, nineSlice: [28, 19, 28, 19] },
    });
  });

  it('reads the fill, radius, shadow and ornament of both panels', () => {
    const { theme } = translateWebGalTextboxScss(FIXTURE, { sourceName: 'textbox.scss' });
    expect(theme.textbox.fill).toEqual({ kind: 'solid', color: '#ffffffcc' });
    expect(theme.textbox.border).toEqual({ width: 1, color: '#000000FF' });
    expect(theme.textbox.shadow).toEqual({
      dx: 0, dy: 3, blur: 8, spread: 0, color: '#bebebecc',
    });
    expect(theme.textbox.deco).toEqual({
      file: 'textbox-meteor.svg', size: 40, opacity: 0.4, rotate: 0, right: 3, bottom: -2,
    });
    expect(theme.namebox.fill).toMatchObject({ kind: 'linear', angle: 180 });
  });

  it('keeps a symmetric glow direction-free', () => {
    // The engine's drop shadow only points one way, so an offset-free glow has
    // to lose its distance or it renders as a corner smudge.
    const { style } = translateWebGalTextboxScss(FIXTURE, { sourceName: 'textbox.scss' });
    expect(style.params.text.dropShadowDistance).toBe(0);

    const fourWay = translateWebGalTextboxScss(`
      .TextBox_main { left: 50px; right: 25px; bottom: 40px; height: 200px; font-size: 40px; }
      .inner { text-shadow:
        -1.5px -1.5px 10px rgba(0,0,0,.85), 1.5px -1.5px 10px rgba(0,0,0,.85),
        -1.5px  1.5px 10px rgba(0,0,0,.85), 1.5px  1.5px 10px rgba(0,0,0,.85),
        0 2px 50px rgba(0,0,0,.3); }
    `);
    expect(fourWay.style.params.text.dropShadowDistance).toBe(0);
    expect(fourWay.style.params.text.dropShadowAlpha).toBeCloseTo(217 / 255, 3);
  });

  it('keeps an authored nameplate fill when the dialogue box is frameless', () => {
    const frameless = translateWebGalTextboxScss(`
      .TextBox_main { left: 50px; right: 25px; bottom: 40px; height: 200px; font-size: 30px; }
      .TextBox_Background { background: transparent; }
      .TextBox_showName { background: rgba(0,0,0,.65); }
    `);
    // The visible label has its own background independently of the body panel.
    expect(frameless.theme.namebox.fill).toEqual({ kind: 'solid', color: '#000000a6' });

    const framed = translateWebGalTextboxScss(`
      .TextBox_main { left: 50px; right: 25px; bottom: 40px; height: 200px; font-size: 30px; }
      .TextBox_Background { background: rgba(255,255,255,.8); }
      .TextBox_showName { background: rgba(0,0,0,.65); }
    `);
    expect(framed.theme.namebox.fill).toEqual({ kind: 'solid', color: '#000000a6' });
  });

  it('honours the engine inline 200% nameplate font-size unless the template insists', () => {
    // WebGAL puts an inline `font-size: 200%` on both nameplate divs, so a plain
    // rule loses to it; only `!important` overrides.
    const inherited = translateWebGalTextboxScss(
      '.TextBox_main { font-size: 30px; }\n.TextBox_showName { font-size: 100%; }',
    );
    // 30 source px × inline 200% × 0.75 = 45; parent rounding must not intervene.
    expect(inherited.style.params.speaker!.fontSize).toBe(45);

    const forced = translateWebGalTextboxScss(
      '.TextBox_main { font-size: 30px; }\n.TextBox_showName { font-size: 100% !important; }',
    );
    // `100%` resolves against the 30px parent, so 23 stage px. Rescaling it
    // again folds the stage scale in twice and lands on 17.
    expect(forced.style.params.speaker!.fontSize).toBe(23);
  });

  it('resolves the body font size against the parent, not the root', () => {
    const { style } = translateWebGalTextboxScss(
      '.TextBox_main { left: 60px; right: 60px; bottom: 40px; height: 200px; font-size: 40px; }\n'
      + '.text { font-size: 240% !important; }',
    );
    // The parent resolves to 30 stage px, so `240%` of it is 72 — not 30 (the
    // parent, as if `.text` had said nothing) and not 38 (the root size).
    expect(style.params.text!.fontSize).toBe(72);
  });

  it('merges a repeated selector instead of dropping its earlier declarations', () => {
    // Templates split one selector across blocks; CSS keeps both and lets the
    // later rule override only the properties it declares.
    const { style } = translateWebGalTextboxScss(`
      .TextBox_main { left: 120px; right: 120px; height: 300px; font-size: 40px; }
      .TextBox_Background { background: #000000; }
      .TextBox_main { color: #ff0000; }
    `);
    // Without the merge the geometry is gone and `left` falls back to 50 × 0.75.
    expect(style.params.textbox!.x).toBe(90);
    // The stage width minus both resolved insets.
    expect(style.params.textbox!.width).toBe(1920 - 90 * 2);
  });

  it('centres the text column when asked, and reports the template offset otherwise', () => {
    const asymmetric = '.TextBox_main { left: 300px; right: 100px; bottom: 60px; height: 200px; font-size: 30px; }';
    const faithful = translateWebGalTextboxScss(asymmetric);
    expect(faithful.style.params.textbox.x).toBe(225);
    expect(faithful.notes.some((note) => note.includes('水平偏心'))).toBe(true);

    const centred = translateWebGalTextboxScss(asymmetric, { strictCenter: true });
    const box = centred.style.params.textbox!;
    expect(box.x).toBe(Math.round((1920 - box.width) / 2));
  });

  it('carries a template font through to both text layers', () => {
    const { style } = translateWebGalTextboxScss(FIXTURE, {
      sourceName: 'textbox.scss',
      fontFamily: 'Noto Sans SC',
      fontFile: 'fonts/NotoSansSC.otf',
    });
    expect(style.params.text.fontFamily).toBe('Noto Sans SC');
    expect(style.params.text.fontFile).toBe('fonts/NotoSansSC.otf');
    expect(style.params.speaker!.fontFile).toBe('fonts/NotoSansSC.otf');
  });

  it('explains the decisions it made', () => {
    const { notes } = translateWebGalTextboxScss(FIXTURE, { sourceName: 'textbox.scss' });
    expect(notes.some((note) => note.includes('transform: scale(0.5)'))).toBe(true);
    expect(notes.some((note) => note.includes('text-shadow'))).toBe(true);
    expect(notes.some((note) => note.includes('名牌文字描边'))).toBe(true);
    expect(notes.some((note) => note.includes('入场动画无法迁移'))).toBe(true);
  });

  it('keeps the declarations a trailing comment sits in front of', () => {
    const commented = `.TextBox_main {
  font-size:40px; // base font
  left:120px; right:120px; height:300px;
}
.text { }
.outer { }
.inner { }
.outerName { }
.innerName { }
`;
    const { style } = translateWebGalTextboxScss(commented, { sourceName: 'textbox.scss' });
    // Without the comment being stripped the block only declared a font size,
    // so the box fell back to 50 × 0.75 for its position.
    expect(style.params.textbox!.x).toBe(90);
    expect(style.params.textbox!.width).toBe(1920 - 90 * 2);
    expect(style.params.textbox!.height).toBe(225);
  });

  it('lets the nested rule win over the plain one', () => {
    // `.text` inherits 40px from `.TextBox_main`, and 200% of that is 80 WebGAL
    // px → 60 stage px. Reading only the plain `.text` gave 100% of 40px = 30.
    const nested = `.TextBox_main { font-size:40px; .text { font-size: 200% !important; } }
.text { font-size: 100% !important; }
.outer { }
.inner { }
.outerName { }
.innerName { }
`;
    const { style } = translateWebGalTextboxScss(nested, { sourceName: 'textbox.scss' });
    expect(style.params.text!.fontSize).toBe(60);
  });

  it('reads the border radius the background layers declare', () => {
    // The panels are drawn from the background layer, so its radius is the one
    // the user sees; reading only `.TextBox_main` produced square corners.
    const rounded = `.TextBox_main { left:120px; right:120px; bottom:60px; height:300px; font-size:40px; }
.TextBox_Background { border-radius:24px; }
.TextBox_ShowName_Background { border-radius:9999px; }
.text { }
.outer { }
.inner { }
.outerName { }
.innerName { }
`;
    const { theme, style } = translateWebGalTextboxScss(rounded, { sourceName: 'textbox.scss' });
    // 24px on the WebGAL stage is 18 stage px; 9999px is clamped to a pill.
    expect(theme.textbox.radius).toBe(18);
    expect(theme.namebox.radius).toBeGreaterThan(0);
    const table = buildWebGalScssAssetTable(theme, {
      textbox: { width: 1600, height: 400 }, namebox: { width: 600, height: 200 },
    }, null);
    expect(table['wg-textbox'].svg).toContain('rx="18"');
    // A pill resolves to half the panel height rather than the authored 9999px.
    expect(table['wg-namebox'].svg).toMatch(/rx="[1-9]/);
    void style;
  });

  it('never emits a number the renderer cannot use', () => {
    // `border-radius` and `font-size` reject negative lengths in CSS, and a
    // zero font size measures as empty text — but a template can say it anyway.
    // PIXI takes the nine-slice insets unclamped, so a negative one would reach
    // the plane as-is.
    const hostile = (declarations: Record<string, string>) => {
      const css = [
        '.TextBox_main {',
        ...Object.entries(declarations).map(([key, value]) => `  ${key}: ${value};`),
        '}',
        '.text { } .outer { } .inner { } .outerName { } .innerName { }',
      ].join('\n');
      return translateWebGalTextboxScss(css, { sourceName: 'textbox.scss' }).style.params as any;
    };

    const numbers = (params: unknown): number[] => {
      const out: number[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
        else if (typeof value === 'number') out.push(value);
      };
      walk(params);
      return out;
    };

    for (const [label, declarations] of Object.entries({
      '负圆角': { height: '300px', 'font-size': '40px', 'border-radius': '-50px' },
      '零字号': { height: '300px', 'font-size': '0px' },
      '负字号': { height: '300px', 'font-size': '-40px' },
      '零缩放': { height: '300px', 'font-size': '40px', transform: 'scale(0)' },
      '负高度': { height: '-100px', 'font-size': '40px' },
    } as Record<string, Record<string, string>>)) {
      const params = hostile(declarations);
      const all = numbers(params);
      expect(all.every(Number.isFinite), `${label}: 出现 NaN/Infinity`).toBe(true);
      expect(params.textbox.nineSlice.every((v: number) => v >= 0), `${label}: nine-slice 为负`).toBe(true);
      expect(params.namebox.nineSlice.every((v: number) => v >= 0), `${label}: 名牌 nine-slice 为负`).toBe(true);
      expect(params.text.fontSize, `${label}: 正文字号非正`).toBeGreaterThan(0);
      expect(params.speaker.fontSize, `${label}: 名牌字号非正`).toBeGreaterThan(0);
      expect(params.textbox.width, `${label}: 文本框宽度为负`).toBeGreaterThan(0);
      expect(params.textbox.height, `${label}: 文本框高度为负`).toBeGreaterThan(0);
      expect(params.textbox.nineSlice, `${label}: nine-slice 超出面板`)
        .toEqual(params.textbox.nineSlice.map((v: number) => Math.max(0, v)));
    }
  });

  it('resolves layout percentages against the containing block', () => {
    const percent = `.TextBox_main {
  left: 10%;
  right: 10%;
  bottom: 10%;
  height: 300px;
  font-size: 40px;
}
.text { }
.outer { }
.inner { }
.outerName { }
.innerName { }
`;
    const { style } = translateWebGalTextboxScss(percent, { sourceName: 'textbox.scss' });
    // 10% of the 1920×1080 stage, not 10% of a 20px root font size (which made
    // the box nearly full-screen: x=2, width=1916, y=853).
    expect(style.params.textbox!.x).toBe(192);
    expect(style.params.textbox!.width).toBe(1536);
    expect(style.params.textbox!.y).toBe(747);
  });

  it('scales the nameplate outline once, matching the body outline', () => {
    const stroked = (declaration: string) => translateWebGalTextboxScss(`.TextBox_main {
  font-size: 40px;
  transform: scale(2);
}
.text { }
.outer { }
.inner { -webkit-text-stroke: ${declaration}; }
.outerName { }
.innerName { -webkit-text-stroke: ${declaration}; }
`, { sourceName: 'textbox.scss' }).style.params;

    // `px`: raw WebGAL length, so the stage scale and the transform both apply.
    const px = stroked('4px white');
    expect(px.text.strokeWidth).toBe(6);
    expect(px.speaker!.strokeWidth).toBe(px.text.strokeWidth);
    // `em`: each element resolves it against its own font size, and the
    // body and name use WebGAL's inline 205% / 200% sizes. `nameSize` already
    // carries the transform scale, so applying it again would make the plate
    // 24px instead of 12px.
    const em = stroked('0.1em white');
    expect(em.text.strokeWidth).toBe(12);
    expect(em.speaker!.strokeWidth).toBe(12);
    // A zero outline stays zero instead of being rounded up to 1px.
    expect(stroked('0px white').speaker!.strokeWidth).toBe(0);
  });
});
