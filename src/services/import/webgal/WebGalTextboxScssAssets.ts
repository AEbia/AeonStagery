/**
 * Draw the dialogue panel artwork for an imported WebGAL template.
 *
 * `image-dialogue-v1` copies the files named by `params.textbox.image` /
 * `params.namebox.image` out of the template package's `assets/` folder when a
 * style is applied. Generating the artwork from the parsed theme — rather than
 * shipping one fixed image — is what makes an imported template look like itself:
 * a pink gradient nameplate stays pink instead of collapsing into a black pill,
 * and a translucent panel keeps its translucency.
 *
 * Drawing size equals the engine's draw size (`assetGeom`), combined with
 * nine-slice stretching, so radii and borders survive a change in height or
 * width.
 */
import type { WebGalDialogueParams, WebGalPanelTheme } from './WebGalTextboxScssTranslator';
import type { BoxSides, Paint } from './WebGalScssSyntax';

export interface WebGalPanelDrawSize {
  width: number;
  height: number;
  /** Body rectangle inside an expanded artwork canvas. */
  content?: { x: number; y: number; width: number; height: number };
}

/** Draw sizes for both panels. Only the extent is needed — slices are not. */
export interface WebGalScssPanelDrawSizes {
  textbox?: WebGalPanelDrawSize;
  namebox?: WebGalPanelDrawSize;
}

export interface WebGalScssDecorationSources {
  textbox?: string | null;
  namebox?: string | null;
}

export interface WebGalScssAsset {
  /** Package-relative path, carrying a content hash (see {@link buildWebGalScssAssetTable}). */
  relPath: string;
  svg: string;
}

export type WebGalScssAssetTable = Record<'wg-textbox' | 'wg-namebox', WebGalScssAsset>;

/** `#RRGGBBAA` → 6-digit hex plus a `0..1` alpha. */
export function splitColor(c: unknown): { hex: string; alpha: number } {
  let h = String(c || '#000000FF').replace(/^#/, '');
  if (h.length === 6) h += 'FF';
  if (h.length !== 8) h = '000000FF';
  return {
    hex: '#' + h.slice(0, 6).toUpperCase(),
    alpha: parseInt(h.slice(6, 8), 16) / 255,
  };
}

/** Trim float noise before writing numbers into markup. */
function round3(v: unknown): number {
  return Math.round(Number(v) * 1000) / 1000;
}

/**
 * Prefix every `id` in an inline SVG so two ornaments cannot collide.
 *
 * `id="x"` and `url(#x)` share one global namespace, so two decorations that both
 * define `a` would silently overwrite each other's gradients.
 */
export function namespaceSvgIds(svgText: string, prefix: string): string {
  const ids = new Map<string, string>();
  let out = svgText.replace(
    /(\s)id\s*=\s*["']([^"']+)["']/g,
    (match, _space: string, id: string) => {
      ids.set(id, prefix + id);
      return match;
    },
  );
  for (const [id, renamed] of ids) {
    out = out
      .split(`id="${id}"`).join(`id="${renamed}"`)
      .split(`id='${id}'`).join(`id='${renamed}'`)
      .split(`url(#${id})`).join(`url(#${renamed})`)
      .split(`xlink:href="#${id}"`).join(`xlink:href="#${renamed}"`)
      .split(`href="#${id}"`).join(`href="#${renamed}"`);
  }
  return out;
}

/**
 * Place an external SVG inside a rectangle of the current SVG.
 *
 * PIXI loads an SVG as an image, so referenced files are never fetched — the
 * ornament has to be inlined.
 */
/**
 * Drop the constructs an ornament never needs and a renderer must never honour.
 *
 * The file comes from a template the user picked locally and Pixi rasterises SVG
 * instead of executing it, so this is defence in depth rather than the fix for
 * a live vulnerability. It is deliberately narrow: real ornaments are made of
 * `defs` / `g` / `path` and use `clip-path="url(#id)"`, so nothing here can bite
 * them — `href="#id"` is kept for `<use>`, only references that leave the
 * document are removed.
 */
function stripActiveSvg(markup: string): string {
  return String(markup)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*"(?!#)[^"]*"/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*'(?!#)[^']*'/gi, '');
}

