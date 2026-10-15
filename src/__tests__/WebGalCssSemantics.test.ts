import { describe, expect, it } from 'vitest';
import { mapWebGalTextboxStyle, translateWebGalTextboxScss } from '../services/import/webgal/WebGalTextboxScssTranslator';
import { computeWebGalTextboxStyle } from '../services/import/webgal/WebGalComputedStyle';
import { parseScssRules } from '../services/import/webgal/WebGalScssSyntax';
import { buildWebGalTextboxTemplatePackage } from '../services/import/webgal/WebGalTextboxScssPackage';

describe('WebGAL CSS fidelity', () => {
  it.each([0, 0.25, 1])('preserves background opacity %s in the generated presentation', (opacity) => {
    const nameOpacity = 1 - opacity;
    const result = buildWebGalTextboxTemplatePackage({
      templateId: 'opacity', templateName: 'Opacity',
      scss: `
        .TextBox_Background { background:black; opacity:${opacity}; border:2px solid red; }
        .TextBox_ShowName_Background { background:blue; opacity:${nameOpacity}; }
      `,
    });
    expect(result.style.params.textbox.opacity).toBe(opacity);
    expect(result.style.params.namebox?.opacity ?? 1).toBe(nameOpacity);
    // Backdrop opacity must not fade the independent text layers.
    expect(result.style.params.text.color).toBe('#FFFFFF');
    expect(result.style.params.speaker?.color).toBe('#FFFFFF');
  });

  it('uses visible layer typography for body and name text, including relative units and scale', () => {
    const { params } = buildWebGalTextboxTemplatePackage({
      templateId: 'typography', templateName: 'Typography',
      scss: `
        .TextBox_main { font-size:40px; transform:scale(0.5); }
        .text { font-size:40px; font-weight:400; }
        .outer { font-size:2em; font-weight:700; line-height:1.5; }
        .TextBox_showName { font-weight:400; }
        .outerName { font-size:1.5em; font-weight:700; line-height:2; }
      `,
    }).style;
    expect(params.text).toMatchObject({ fontSize: 30, fontWeight: '700', lineHeight: 45 });
    expect(params.speaker).toMatchObject({ fontSize: 45, fontWeight: '700' });
    expect(params.namebox?.minHeight).toBe(90);
  });

  it('excludes shadows from hidden layers and keeps a child that restores visibility', () => {
    const hidden = translateWebGalTextboxScss(`
      .inner { visibility:hidden; text-shadow:0 0 10px red; -webkit-text-stroke:2px red; }
      .outerName { visibility:hidden; text-shadow:0 0 10px red; }
    `).style.params;
    expect(hidden.text.dropShadow ?? false).toBe(false);
    expect(hidden.text.strokeWidth).toBe(0);
    expect(hidden.speaker?.dropShadow ?? false).toBe(false);

    const visible = translateWebGalTextboxScss(`
      .text { visibility:hidden; text-shadow:0 0 10px red; }
      .inner { visibility:visible; }
    `).style.params;
    expect(visible.text.dropShadow).toBe(true);
  });

  it('lets an important background longhand override the shorthand', () => {
    const result = translateWebGalTextboxScss(`
      .TextBox_Background { background: red; background-color: blue !important; }
    `);
    expect(result.theme.textbox.fill).toEqual({ kind: 'solid', color: '#0000FFFF' });
  });

  it('lets an important padding shorthand reset an earlier longhand', () => {
    const { params } = translateWebGalTextboxScss(`
      .TextBox_main { padding-left: 80px; padding: 0 !important; }
    `).style;
    expect(params.text.x).toBe(params.textbox.x);
    expect(params.text.maxWidth).toBe(params.textbox.width);
  });

  it('uses the main element font size for em padding', () => {
    const { params } = translateWebGalTextboxScss(`
      .TextBox_main { font-size: 40px; padding: 1em; }
    `).style;
    expect(params.text.x - params.textbox.x).toBe(30);
    expect(params.text.y - params.textbox.y).toBe(30);
    expect(params.textbox.width - params.text.maxWidth).toBe(60);
  });

  it('applies inline 200% name font size to an inherited root font', () => {
    const { params } = translateWebGalTextboxScss(`
      .TextBox_showName { font-size: 100%; padding: 1em; min-width: 10em; }
    `).style;
    expect(params.speaker?.fontSize).toBe(30);
    expect(params.speaker?.padding).toEqual([30, 30, 30, 30]);
    expect(params.namebox?.width).toBe(300);
  });

  it('keeps explicit text-shadow none disabled on body and name', () => {
    const { params } = translateWebGalTextboxScss(`
      .inner { text-shadow: none; }
      .outerName { text-shadow: none; }
    `).style;
    expect(params.text.dropShadow ?? false).toBe(false);
    expect(params.speaker?.dropShadow ?? false).toBe(false);
  });

  it('distributes omitted gradient stops and preserves the red-to-green span', () => {
    const result = translateWebGalTextboxScss(`
      .TextBox_Background { background: linear-gradient(red, green, blue); }
      .outer { background: linear-gradient(red, green, blue); background-clip: text; }
    `);
    expect(result.theme.textbox.fill.kind).toBe('linear');
    if (result.theme.textbox.fill.kind === 'linear') {
      expect(result.theme.textbox.fill.stops.map((stop) => stop.pos)).toEqual([0, 0.5, 1]);
    }
    expect(result.style.params.text.color).toBe('#FF0000');
  });
});

