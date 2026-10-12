import { describe, expect, it } from 'vitest';
import {
  buildNameboxSvg,
  buildTextboxSvg,
  buildWebGalScssAssetTable,
  gradientPoints,
  inlineSvg,
  namespaceSvgIds,
  rewriteWebGalScssImageParams,
  shortHash,
  splitColor,
  textboxSvgPlaceholder,
} from '../services/import/webgal/WebGalTextboxScssAssets';
import type { WebGalPanelTheme } from '../services/import/webgal/WebGalTextboxScssTranslator';

const DECO = '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>'
  + '<circle id="dot" cx="12" cy="12" r="6" fill="url(#g)"/></svg>';

const PANEL: WebGalPanelTheme = {
  fill: { kind: 'solid', color: '#FFFFFFCC' },
  border: { width: 0, color: null },
  radius: 0,
  shadow: null,
  deco: null,
};

const DECORATED: WebGalPanelTheme = {
  ...PANEL,
  deco: { file: 'meteor.svg', size: 20, opacity: 0.5, rotate: 0, right: 0, bottom: 0 },
};

const SHADOWED: WebGalPanelTheme = {
  ...PANEL,
  shadow: { dx: 0, dy: 5, blur: 10, spread: 0, color: '#00000080' },
};

describe('WebGalTextboxScssAssets', () => {
  it('splits a colour into hex plus alpha', () => {
    expect(splitColor('#ff9ec4')).toEqual({ hex: '#FF9EC4', alpha: 1 });
    expect(splitColor('#12345678')).toEqual({ hex: '#123456', alpha: 120 / 255 });
    expect(splitColor('#abc').hex).toBe('#000000');
    expect(splitColor(null)).toEqual({ hex: '#000000', alpha: 1 });
  });

  it('hashes content deterministically', () => {
    expect(shortHash('textbox.svg')).toBe(shortHash('textbox.svg'));
    expect(shortHash('textbox.svg')).toHaveLength(6);
    expect(shortHash('textbox.svg')).not.toBe(shortHash('namebox.svg'));
    // djb2 starts from 5381, so the empty string still hashes.
    expect(shortHash('')).toBe((5381).toString(36));
  });

  it('namespaces inline SVG ids so two ornaments cannot collide', () => {
    const result = namespaceSvgIds(DECO, 'wgd');
    expect(result).toContain('id="wgdg"');
    expect(result).toContain('url(#wgdg)');
    expect(result).toContain('id="wgddot"');
  });

  it('inlines an ornament, honouring its viewBox', () => {
    const inlined = inlineSvg(DECO, 5, 6, 48, 48, 0);
    expect(inlined).toContain('translate(5,6)');
    // 48 / 24 → a factor of two.
    expect(inlined).toContain('scale(2,2)');
    expect(inlined).not.toContain('<svg');
    expect(inlineSvg(null, 0, 0, 1, 1, 0)).toBe('');

    const rotated = inlineSvg(DECO, 0, 0, 24, 24, 30);
    expect(rotated).toContain('rotate(30,12,12)');
  });

  it('maps CSS angles onto gradient endpoints', () => {
    // 0deg points up: vertical axis, running from bottom to top.
    const up = gradientPoints(0, 0, 0, 100, 50);
    expect(up.x1).toBeCloseTo(50, 6);
    expect(up.x2).toBeCloseTo(50, 6);
    expect(up.y1 - up.y2).toBeCloseTo(50, 6);
    // 90deg points right: horizontal axis.
    const right = gradientPoints(90, 0, 0, 100, 50);
    expect(right.y1).toBeCloseTo(25, 6);
    expect(right.y2).toBeCloseTo(25, 6);
    expect(right.x2 - right.x1).toBeCloseTo(100, 6);
  });

  it('keeps a translucent fill translucent', () => {
    // Regression: wrapping the body in `<g filter="…feDropShadow">` used to raise
    // a 0.8 fill to 0.9, because the shadow overlaps the panel almost entirely.
    const svg = buildTextboxSvg(SHADOWED, { width: 200, height: 60 }, null);
    const bodyRect = /<rect[^>]*fill-opacity="0.8"[^>]*\/>/.exec(svg)?.[0] ?? '';
    expect(bodyRect).toContain('fill="#FFFFFF"');
    expect(bodyRect).not.toContain('filter');
    // The blur only ever applies to the shadow layer.
    expect(svg.match(/filter="url\(#wgTbShadowBlur\)"/g)).toHaveLength(1);
    expect(svg).toContain('mask="url(#wgTbShadowMask)"');
  });

  it('reserves the shadow drop on the canvas', () => {
    const svg = buildTextboxSvg(SHADOWED, { width: 200, height: 65 }, null);
    expect(svg).toContain('width="200" height="65"');
    // Panel height = 65 − 5 reserved for the drop, minus the half-pixel inset.
    expect(/<rect[^>]*fill-opacity="0.8"[^>]*\/>/.exec(svg)?.[0]).toContain('height="59"');
  });

  it('clips ornaments to the panel, matching the CSS overflow', () => {
    const svg = buildTextboxSvg(DECORATED, { width: 200, height: 60 }, DECO);
    expect(svg).toContain('<clipPath id="wgTbDecoClip">');
    expect(svg).toContain('clip-path="url(#wgTbDecoClip)"');
    expect(svg).toContain('opacity="0.5"');
    expect(svg).toContain('id="wgddot"');

    // No ornament, no clip path.
    expect(buildTextboxSvg(PANEL, { width: 200, height: 60 }, null)).not.toContain('clipPath');
    // Source available but the theme declares none.
    expect(buildTextboxSvg(PANEL, { width: 200, height: 60 }, DECO)).not.toContain('clipPath');
  });

  it('draws a gradient nameplate through a gradient definition', () => {
    const svg = buildNameboxSvg({
      ...PANEL,
      fill: {
        kind: 'linear',
        angle: 180,
        stops: [{ color: '#FF9EC4FF', pos: 0 }, { color: '#FF3B72FF', pos: 1 }],
      },
      radius: 30,
    }, { width: 300, height: 60 }, null);
    expect(svg).toContain('<linearGradient id="wgNbFill"');
    expect(svg).toContain('fill="url(#wgNbFill)"');
    // Radius is capped at half the height minus the half-pixel inset.
    expect(svg).toContain('rx="29.5"');
    expect(svg).not.toContain('clipPath');
  });

  it('clips a nameplate ornament too', () => {
    const svg = buildNameboxSvg(DECORATED, { width: 300, height: 60 }, DECO);
    expect(svg).toContain('<clipPath id="wgNbDecoClip">');
    expect(svg).toContain('clip-path="url(#wgNbDecoClip)"');
  });

  it('falls back to a transparent placeholder', () => {
    expect(textboxSvgPlaceholder()).toContain('fill-opacity="0"');
  });

  it('derives asset paths from the artwork content', () => {
    const geom = { textbox: { width: 200, height: 60 }, namebox: { width: 300, height: 60 } };
    const first = buildWebGalScssAssetTable({ textbox: PANEL, namebox: PANEL }, geom, null);
    expect(first['wg-textbox'].relPath).toMatch(/^ui\/dialogue\/webgal\/textbox-[0-9a-z]+\.svg$/);
    expect(first['wg-namebox'].relPath).toMatch(/^ui\/dialogue\/webgal\/namebox-[0-9a-z]+\.svg$/);

    // The engine caches textures by path, so identical artwork must keep its path
    // (idempotent re-import) and different artwork must change it.
    const again = buildWebGalScssAssetTable({ textbox: PANEL, namebox: PANEL }, geom, null);
    expect(again['wg-textbox'].relPath).toBe(first['wg-textbox'].relPath);

    const changed = buildWebGalScssAssetTable(
      { textbox: { ...PANEL, fill: { kind: 'solid', color: '#000000FF' } }, namebox: PANEL },
      geom,
      null,
    );
    expect(changed['wg-textbox'].relPath).not.toBe(first['wg-textbox'].relPath);
  });

  it('points the params at the generated artwork', () => {
    const geom = { textbox: { width: 200, height: 60 }, namebox: { width: 300, height: 60 } };
    const table = buildWebGalScssAssetTable({ textbox: PANEL, namebox: PANEL }, geom, null);
    const params = {
      textbox: { image: 'ui/dialogue/webgal/textbox.svg', x: 0, y: 0, width: 200 },
      namebox: { image: 'ui/dialogue/webgal/namebox.svg', x: 0, y: 0, width: 300 },
      text: { x: 0, y: 0, maxWidth: 200 },
    };
    const rewritten = rewriteWebGalScssImageParams(params as never, table)!;
    expect(rewritten.textbox!.image).toBe(table['wg-textbox'].relPath);
    expect(rewritten.namebox!.image).toBe(table['wg-namebox'].relPath);
  });
});