export function inlineSvg(
  svgText: string | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  rotate: number,
): string {
  if (!svgText) return '';
  const source = namespaceSvgIds(stripActiveSvg(svgText), 'wgd');
  const viewBox = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)/i.exec(source);
  let vx = 0;
  let vy = 0;
  let vw = w;
  let vh = h;
  if (viewBox) {
    vx = parseFloat(viewBox[1]);
    vy = parseFloat(viewBox[2]);
    vw = parseFloat(viewBox[3]);
    vh = parseFloat(viewBox[4]);
  }
  if (!(vw > 0) || !(vh > 0)) {
    vw = w;
    vh = h;
  }
  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg\s*>\s*$/i, '');
  let transform = `translate(${round3(x)},${round3(y)})`;
  if (rotate) {
    transform += ` rotate(${round3(rotate)},${round3(w / 2)},${round3(h / 2)})`;
  }
  transform += ` scale(${round3(w / vw)},${round3(h / vh)}) translate(${round3(-vx)},${round3(-vy)})`;
  return `<g transform="${transform}">${inner}</g>`;
}

/** Solid paint → `fill` / `fill-opacity` attributes. */
function solidAttrs(paint: Paint | null | undefined, fallbackHex: string, fallbackAlpha: number): string {
  if (!paint || paint.kind !== 'solid') {
    return `fill="${fallbackHex}" fill-opacity="${fallbackAlpha}"`;
  }
  const c = splitColor(paint.color);
  return `fill="${c.hex}" fill-opacity="${round3(c.alpha)}"`;
}

/**
 * CSS angle → linear gradient endpoints in `userSpaceOnUse`.
 *
 * CSS measures from "up" and turns clockwise (135deg points bottom-right), while
 * the maths below starts at the positive x axis.
 */
export function gradientPoints(
  angle: number, x: number, y: number, w: number, h: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const rad = ((angle - 90) * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    x1: cx - (dx * len) / 2,
    y1: cy - (dy * len) / 2,
    x2: cx + (dx * len) / 2,
    y2: cy + (dy * len) / 2,
  };
}

/** Gradient definition for `<defs>`, or `null` for a solid paint. */
function gradientDef(id: string, paint: Paint | null | undefined, box: { x: number; y: number; w: number; h: number }): string | null {
  if (!paint || paint.kind !== 'linear' || !paint.stops.length) return null;
  const p = gradientPoints(paint.angle, box.x, box.y, box.w, box.h);
  const stops = paint.stops.slice();
  // CSS semantics: before the first stop the first colour extends, and after the
  // last stop the last colour does.
  if (stops[0].pos > 0) stops.unshift({ color: stops[0].color, pos: 0 });
  if (stops[stops.length - 1].pos < 1) {
    stops.push({ color: stops[stops.length - 1].color, pos: 1 });
  }
  const body = stops.map((stop) => {
    const c = splitColor(stop.color);
    return `<stop offset="${round3(stop.pos)}" stop-color="${c.hex}"`
      + ` stop-opacity="${round3(c.alpha)}"/>`;
  }).join('');
  return `<linearGradient id="${id}" x1="${round3(p.x1)}" y1="${round3(p.y1)}"`
    + ` x2="${round3(p.x2)}" y2="${round3(p.y2)}" gradientUnits="userSpaceOnUse">${body}</linearGradient>`;
}

/** Fill attributes, referencing the gradient when the paint is one. */
function fillRef(paint: Paint | null | undefined, defId: string, fallbackHex: string, fallbackAlpha: number): string {
  if (paint && paint.kind === 'linear') return `fill="url(#${defId})"`;
  return solidAttrs(paint, fallbackHex, fallbackAlpha);
}

function strokeAttrs(border: WebGalPanelTheme['border'] | undefined, width: number): string {
  if (!(width > 0) || !border || !border.color) return '';
  const c = splitColor(border.color);
  return ` stroke="${c.hex}" stroke-width="${round3(width)}" stroke-opacity="${round3(c.alpha)}"`;
}