describe('computed WebGAL style seam', () => {
  it.each([
    ['padding-left:80px; padding:0;', 0],
    ['padding:0; padding-left:80px;', 60],
    ['padding-left:80px !important; padding:0;', 60],
    ['padding-left:80px; padding:0 !important;', 0],
    ['padding-left:80px !important; padding:0 !important;', 0],
    ['padding:0 !important; padding-left:80px !important;', 60],
  ])('cascades padding before resolving lengths: %s', (declarations, left) => {
    expect(computeWebGalTextboxStyle(`.TextBox_main { ${declarations} }`).main.padding)
      .toEqual({ t: 0, r: 0, b: 0, l: left });
  });

  it.each([
    ['background:red; background-color:blue;', '#0000FFFF'],
    ['background-color:blue; background:red;', '#FF0000FF'],
    ['background-color:blue !important; background:red;', '#0000FFFF'],
    ['background:red !important; background-color:blue;', '#FF0000FF'],
    ['background:red; background-color:blue !important;', '#0000FFFF'],
    ['background:red !important; background-color:blue !important;', '#0000FFFF'],
  ])('cascades background before selecting paint: %s', (declarations, color) => {
    expect(computeWebGalTextboxStyle(`.TextBox_Background { ${declarations} }`).background.background)
      .toEqual({ kind: 'solid', color });
  });

  it('resets background images and retains important image longhands', () => {
    const reset = computeWebGalTextboxStyle(`
      .TextBox_Background { background-image:linear-gradient(red, blue); background:white; }
    `);
    expect(reset.background.background).toEqual({ kind: 'solid', color: '#FFFFFFFF' });
    const retained = computeWebGalTextboxStyle(`
      .TextBox_Background { background-image:linear-gradient(red, blue) !important; background:white; }
    `);
    expect(retained.background.background?.kind).toBe('linear');
  });

  it('cascades supported vendor aliases together and resets background-clip with shorthand', () => {
    const style = computeWebGalTextboxStyle(`
      .outer { -webkit-background-clip:text; background:red; }
      .inner { -webkit-text-stroke:4px red; text-stroke:0px blue !important; }
    `);
    expect(style.outer.backgroundClipText).toBe(false);
    expect(style.inner.stroke.width).toBe(0);
  });

  it('applies declaration priority across specificity and source order', () => {
    const style = computeWebGalTextboxStyle(`
      .TextBox_main .text { color:red; }
      .text { color:blue !important; }
      .TextBox_main { padding-left:80px !important; }
      .TextBox_main { padding:0; }
      .TextBox_main { padding-left:40px !important; }
    `);
    expect(style.text.color).toBe('#0000FFFF');
    expect(style.main.padding.l).toBe(30);
  });

  it('does not apply unrelated ancestors or interactive selectors', () => {
    const style = computeWebGalTextboxStyle(`
      .text { color:red; }
      .other .text { color:blue !important; }
      .text:hover { color:green; }
    `);
    expect(style.text.color).toBe('#FF0000FF');
    expect(style.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('.other .text'), expect.stringContaining('.text:hover'),
    ]));
  });

  it('preserves declarations around nesting, repeated selectors and quoted delimiters', () => {
    const css = `.TextBox_main {
      padding-left:80px;
      .text { font-family:"A;{}B"; }
      padding:0;
    }
    .TextBox_main { padding-left:40px; }
    .TextBox_Background::after { background-image:url("assets/a;b.svg"); width:20px; }`;
    const rules = parseScssRules(css);
    expect(rules.map((rule) => rule.selector)).toEqual([
      '.TextBox_main', '.TextBox_main .text', '.TextBox_main', '.TextBox_main', '.TextBox_Background::after',
    ]);
    const style = computeWebGalTextboxStyle(css);
    expect(style.main.padding).toEqual({ t: 0, r: 0, b: 0, l: 30 });
    expect(style.text.fontFamily).toBe('A;{}B');
    expect(style.backgroundAfter.imageFile).toBe('a;b.svg');
    expect(style.backgroundAfter.decorationSize).toBe(15);
  });

  it('uses the element font for em, root for rem and containing width for all padding percentages', () => {
    const style = computeWebGalTextboxStyle(`
      .TextBox_main { font-size:40px; left:10%; right:10%; height:400px; padding:1em 2rem 5% 12pt; }
      .TextBox_showName { padding:10%; top:10%; min-width:25%; }
    `);
    expect(style.main.padding).toEqual({ t: 30, r: 30, b: 96, l: 12 });
    expect(style.main.lengths.left).toBe(192);
    // Main is 2048 source px wide and 400 source px high.
    expect(style.name.padding).toEqual({ t: 154, r: 154, b: 154, l: 154 });
    expect(style.name.lengths.top).toBe(30);
    expect(style.name.lengths.minwidth).toBe(384);
  });

  it.each([
    ['', 30], ['font-size:100%;', 30], ['font-size:100% !important;', 15],
    ['font-size:2rem !important;', 30], ['font-size:inherit !important;', 15],
  ])('applies name inline defaults independent of authored parent size: %s', (declarations, fontSize) => {
    const style = computeWebGalTextboxStyle(`.TextBox_showName { ${declarations} }`);
    expect(style.name.fontSize).toBe(fontSize);
    expect(style.nameBackground.fontSize).toBe(fontSize);
  });

  it('keeps unrounded parent fonts until dependent units have been evaluated', () => {
    const style = computeWebGalTextboxStyle(`
      .TextBox_main { font-size:30px; padding:2em; }
      .text { font-size:200%; }
    `);
    expect(style.main.fontSize).toBe(23);
    expect(style.main.padding.l).toBe(45);
    expect(style.text.fontSize).toBe(45);
    expect(style.name.fontSize).toBe(45);
  });

  it.each([
    ['2', 120], ['200%', 60], ['2em', 60], ['60px', 45], ['3rem', 45],
  ])('inherits computed line height while preserving unitless ratios: %s', (lineHeight, expected) => {
    const style = computeWebGalTextboxStyle(`
      .TextBox_main { font-size:40px; line-height:${lineHeight}; }
      .text { font-size:200%; }
    `);
    expect(style.text.lineHeight).toBe(expected);
  });

  it('inherits computed lengths rather than resolving parent em against child fonts', () => {
    const style = computeWebGalTextboxStyle(`
      .TextBox_main { font-size:40px; padding:1em; height:10em; text-shadow:0 0 .5em red; -webkit-text-stroke:.1em blue; }
      .text { font-size:200%; }
      .TextBox_showName { padding:inherit; height:inherit; }
    `);
    expect(style.name.padding).toEqual({ t: 30, r: 30, b: 30, l: 30 });
    expect(style.name.lengths.height).toBe(300);
    expect(style.text.textShadow.blur).toBe(15);
    expect(style.inner.stroke.width).toBe(3);
  });

  it('inherits typography without inheriting declaration priority', () => {
    const { style } = translateWebGalTextboxScss(`
      .TextBox_main { color:red !important; font-family:Parent !important; font-weight:700 !important; }
      .text { color:blue; font-family:Child; font-weight:400; }
      .TextBox_showName { font-family:Name; color:green; }
    `);
    expect(style.params.text).toMatchObject({ color: '#0000FF', fontFamily: 'Child', fontWeight: '400' });
    expect(style.params.speaker).toMatchObject({ color: '#008000', fontFamily: 'Name', fontWeight: '700' });
  });

  it.each([
    ['red, green, blue', [0, 0.5, 1]],
    ['red 20%, green, white, blue 80%', [0.2, 0.4, 0.6, 0.8]],
    ['red 80%, green 20%, blue', [0.8, 0.8, 1]],
  ])('fixes omitted and descending gradient stops: %s', (stops, positions) => {
    const paint = computeWebGalTextboxStyle(`.TextBox_Background { background:linear-gradient(${stops}); }`).background.background;
    expect(paint?.kind).toBe('linear');
    if (paint?.kind === 'linear') positions.forEach((position, i) => expect(paint.stops[i].pos).toBeCloseTo(position));
  });

  it('reports unsupported values without masking an earlier supported declaration', () => {
    const result = translateWebGalTextboxScss(`
      .TextBox_main { --color:blue; padding:40px; padding:calc(1em + 2px); color:red; color:var(--color); }
      .TextBox_main { padding:invalid; color:invalid; filter:blur(4px); }
      @media (max-width:600px) { .TextBox_main { color:blue; } }
    `);
    expect(result.style.params.text.color).toBe('#FF0000');
    expect(result.style.params.text.x - result.style.params.textbox.x).toBe(30);
    expect(result.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('calc('), expect.stringContaining('var('),
      expect.stringContaining('invalid'), expect.stringContaining('filter'), expect.stringContaining('at-rule'),
    ]));
  });

  it('diagnoses unsupported gradient stop syntax instead of silently treating it as an omitted stop', () => {
    const style = computeWebGalTextboxStyle(`
      .TextBox_Background { background:red; background:linear-gradient(red 10px, green, blue); }
    `);
    expect(style.background.background).toEqual({ kind: 'solid', color: '#FF0000FF' });
    expect(style.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('10px')]));
  });

  it('maps transform once and can reuse computed styles without mutation', () => {
    const computed = computeWebGalTextboxStyle(`
      .TextBox_main { font-size:40px; padding:1em; transform:scale(2); }
      .TextBox_Background { border:4px solid red; box-shadow:0 4px 8px blue; }
      .inner { text-shadow:0 2px 4px black; }
    `);
    const before = structuredClone(computed);
    const first = mapWebGalTextboxStyle(computed);
    expect(computed).toEqual(before);
    expect(mapWebGalTextboxStyle(computed)).toEqual(first);
    expect(first.style.params.text.fontSize).toBe(60);
    expect(first.style.params.text.x - first.style.params.textbox.x).toBe(60);
    expect(first.style.params.text.dropShadowBlur).toBe(21);
    expect(first.theme.textbox.border.width).toBe(6);
  });

  it('resolves shadow currentColor at the element where the shadow is declared', () => {
    const inherited = computeWebGalTextboxStyle(`
      .TextBox_main { color:red; text-shadow:0 0 10px; }
      .text { font-size:200%; color:blue; }
    `);
    expect(inherited.inner.textShadow).toMatchObject({ color: '#FF0000', blur: 7.5 });
    const own = computeWebGalTextboxStyle(`
      .TextBox_main { color:red; }
      .text { color:blue; text-shadow:0 0 1em currentColor; }
    `);
    expect(own.inner.textShadow).toMatchObject({ color: '#0000FF', blur: 15 });
  });

  it('carries faithful computed values through manifest and SVG generation', () => {
    const result = buildWebGalTextboxTemplatePackage({
      templateId: 'css-fidelity', templateName: 'CSS fidelity',
      scss: `
        .TextBox_main { font-size:40px; padding-left:80px; padding:1em !important; }
        .TextBox_Background { background:red; background-color:blue !important; }
        .TextBox_ShowName_Background { background:linear-gradient(red, green, blue); }
        .TextBox_showName { font-size:100%; }
        .inner { text-shadow:none; }
        .outerName { text-shadow:none; }
      `,
    });
    const { params } = result.style;
    expect(params.text.x - params.textbox.x).toBe(30);
    expect(params.speaker?.fontSize).toBe(60);
    expect(params.text.dropShadow ?? false).toBe(false);
    expect(params.speaker?.dropShadow ?? false).toBe(false);
    const textbox = result.files.find((file) => file.relativePath === `assets/${params.textbox.image}`);
    const namebox = result.files.find((file) => file.relativePath === `assets/${params.namebox?.image}`);
    expect(textbox?.contents).toContain('fill="#0000FF"');
    expect(namebox?.contents).toContain('<stop offset="0.5" stop-color="#008000"');
  });
});
