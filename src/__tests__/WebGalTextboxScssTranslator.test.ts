import { describe, expect, it } from 'vitest';
import { translateWebGalTextboxScss } from '../services/import/webgal/WebGalTextboxScssTranslator';

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
.text { font-size: 240%; line-height: 1.4; }
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
  it('matches the golden presentation for a scaled template', () => {
    const { style, assetGeom } = translateWebGalTextboxScss(FIXTURE, { sourceName: 'textbox.scss' });

    expect(style).toMatchObject({ id: 'webgal-textbox', renderer: 'image-dialogue-v1' });
    expect(style.params).toEqual({
      // `scale(0.5)` is folded into every coordinate, so the authored
      // `left: 120 / width: 1740 / height: 300` becomes these values.
      textbox: {
        image: 'ui/dialogue/webgal/textbox.svg',
        nineSlice: [5, 5, 48, 37],
        x: 525,
        y: 866,
        width: 870,
        height: 116,
        opacity: 1,
      },
      namebox: {
        image: 'ui/dialogue/webgal/namebox.svg',
        nineSlice: [4, 19, 4, 19],
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
        fontWeight: '700',
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
      textbox: { width: 870, height: 116, nineSlice: [5, 5, 48, 37] },
      namebox: { width: 300, height: 57, nineSlice: [4, 19, 4, 19] },
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

  it('drops the nameplate fill when the dialogue box is frameless', () => {
    const frameless = translateWebGalTextboxScss(`
      .TextBox_main { left: 50px; right: 25px; bottom: 40px; height: 200px; font-size: 30px; }
      .TextBox_Background { background: transparent; }
      .TextBox_showName { background: rgba(0,0,0,.65); }
    `);
    // `.TextBox_showName`'s background only shades the glyphs in this style, so it
    // must not become a plate behind the name.
    expect(frameless.theme.namebox.fill).toEqual({ kind: 'solid', color: '#00000000' });

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
    expect(inherited.style.params.speaker!.fontSize).toBe(46);

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
      + '.text { font-size: 240%; }',
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
    // nameplate's is twice the body's (WebGAL's inline 200%). `nameSize` already
    // carries the transform scale, so applying it again would make the plate
    // 24px instead of 12px.
    const em = stroked('0.1em white');
    expect(em.text.strokeWidth).toBe(6);
    expect(em.speaker!.strokeWidth).toBe(12);
    // A zero outline stays zero instead of being rounded up to 1px.
    expect(stroked('0px white').speaker!.strokeWidth).toBe(0);
  });
});