/**
 * Draw the dialogue box.
 *
 * Two details are load-bearing:
 *
 * - **The shadow is a separate layer, masked to the outside of the panel.** A
 *   `<g filter="…feDropShadow">` around the body would union the source with its
 *   shadow, and since the shadow is only offset by a few pixels it overlaps the
 *   panel almost entirely — raising the alpha of a translucent fill. Measured on
 *   a real Chromium, a `fill-opacity="0.8"` panel renders at **0.90** that way.
 * - **The ornament is clipped to the panel.** Templates place `::after`
 *   decorations at negative offsets on purpose (`bottom: -5px; right: 8px`) and
 *   rely on the parent's `overflow: hidden`, so only the tip of a meteor shows
 *   inside the rounded corner. Without the clip the whole sprite spills outside
 *   the border.
 */
export function buildTextboxSvg(
  theme: WebGalPanelTheme | null | undefined,
  geom: WebGalPanelDrawSize,
  decoSrc?: string | null,
): string {
  const tb = theme || ({} as WebGalPanelTheme);
  const W = Math.max(2, round3(geom.width));
  const H = Math.max(2, round3(geom.height)); // includes the reserved shadow drop
  const border = tb.border || { width: 0, color: null };
  const bw = Math.max(0, Number(border.width) || 0);

  const sh = tb.shadow;
  const hasShadow = !!(sh && (sh.dx || sh.dy || sh.blur || sh.spread));
  const shDx = hasShadow ? (Number(sh!.dx) || 0) : 0;
  const shDy = hasShadow ? Math.max(0, Number(sh!.dy) || 0) : 0;
  // Canvas height = panel height + how far the shadow reaches down, which is how
  // the translator sizes `assetGeom.textbox.height`.
  const boxH = Math.max(2, H - shDy);

  // Without a border keep a half-pixel of slack so the edge is not clipped.
  const inset = bw > 0 ? bw / 2 : 0.5;
  const rx = Math.max(0, Math.min(Number(tb.radius) || 0, Math.floor(Math.min(W, boxH) / 2) - inset));
  const rect = { x: inset, y: inset, w: W - inset * 2, h: boxH - inset * 2 };
  if (rect.w <= 0) rect.w = W;
  if (rect.h <= 0) rect.h = boxH;

  const defs: string[] = [];
  const gradient = gradientDef('wgTbFill', tb.fill, rect);
  if (gradient) defs.push(gradient);

  const body: string[] = [];

  if (hasShadow) {
    const sc = splitColor(sh!.color || '#00000080');
    let blurFilter = '';
    if (Number(sh!.blur) > 0) {
      defs.push('<filter id="wgTbShadowBlur" x="-40%" y="-40%" width="180%" height="180%">'
        + `<feGaussianBlur stdDeviation="${round3(Math.max(0.01, Number(sh!.blur) / 2))}"/></filter>`);
      blurFilter = ' filter="url(#wgTbShadowBlur)"';
    }
    defs.push(`<mask id="wgTbShadowMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">`
      + `<rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>`
      + `<rect x="${round3(rect.x)}" y="${round3(rect.y)}" width="${round3(rect.w)}"`
      + ` height="${round3(rect.h)}" rx="${round3(rx)}" fill="#000000"/></mask>`);
    body.push(`<g mask="url(#wgTbShadowMask)"${blurFilter}>`
      + `<rect x="${round3(rect.x + shDx)}" y="${round3(rect.y + shDy)}" width="${round3(rect.w)}"`
      + ` height="${round3(rect.h)}" rx="${round3(rx)}" fill="${sc.hex}"`
      + ` fill-opacity="${round3(sc.alpha)}"/></g>`);
  }

  // The body keeps its own alpha, untouched by any filter.
  body.push(`<rect x="${round3(rect.x)}" y="${round3(rect.y)}" width="${round3(rect.w)}"`
    + ` height="${round3(rect.h)}" rx="${round3(rx)}" `
    + fillRef(tb.fill, 'wgTbFill', '#000000', 0) + strokeAttrs(border, bw) + '/>');

  if (decoSrc && tb.deco) {
    const d = tb.deco;
    const size = Math.max(1, Number(d.size) || 0);
    const dx = W - size - (Number(d.right) || 0);
    // Anchored to the panel's bottom-right, not the shadow-padded canvas.
    const dy = boxH - size - (Number(d.bottom) || 0);
    const opacity = d.opacity == null ? 1 : Number(d.opacity);
    defs.push(`<clipPath id="wgTbDecoClip"><rect x="${round3(rect.x)}" y="${round3(rect.y)}"`
      + ` width="${round3(rect.w)}" height="${round3(rect.h)}" rx="${round3(rx)}"/></clipPath>`);
    body.push(`<g clip-path="url(#wgTbDecoClip)" opacity="${round3(opacity)}">`
      + inlineSvg(decoSrc, dx, dy, size, size, Number(d.rotate) || 0) + '</g>');
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"`
    + ` viewBox="0 0 ${W} ${H}" fill="none">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
    + `<g>${body.join('')}</g></svg>`;
}

/**
 * Draw the nameplate.
 *
 * A pill (`border-radius: 9999px`) has already been resolved to half the height
 * by the translator, so the radius needs no special casing here.
 */
export function buildNameboxSvg(
  theme: WebGalPanelTheme | null | undefined,
  geom: WebGalPanelDrawSize,
  decoSrc?: string | null,
): string {
  const nb = theme || ({} as WebGalPanelTheme);
  const W = Math.max(2, round3(geom.width));
  const H = Math.max(2, round3(geom.height));
  const content = geom.content || { x: 0, y: 0, width: W, height: H };
  const sh = nb.shadow;
  const boxW = Math.max(2, content.width);
  const boxH = Math.max(2, content.height);
  const border = nb.border || { width: 0, color: null };
  const bw = Math.max(0, Number(border.width) || 0);
  const inset = bw > 0 ? bw / 2 : 0.5;
  const rx = Math.max(0, Math.min(Number(nb.radius) || 0, Math.floor(boxH / 2) - inset));
  const rect = {
    x: content.x + inset, y: content.y + inset,
    w: boxW - inset * 2, h: boxH - inset * 2,
  };
  if (rect.w <= 0) rect.w = boxW;
  if (rect.h <= 0) rect.h = boxH;

  const defs: string[] = [];
  const gradient = gradientDef('wgNbFill', nb.fill, rect);
  if (gradient) defs.push(gradient);

  const body: string[] = [];
  if (sh && (sh.dx || sh.dy || sh.blur || sh.spread)) {
    const color = splitColor(sh.color);
    const spread = sh.spread;
    const shadowW = Math.max(0, rect.w + spread * 2);
    const shadowH = Math.max(0, rect.h + spread * 2);
    const shadowRx = Math.max(0, Math.min(rx + spread, shadowW / 2, shadowH / 2));
    if (sh.blur > 0) {
      defs.push(`<filter id="wgNbShadowBlur" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">`
        + `<feGaussianBlur stdDeviation="${round3(sh.blur / 2)}"/></filter>`);
    }
    defs.push(`<mask id="wgNbShadowMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">`
      + `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`
      + `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${rx}" fill="#000000"/></mask>`);
    body.push(`<g mask="url(#wgNbShadowMask)"${sh.blur > 0 ? ' filter="url(#wgNbShadowBlur)"' : ''}>`
      + `<rect x="${round3(rect.x + sh.dx - spread)}" y="${round3(rect.y + sh.dy - spread)}" width="${round3(shadowW)}"`
      + ` height="${round3(shadowH)}" rx="${round3(shadowRx)}" fill="${color.hex}" fill-opacity="${round3(color.alpha)}"/></g>`);
  }
  body.push(`<rect x="${round3(rect.x)}" y="${round3(rect.y)}" width="${round3(rect.w)}"`
    + ` height="${round3(rect.h)}" rx="${round3(rx)}" `
    + fillRef(nb.fill, 'wgNbFill', '#FFFFFF', 1) + strokeAttrs(border, bw) + '/>');

  if (decoSrc && nb.deco) {
    const d = nb.deco;
    const size = Math.max(1, Number(d.size) || 0);
    const dx = content.x + boxW - size - (Number(d.right) || 0);
    const dy = content.y + boxH - size - (Number(d.bottom) || 0);
    defs.push(`<clipPath id="wgNbDecoClip"><rect x="${round3(rect.x)}" y="${round3(rect.y)}"`
      + ` width="${round3(rect.w)}" height="${round3(rect.h)}" rx="${round3(rx)}"/></clipPath>`);
    body.push(`<g clip-path="url(#wgNbDecoClip)" opacity="${round3(d.opacity == null ? 1 : d.opacity)}">`
      + inlineSvg(decoSrc, dx, dy, size, size, Number(d.rotate) || 0) + '</g>');
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"`
    + ` viewBox="0 0 ${W} ${H}" fill="none">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
    + `<g>${body.join('')}</g></svg>`;
}

/** Fully transparent fallback when no theme could be parsed. */
export function textboxSvgPlaceholder(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" '
    + 'viewBox="0 0 16 16"><rect width="16" height="16" fill="#000" fill-opacity="0"/></svg>';
}

/** 32-bit djb2 → 6-character base36 hash, used for asset file names. */
export function shortHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

/**
 * Build the artwork table for a translated style.
 *
 * The file names carry a content hash (`textbox-<hash>.svg`). That is not
 * cosmetic: the engine caches textures **by path**, so re-importing a style used
 * to write the same file name and keep rendering the stale texture until the app
 * was restarted — parameters and files could all be updated to a pink nameplate
 * while the screen still showed the old black pill. Hashing the content means the
 * path changes exactly when the artwork does, and stays stable otherwise.
 */
export function buildWebGalScssAssetTable(
  theme: { textbox?: WebGalPanelTheme; namebox?: WebGalPanelTheme } | null | undefined,
  geom: WebGalScssPanelDrawSizes | null | undefined,
  decoSrc?: WebGalScssDecorationSources | null,
): WebGalScssAssetTable {
  const safeTheme = theme || {};
  const safeGeom = geom || {};
  const safeDeco = decoSrc || {};
  const textboxSize = safeGeom.textbox || { width: 1680, height: 240 };
  const nameboxSize = safeGeom.namebox || { width: 430, height: 90 };
  const drawn: Record<'wg-textbox' | 'wg-namebox', { file: string; svg: string }> = {
    'wg-textbox': {
      file: 'textbox',
      svg: buildTextboxSvg(safeTheme.textbox, textboxSize, safeDeco.textbox),
    },
    'wg-namebox': {
      file: 'namebox',
      svg: buildNameboxSvg(safeTheme.namebox, nameboxSize, safeDeco.namebox),
    },
  };
  const out = {} as WebGalScssAssetTable;
  for (const id of ['wg-textbox', 'wg-namebox'] as const) {
    const { file, svg } = drawn[id];
    out[id] = { relPath: `ui/dialogue/webgal/${file}-${shortHash(svg)}.svg`, svg };
  }
  return out;
}

/**
 * Point the params at this package's artwork.
 *
 * `table` is required: the path depends on a content hash, so it cannot be
 * hard-coded here.
 */
export function rewriteWebGalScssImageParams(
  params: WebGalDialogueParams | null | undefined,
  table: WebGalScssAssetTable | null | undefined,
): WebGalDialogueParams | null | undefined {
  if (!params || !table) return params;
  if (params.textbox && table['wg-textbox']) {
    params.textbox.image = table['wg-textbox'].relPath;
  }
  if (params.namebox && table['wg-namebox']) {
    params.namebox.image = table['wg-namebox'].relPath;
  }
  return params;
}

/** Re-exported for callers that need the padding shape alongside the drawings. */
export type { BoxSides };
