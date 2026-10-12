import { describe, expect, it } from 'vitest';
import {
  alphaOf,
  parseBlocks,
  parseBoxShadow,
  parseBorder,
  parsePaint,
  parseScale,
  parseTextShadow,
  resolveLength,
  resolveWidthLike,
  rgbOnly,
  ROOT_FONT_PX,
  STAGE_SCALE,
  stripComments,
  tryParseColor,
} from '../services/import/webgal/WebGalScssSyntax';

describe('WebGalScssSyntax', () => {
  it('scales WebGAL stage pixels onto the AeonStagery stage', () => {
    expect(STAGE_SCALE).toBeCloseTo(0.75, 5);
    expect(ROOT_FONT_PX).toBe(20);
    expect(resolveLength('120px')).toBe(90);
    expect(resolveLength('10em')).toBe(150);
    expect(resolveLength('10em', 30)).toBe(225);
    expect(resolveLength('275%')).toBe(41);
    expect(resolveLength('12pt')).toBe(12);
    expect(resolveLength('-4px')).toBe(-3);
    expect(resolveLength('56px !important')).toBe(42);
    expect(resolveLength('auto')).toBeNull();
  });

  it('reads width-like percentages against the containing block', () => {
    expect(resolveWidthLike('25%', 20, 1600)).toBe(400);
    // `em` uses the (already rescaled) font base; only absolute units take STAGE_SCALE.
    expect(resolveWidthLike('10em', 55, 1600)).toBe(550);
    expect(resolveWidthLike('300px', 20, 1600)).toBe(225);
    expect(resolveWidthLike('none', 20, 1600)).toBeNull();
  });

  it('flattens nesting, `&` and at-rules', () => {
    const blocks = parseBlocks('.k{color:red;&::after{color:blue}&.x{color:lime}}');
    expect(Object.keys(blocks).sort()).toEqual(['.k', '.k.x', '.k::after']);
    expect(blocks['.k']).toContain('color:red');
    expect(blocks['.k::after']).toContain('color:blue');
    expect(parseBlocks('@media screen { .h{color:blue} }\n.i{color:red}')['.h']).toBeUndefined();
  });

  it('strips block and line comments so braces cannot unbalance nesting', () => {
    expect(stripComments('a{/* { } */color:red}')).toBe('a{color:red}');
    // The newline is preserved; only the comment body goes away.
    expect(stripComments('a{\n  // { }\n  color:red}')).toBe('a{\n\n  color:red}');
    // A URL must survive the line-comment pass.
    expect(stripComments('.a{background:url(https://x/y.png)}')).toContain('https://x/y.png');
  });

  it('strips a trailing line comment without swallowing the next declarations', () => {
    // A comment that ends a line used to travel with the following line's
    // declarations into the parser, so `left` was never recognised and the box
    // fell back to its default position.
    const css = '.a {\n  font-size:40px; // base font\n  left:120px; right:120px; height:300px;\n}';
    expect(stripComments(css)).not.toContain('//');
    expect(stripComments(css)).toContain('left:120px');
    expect(stripComments(css)).toContain('height:300px');
    expect(parseBlocks(css)['.a']).toContain('left:120px');
  });

  it('keeps // inside strings and url() out of the comment pass', () => {
    expect(stripComments('.a{content:"x // y"}')).toContain('"x // y"');
    expect(stripComments('.a{background:url(//cdn/x.png)}')).toContain('url(//cdn/x.png)');
    expect(stripComments(".a{background:url('a//b.png')}")).toContain("url('a//b.png')");
    // Only the bare `url(` token is protected, so a function that merely ends in
    // `url` still gets its trailing comment removed.
    expect(stripComments('.a{filter:myurl(//x)}')).not.toContain('//');
  });

  it('resolves layout percentages against the containing block, not the font size', () => {
    // `left: 10%` is a tenth of the 1920px stage, not a tenth of a font size.
    expect(resolveLength('10%', 20, false, 1920)).toBe(192);
    expect(resolveLength('10%', 20, false, 1080)).toBe(108);
    // Without a basis the old font-size-relative reading still applies.
    expect(resolveLength('100%', 20)).toBe(15);
    // A non-positive basis means "not supplied", not a zero-width block: the
    // font-size reading applies again (10% of 20px, scaled onto the stage).
    expect(resolveLength('10%', 20, false, 0)).toBe(2);
    expect(resolveLength('10%', 20, false, -5)).toBe(2);
  });

  it('resolves named colours and alpha', () => {
    // `tryParseColor` yields 8-digit #RRGGBBAA.
    expect(tryParseColor('white')).toBe('#FFFFFFFF');
    expect(tryParseColor('rgba(255,0,0,.5)')).toBe('#ff000080');
    expect(tryParseColor('transparent')).toBe('#00000000');
    expect(tryParseColor('none')).toBeNull();
    expect(tryParseColor('notacolor')).toBeNull();
    expect(rgbOnly('#aabbccdd')).toBe('#AABBCC');
    expect(alphaOf('#aabbcc80')).toBeCloseTo(128 / 255, 5);
  });

  it('parses the first gradient body without merging chained gradients', () => {
    const paint = parsePaint('linear-gradient(45deg, rgba(255,255,255,0.8) 0%, rgba(255,192,203,0.9) 100%)');
    expect(paint).toMatchObject({ kind: 'linear', angle: 45 });
    expect(paint && paint.kind === 'linear' ? paint.stops.map((s) => s.pos) : []).toEqual([0, 1]);
    const first = parsePaint('linear-gradient(#fff), linear-gradient(#000)');
    expect(first && first.kind === 'linear' ? first.stops.length : 0).toBe(1);
    expect(parsePaint('none')).toBeNull();
  });

  it('merges text shadows by alpha and detects symmetric outlines', () => {
    const outline = parseTextShadow(
      '-1.5px -1.5px 10px rgba(0,0,0,.85),1.5px -1.5px 10px rgba(0,0,0,.85),'
      + '-1.5px 1.5px 10px rgba(0,0,0,.85),1.5px 1.5px 10px rgba(0,0,0,.85),0 2px 50px rgba(0,0,0,.3)',
    );
    // The 85% outline layer must win over the 30% haze, otherwise the body text
    // renders inside a grey cloud.
    expect(outline.alpha).toBeCloseTo(217 / 255, 3);
    expect(outline.blur).toBeCloseTo(7.5, 3);
    expect(outline.symmetric).toBe(true);

    // `0 0 12px rgba(...)` is a common shorthand: the unit-less zeros must not
    // shift the numeric slots.
    const glow = parseTextShadow('0 0 12px rgba(0,0,0,.9)');
    expect(glow).toMatchObject({ has: true, blur: 9, offsetX: 0, distance: 0, symmetric: true });
    expect(glow.color).toBe('#000000');

    // A genuine one-direction drop shadow keeps its offset.
    const directional = parseTextShadow('2px 3px 4px rgba(0,0,0,.8)');
    expect(directional.symmetric).toBe(false);
    expect(directional.blur).toBeCloseTo(3, 3);
    expect(directional.distance).toBeCloseTo(2.25, 3);

    // Named colours must be recognised instead of the `px` of `-1.5px`.
    expect(parseTextShadow('0 2px 6px black').alpha).toBe(1);
  });

  it('ignores digits inside a box-shadow colour', () => {
    const shadow = parseBoxShadow('0 6px 20px rgba(190,190,190,.8)');
    // `190` must not become the spread, which used to blow the shadow out.
    expect(shadow).toMatchObject({ dx: 0, blur: 15, spread: 0, dy: 5 });
    // 6px and 20px are WebGAL stage pixels → ×0.75 → 4.5 and 15, rounded away from zero.
    expect(shadow?.dy).toBe(5);
    // Alpha 0.8 → 204 → `cc` (the channel helpers emit lower-case hex).
    expect(shadow?.color.toLowerCase()).toBe('#bebebecc');
    expect(parseBoxShadow('none')).toBeNull();
  });

  it('reads border width and colour in any order', () => {
    expect(parseBorder('2px solid #ff3b72')).toEqual({ width: 2, color: '#FF3B72FF' });
    expect(parseBorder('3px solid white', 20)).toEqual({ width: 2, color: '#FFFFFFFF' });
    expect(parseBorder(null).width).toBe(0);
  });

  it('reads uniform and axis-specific transforms', () => {
    expect(parseScale('scale(.9)')).toEqual({ sx: 0.9, sy: 0.9 });
    expect(parseScale('scale(1.2, 0.8)')).toEqual({ sx: 1.2, sy: 0.8 });
    expect(parseScale('scaleX(.5)')).toEqual({ sx: 0.5, sy: 1 });
    expect(parseScale('translateX(10px)')).toBeNull();
    expect(parseScale('scale(1)')).toBeNull();
    expect(parseScale('scale(0)')).toBeNull();
  });
});
