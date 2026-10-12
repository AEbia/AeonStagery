/**
 * Shared SCSS primitives for reading a WebGAL textbox theme.
 *
 * A WebGAL dialogue template ships a `Stage/TextBox/textbox.scss` that describes
 * its subtitle layout in plain CSS (plus nesting, `&`, and `//` comments). These
 * helpers turn that stylesheet into flat declaration maps and resolved numeric
 * values so the translator can map it onto `DialogueImagePresentation` params.
 *
 * ── Unit bases (measured, do not change casually) ───────────────────────────
 * A template's `%` and `em` resolve against the **parent font size**. WebGAL's
 * root font size is `20px`: a 1920px-wide capture of MyGO v3.2.1 pure measures
 * 43.9px letter spacing ÷ 0.9 (the template's `transform`) = 48.8, i.e.
 * `240% × 20px`; its nameplate `min-width: 10em` measures 550px ÷ 0.9 = 550,
 * i.e. `275% × 20px`. Using 16px would scale every length down by ~17%.
 *
 * ── Stage size ─────────────────────────────────────────────────────────────
 * WebGAL's stage is **2560×1440** (`stageWidth`/`stageHeight` in its engine, see
 * `Stage_Width`/`Stage_Height` config overrides), while AeonStagery's stage is
 * 1920×1080. Template lengths such as `left: 120px` / `min-height: 330px` are
 * absolute pixels against *that* stage, so they must be rescaled or the panel
 * covers a different fraction of the screen. Measured against a fullscreen
 * 2560×1440 capture: `(2560 - 240) × 0.9 = 2088` (81.6% wide) and
 * `330 × 0.9 = 297` (20.6% tall), while the unrescaled values render as 78.8%
 * and 27.5%. `STAGE_SCALE` applies the 0.75 factor.
 *
 * Ported from the standalone bridge tooling that shipped this conversion as a
 * browser-side patch; behaviour is preserved, including the rounding mode.
 */

/** AeonStagery stage width. */
export const STAGE_WIDTH = 1920;
/** AeonStagery stage height. */
export const STAGE_HEIGHT = 1080;

/** WebGAL engine stage width (`stageWidth`). */
export const WEBGAL_STAGE_WIDTH = 2560;
/** WebGAL engine stage height (`stageHeight`). */
export const WEBGAL_STAGE_HEIGHT = 1440;

/** Root font size a WebGAL template resolves `%` / `em` against. */
export const ROOT_FONT_PX = 20;

/** WebGAL stage pixels → AeonStagery stage pixels. */
export const STAGE_SCALE = STAGE_WIDTH / WEBGAL_STAGE_WIDTH;

/** Fallback blur, as a share of the font size, for a directional text shadow. */
export const SHADOW_BLUR_RATIO = 0.357;
/** Fallback offset, as a share of the font size, for a directional text shadow. */
export const SHADOW_DIST_RATIO = 0.095;

const NAMED_COLORS: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000', silver: '#C0C0C0', gray: '#808080', grey: '#808080',
  white: '#FFFFFF', maroon: '#800000', red: '#FF0000', purple: '#800080',
  fuchsia: '#FF00FF', magenta: '#FF00FF', green: '#008000', lime: '#00FF00',
  olive: '#808000', yellow: '#FFFF00', navy: '#000080', blue: '#0000FF',
  teal: '#008080', aqua: '#00FFFF', cyan: '#00FFFF', orange: '#FFA500',
  pink: '#FFC0CB', brown: '#A52A2A', gold: '#FFD700', violet: '#EE82EE',
  indigo: '#4B0082', beige: '#F5F5DC', ivory: '#FFFFF0', khaki: '#F0E68C',
  salmon: '#FA8072', tomato: '#FF6347', crimson: '#DC143C', coral: '#FF7F50',
  turquoise: '#40E0D0', lavender: '#E6E6FA', plum: '#DDA0DD', orchid: '#DA70D6',
};

/** A flattened stylesheet: selector → declaration body. */
export type ScssBlocks = Record<string, string>;

/** A single declaration block, normalised to `propertysansdashes` keys. */
export type ScssDeclarations = Record<string, string>;

/** Expanded `padding` / `margin` shorthand. */
export interface BoxSides {
  t: number;
  r: number;
  b: number;
  l: number;
}

export interface SolidPaint {
  kind: 'solid';
  /** 8-digit `#RRGGBBAA`. */
  color: string;
}

export interface GradientStop {
  /** 8-digit `#RRGGBBAA`. */
  color: string;
  /** Normalised position, `0..1`. */
  pos: number;
}

export interface LinearPaint {
  kind: 'linear';
  /** CSS angle in degrees (0 = up, clockwise). */
  angle: number;
  stops: GradientStop[];
}

export type Paint = SolidPaint | LinearPaint;

export interface TextShadowInfo {
  /** False when the declaration was absent or unparsable. */
  has: boolean;
  /** 6-digit `#RRGGBB`. */
  color: string;
  alpha: number;
  blur: number;
  distance: number;
  offsetX: number;
  /**
   * True when the dominant layer has no direction — either it is offset-free or
   * it belongs to a `±x`/`±y` pair of identical layers. Engines with a single
   * directional drop shadow must render these with `distance: 0`, otherwise a
   * symmetric glow turns into a smudge in the bottom-right corner.
   */
  symmetric: boolean;
}

export interface BorderInfo {
  width: number;
  /** 8-digit `#RRGGBBAA`, or `null` when the declaration carried no colour. */
  color: string | null;
}

export interface BoxShadowInfo {
  dx: number;
  dy: number;
  blur: number;
  spread: number;
  /** 8-digit `#RRGGBBAA`. */
  color: string;
}

export interface ScaleInfo {
  sx: number;
  sy: number;
}

/**
 * Remove CSS block comments and SCSS `//` line comments.
 *
 * The line-comment pass is not cosmetic: a commented-out block still contains
 * braces, and leaving them in place breaks the nesting balance in
 * {@link parseBlocks}, attaching later declarations to a garbage selector.
 *
 * A trailing `//` is legal too — `.a { left: 1px; // why` is common — and
 * skipping only whole-line comments would let that comment swallow every
 * declaration that follows it on the same line, silently dropping geometry.
 * So this scans instead of matching: string literals are copied verbatim, and
 * `url(…)` is copied as a unit, which is what keeps `url(https://…)` intact.
 */
export function stripComments(css: string): string {
  const source = String(css ?? '');
  const out: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    // A quoted string may legitimately contain `//`; copy it whole.
    if (char === '"' || char === "'") {
      out.push(char);
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        out.push(inner);
        index += 1;
        if (inner === '\\') {
          if (index < source.length) {
            out.push(source[index]);
            index += 1;
          }
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }
    // `url(` may hold an unquoted `//`, and must not be mistaken for a
    // comment — but only where it is the whole token, so `myurl(` is skipped.
    const previous = index > 0 ? source[index - 1] : '';
    if (!/[\w-]/.test(previous) && /^url\(/i.test(source.slice(index, index + 4))) {
      const close = source.indexOf(')', index);
      if (close >= 0) {
        out.push(source.slice(index, close + 1));
        index = close + 1;
        continue;
      }
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      // Drop the indentation that led into the comment as well, so a trailing
      // comment leaves the declarations before it exactly as they were.
      while (out.length > 0 && (out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) {
        out.pop();
      }
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join('');
}

/**
 * Flatten an SCSS stylesheet into selector → declaration text.
 *
 * Character-scans with a stack instead of using regular expressions, because
 * declaration text would otherwise be mistaken for selectors. Handles `&`
 * concatenation and skips whole `@media` / `@keyframes` blocks.
 */
/** `!important` wins over a later plain declaration, as it does in the cascade. */
function isImportant(declaration: string): boolean {
  return /!\s*important\s*$/i.test(declaration);
}

/**
 * Merge two declaration bodies the way the cascade does: a later rule only
 * overrides the properties it actually declares, and an earlier `!important`
 * value survives a later plain one.
 */
function mergeBodies(existing: string, incoming: string): string {
  const byProperty = new Map<string, string>();
  for (const body of [existing, incoming]) {
    for (const part of body.split(';')) {
      const declaration = part.trim();
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      if (!property) continue;
      const previous = byProperty.get(property);
      if (previous && isImportant(previous) && !isImportant(declaration)) continue;
      byProperty.set(property, declaration);
    }
  }
  return [...byProperty.values()].join(';\n');
}

export function parseBlocks(css: string): ScssBlocks {
  const source = stripComments(css);
  const blocks: ScssBlocks = {};
  const stack: Array<[string[], string[]]> = [];
  let buf = '';
  let i = 0;
  const n = source.length;

  const curDecls = (): string[] | null => (stack.length ? stack[stack.length - 1][1] : null);

  const pushDecls = (text: string): void => {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.indexOf(':') < 0) return;
    const target = curDecls();
    if (!target) return;
    for (const part of trimmed.split(';')) {
      const decl = part.trim();
      if (decl && decl.indexOf(':') >= 0) target.push(decl);
    }
  };

  const closeBlock = (): void => {
    const top = stack.pop();
    if (!top) return;
    const body = top[1].join(';\n');
    if (!body.trim()) return;
    for (const selector of top[0]) {
      for (const full of selector.split(',')) {
        const name = full.trim();
        if (!name) continue;
        const existing = blocks[name];
        // The cascade merges: a later rule only overrides the properties it
        // declares. Replacing the body wholesale loses everything an earlier
        // block set — a template that repeats `.TextBox_main` to add a colour
        // would drop the whole geometry.
        blocks[name] = existing ? mergeBodies(existing, body) : body;
      }
    }
  };

  const skipAtBlock = (from: number): number => {
    let depth = 0;
    let pos = from;
    while (pos < n) {
      if (source[pos] === '{') depth++;
      else if (source[pos] === '}') {
        depth--;
        if (depth === 0) return pos + 1;
      }
      pos++;
    }
    return n;
  };

  while (i < n) {
    const ch = source[i];
    if (ch === '{') {
      const selText = buf.trim();
      buf = '';
      if (selText.charAt(0) === '@') {
        i = skipAtBlock(i);
        continue;
      }
      const parentSels = stack.length ? stack[stack.length - 1][0] : [''];
      const newSels: string[] = [];
      for (const part of selText.split(',')) {
        const trimmedPart = part.trim();
        if (!trimmedPart) continue;
        for (const psel of parentSels) {
          if (trimmedPart.charAt(0) === '&') newSels.push((psel + trimmedPart.slice(1)).trim());
          else newSels.push((psel + ' ' + trimmedPart).trim());
        }
      }
      stack.push([newSels.length ? newSels : [''], []]);
    } else if (ch === '}') {
      if (stack.length) {
        pushDecls(buf);
        buf = '';
        closeBlock();
      } else buf = '';
    } else if (ch === ';') {
      if (stack.length) {
        pushDecls(buf);
        buf = '';
      } else buf = '';
    } else {
      buf += ch;
    }
    i++;
  }

  const out: ScssBlocks = {};
  for (const key of Object.keys(blocks)) {
    if (blocks[key] && blocks[key].trim()) out[key] = blocks[key];
  }
  return out;
}

/** Declaration body → `{ propertySansDashes: value }` (lowercased, vendor prefixes dropped). */
export function parseDecls(body: string): ScssDeclarations {
  const d: ScssDeclarations = {};
  if (!body) return d;
  for (const rawLine of body.split(';')) {
    const line = rawLine.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().replace(/^-+/, '').toLowerCase().replace(/-/g, '');
    const val = line.slice(idx + 1).trim();
    if (val) d[key] = val;
  }
  return d;
}

/**
 * Look a selector up, tolerating the flattening that nesting introduces
 * (`.text` → `.TextBox_main .text`). The longest matching rule wins.
 */
export function lookup(blocks: ScssBlocks, selector: string): ScssDeclarations {
  if (blocks[selector]) return parseDecls(blocks[selector]);
  const suffix = ' ' + selector;
  let best: string | null = null;
  let bestLen = -1;
  for (const key of Object.keys(blocks)) {
    if (key.length > suffix.length - 1 && key.slice(-suffix.length) === suffix) {
      if (blocks[key].length > bestLen) {
        best = key;
        bestLen = blocks[key].length;
      }
    }
  }
  return best ? parseDecls(blocks[best]) : {};
}

/** First non-empty value among `names`, or `null`. */
export function declOf(obj: ScssDeclarations | null | undefined, ...names: string[]): string | null {
  if (!obj) return null;
  for (const name of names) {
    const v = obj[name];
    if (v != null && v !== '') return v;
  }
  return null;
}

/**
 * Round half away from zero.
 *
 * `Math.round` and Python's built-in `round` disagree at `.5`
 * (`Math.round(104.5) === 105`, `round(104.5) === 104`), which used to make the
 * JS and Python ports of this converter drift by a pixel.
 */
export function rnd(v: number): number {
  return Math.floor(Math.abs(v) + 0.5) * (v < 0 ? -1 : 1);
}

/** Length → integer stage pixels. Accepts `px` / `em` / `rem` / `pt` / `%` / bare numbers. */
/**
 * Resolve a CSS length into stage pixels.
 *
 * `baseIsScaled` marks a `basePx` the caller has **already** converted into
 * stage pixels — a parent's resolved `font-size`, typically. `%` and `em` are
 * relative to that base, so folding the stage scale in a second time shrinks
 * them twice: a `40px` parent resolves to `30px`, and `font-size: 100%` against
 * it then lands on `23px` instead of `30px`. Absolute units always need the
 * single conversion.
 *
 * `percentBasis` is for the other percentage case: `left` / `right` resolve
 * against the containing block's *width* and `bottom` against its *height*, not
 * against a font size. That basis is already an engine-stage measurement, so a
 * percentage uses it directly — scaling it again would be the same double-count
 * the font-size path avoids.
 */
export function resolveLength(
  raw: unknown,
  basePx?: number,
  baseIsScaled = false,
  percentBasis?: number,
): number | null {
  if (raw == null) return null;
  const base = basePx || ROOT_FONT_PX;
  const text = String(raw).trim().replace(/!\s*\w+\s*$/, '').trim();
  const m = /^(-?[\d.]+)\s*(px|em|rem|pt|%)?$/.exec(text);
  if (!m) return null;
  let val = parseFloat(m[1]);
  const unit = m[2] || 'px';
  if (unit === '%' && percentBasis != null) return rnd((percentBasis * val) / 100);
  const relative = unit === 'em' || unit === 'rem' || unit === '%';
  if (unit === 'em' || unit === 'rem') val *= base;
  else if (unit === '%') val = (base * val) / 100;
  else if (unit === 'pt') val *= 96 / 72;
  return rnd(val * (relative && baseIsScaled ? 1 : STAGE_SCALE));
}

/** Resolve only the first token, so `border-radius: 0 0 0 0` reads as `0`. */
export function firstLength(raw: unknown, base?: number, baseIsScaled = false, percentBasis?: number): number | null {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/!\s*\w+\s*$/, '').trim().split(/\s+/)[0];
  if (!t) return null;
  return resolveLength(t, base, baseIsScaled, percentBasis);
}

/**
 * Resolve width-like properties (`width` / `min-width` / `max-width`).
 *
 * Here `%` means **a share of the containing block**, not of the font size:
 * `min-width: 25%` is a quarter of the parent's width. Treating it as a font
 * relative unit turns it into a few pixels.
 *
 * `containerPx` (for `%`) and `fontBase` (for `em`) are already expressed in
 * AeonStagery stage pixels, so they must not be rescaled again; only absolute
 * units carry the WebGAL → AeonStagery stage factor.
 */
export function resolveWidthLike(raw: unknown, fontBase: number, containerPx: number): number | null {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/!\s*\w+\s*$/, '').trim().split(/\s+/)[0];
  const m = /^(-?[\d.]+)\s*(px|em|rem|pt|%)?$/.exec(t);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2] || 'px';
  if (u === '%') return rnd((containerPx * v) / 100);
  if (u === 'em' || u === 'rem') return rnd(v * fontBase);
  if (u === 'pt') return rnd((v * 96) / 72 * STAGE_SCALE);
  return rnd(v * STAGE_SCALE);
}

/** First declared property among `props`, or `null`. */
export function pickDecl(obj: ScssDeclarations | null | undefined, props: readonly string[]): string | null {
  if (!obj || !props) return null;
  for (const prop of props) {
    const v = obj[prop];
    if (v != null && v !== '') return v;
  }
  return null;
}

function pad2(v: number): string {
  const s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
  return s.length < 2 ? '0' + s : s;
}

/**
 * Parse a colour into 8-digit `#RRGGBBAA`, or `null` when it is not a colour.
 *
 * Named colours are required: templates write `color: white` constantly, and a
 * hex/rgb-only parser silently swaps in the fallback, which looks completely
 * wrong rather than merely off.
 */
export function tryParseColor(raw: unknown): string | null {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === 'none' || s === 'initial' || s === 'unset' || s === 'inherit') return null;
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s];
  if (s.charAt(0) === '#') {
    let h = s.slice(1);
    // Case-insensitive: the named-colour table stores upper-case hex, so a
    // lower-case-only test would reject `white`, `red`, `orange`, ... and the
    // caller would silently fall back to an unrelated colour.
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    else if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    if (h.length === 6) h += 'FF';
    if (h.length !== 8) return null;
    return '#' + h.toUpperCase();
  }
  const fn = /rgba?\(\s*([^)]+)\)/.exec(s);
  if (fn) {
    const p = fn[1].split(/[,\/\s]+/).filter((x) => x !== '');
    if (p.length >= 3) {
      const to255 = (x: string): number => (
        x.charAt(x.length - 1) === '%' ? parseFloat(x) * 2.55 : parseFloat(x)
      );
      const a = p.length > 3 ? p[3] : '1';
      const alpha = a.charAt(a.length - 1) === '%' ? parseFloat(a) * 2.55 : parseFloat(a) * 255;
      if (Number.isNaN(to255(p[0])) || Number.isNaN(to255(p[1])) || Number.isNaN(to255(p[2]))) return null;
      return '#' + pad2(to255(p[0])) + pad2(to255(p[1])) + pad2(to255(p[2])) + pad2(alpha);
    }
  }
  return null;
}

/** {@link tryParseColor} with a fallback for unparsable input. */
export function parseColor(raw: unknown, fallback?: string): string {
  return tryParseColor(raw) || fallback || '#FFFFFF';
}

/** Strip alpha — the engine only accepts 6-digit `#RRGGBB`. */
export function rgbOnly(hexa: string | null | undefined): string {
  let h = String(hexa || '').replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return ('#' + h.slice(0, 6)).toUpperCase();
}

/** `#RRGGBBAA` → `0..1`. */
export function alphaOf(hexa: string | null | undefined): number {
  const h = String(hexa || '');
  return h.length >= 9 ? parseInt(h.slice(7, 9), 16) / 255 : 1;
}

/**
 * Body of the **first** `linear-gradient(...)`.
 *
 * Templates chain gradients (`background: linear-gradient(a), linear-gradient(b)`),
 * and a greedy match would splice both into one list of misplaced stops, so the
 * parentheses are balanced by hand.
 */
export function firstGradientBody(raw: unknown): string | null {
  const s = String(raw == null ? '' : raw);
  const start = s.toLowerCase().indexOf('linear-gradient');
  if (start < 0) return null;
  const open = s.indexOf('(', start);
  if (open < 0) return null;
  let depth = 0;
  let k = open;
  for (; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return s.slice(open + 1, k);
}

/** Split on commas that are not nested inside parentheses. */
export function splitTopLevel(s: unknown): string[] {
  const source = String(s == null ? '' : s);
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => String(x).trim()).filter((x) => !!x);
}

/**
 * Parse a `background`-style paint: a solid colour or a linear gradient.
 *
 * @returns `null` for `none` / unparsable input.
 */
export function parsePaint(raw: unknown): Paint | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === 'none') return null;

  const bodyRaw = firstGradientBody(s);
  if (bodyRaw != null) {
    let body = bodyRaw.trim();
    let angle = 180; // CSS default: to bottom
    const deg = /^(-?[\d.]+)deg/i.exec(body);
    if (deg) {
      angle = parseFloat(deg[1]);
      body = body.replace(/^(-?[\d.]+)deg\s*,?/i, '');
    } else if (/^to\s+bottom\s+right/i.test(body)) { angle = 135; body = body.replace(/^to\s+bottom\s+right\s*,?/i, ''); }
    else if (/^to\s+bottom\s+left/i.test(body)) { angle = 225; body = body.replace(/^to\s+bottom\s+left\s*,?/i, ''); }
    else if (/^to\s+top\s+right/i.test(body)) { angle = 45; body = body.replace(/^to\s+top\s+right\s*,?/i, ''); }
    else if (/^to\s+top\s+left/i.test(body)) { angle = 315; body = body.replace(/^to\s+top\s+left\s*,?/i, ''); }
    else if (/^to\s+top/i.test(body)) { angle = 0; body = body.replace(/^to\s+top\s*,?/i, ''); }
    else if (/^to\s+bottom/i.test(body)) { angle = 180; body = body.replace(/^to\s+bottom\s*,?/i, ''); }
    else if (/^to\s+right/i.test(body)) { angle = 90; body = body.replace(/^to\s+right\s*,?/i, ''); }
    else if (/^to\s+left/i.test(body)) { angle = 270; body = body.replace(/^to\s+left\s*,?/i, ''); }

    const stops: Array<{ color: string; pos: number | null }> = [];
    for (const part of splitTopLevel(body)) {
      const mc = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|\b[a-z]+\b)\s*$/.exec(part)
        || /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|\b[a-z]+\b)/.exec(part);
      if (!mc) continue;
      const col = tryParseColor(mc[1]);
      if (!col) continue;
      const mp = /(-?[\d.]+)%/.exec(part);
      stops.push({ color: col, pos: mp ? parseFloat(mp[1]) / 100 : null });
    }
    if (!stops.length) return null;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    for (let k = 1; k < stops.length; k++) {
      if (stops[k].pos == null) stops[k].pos = stops[k - 1].pos;
    }
    return {
      kind: 'linear',
      angle,
      stops: stops.map((stop) => ({ color: stop.color, pos: stop.pos ?? 0 })),
    };
  }

  const solid = tryParseColor(s);
  if (solid) return { kind: 'solid', color: solid };
  return null;
}

/** Representative 6-digit colour of a paint: the widest gradient band, or the solid colour. */
export function paintColor(paint: Paint | null | undefined, fallback: string): string {
  if (!paint) return fallback;
  if (paint.kind === 'solid') return rgbOnly(paint.color);
  if (paint.stops && paint.stops.length) {
    let best = paint.stops[0];
    let bestSpan = -1;
    for (let i = 0; i < paint.stops.length; i++) {
      const next = paint.stops[i + 1] ? paint.stops[i + 1].pos : 1;
      const span = next - paint.stops[i].pos;
      if (span > bestSpan) {
        bestSpan = span;
        best = paint.stops[i];
      }
    }
    return rgbOnly(best.color);
  }
  return fallback;
}

/**
 * Reduce a `text-shadow` list to a single drop shadow.
 *
 * Two details matter for fidelity:
 *
 * 1. **Merge by alpha, not by blur.** Templates simulate an outline with several
 *    layers — e.g. `-1.5px -1.5px 10px rgba(0,0,0,.85)` ×4 plus a soft
 *    `0 2px 50px rgba(0,0,0,.3)`. Picking the widest blur selects the 30% haze
 *    and renders the body text inside a grey cloud; the outline layer is what
 *    actually reads as the shadow.
 * 2. **Extract the colour before the numbers.** A bare `[a-zA-Z]+` matches the
 *    `px` of `-1.5px`, every layer then fails to parse its colour, alpha
 *    degrades to 1 and the alpha sort becomes a no-op. Likewise the numeric scan
 *    strips colour fragments first and pads a unit-less `0`, because
 *    `0 0 12px rgba(0,0,0,.9)` is a common shorthand whose numbers would
 *    otherwise shift by one slot.
 */
export function parseTextShadow(raw: unknown): TextShadowInfo {
  const out: TextShadowInfo = {
    has: false, color: '#000000', alpha: 0.85, blur: 10, distance: 2,
    offsetX: 0, symmetric: false,
  };
  if (!raw) return out;
  const shadows = splitTopLevel(raw);
  if (!shadows.length) return out;

  const parsed = shadows.map((s) => {
    const cm = /(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(s);
    let colorRaw = cm ? cm[1] : null;
    if (!colorRaw) {
      const stripped = s.replace(/-?[\d.]+(px|em|rem|pt|%)?/g, ' ');
      const cm2 = /\b([a-zA-Z]{3,})\b/.exec(stripped);
      colorRaw = cm2 ? cm2[1] : '#000000';
    }
    const hexa = parseColor(colorRaw, '#000000FF');
    const noColor = String(s)
      .replace(/rgba?\([^)]*\)/g, ' ')
      .replace(/#[0-9a-fA-F]{3,8}/g, ' ')
      .replace(/\b[a-zA-Z]{3,}\b/g, ' ');
    const norm = noColor.replace(/(^|[\s,])0(?=[\s,]|$)/g, '$10px');
    const nums = (norm.match(/(-?[\d.]+)px/g) || []).map((x) => parseFloat(x) * STAGE_SCALE);
    return {
      blur: nums.length > 2 ? nums[2] : 0,
      oy: nums.length > 1 ? nums[1] : 0,
      ox: nums.length > 0 ? nums[0] : 0,
      color: rgbOnly(hexa),
      alpha: alphaOf(hexa),
    };
  });

  parsed.sort((a, b) => {
    if (b.alpha !== a.alpha) return b.alpha - a.alpha;
    return a.blur - b.blur;
  });
  const top = parsed[0];

  const same = parsed.filter((s) => (
    Math.abs(s.alpha - top.alpha) < 0.02 && Math.abs(s.blur - top.blur) < 0.5
  ));
  let symmetric = false;
  if (same.length >= 2) {
    symmetric = true;
    for (const a of same) {
      if (!symmetric) break;
      if (a.ox === 0 && a.oy === 0) continue; // offset-free layers do not vote
      const paired = same.some((b) => b !== a
        && Math.abs(a.ox + b.ox) < 0.01 && Math.abs(a.oy + b.oy) < 0.01);
      if (!paired) symmetric = false;
    }
  }
  if (top.ox === 0 && top.oy === 0) symmetric = true;

  out.has = true;
  out.color = top.color;
  out.alpha = top.alpha;
  out.blur = top.blur;
  out.distance = top.oy;
  out.offsetX = top.ox;
  out.symmetric = symmetric;
  return out;
}

/** `border: <width> <style> <color>` in any order. */
export function parseBorder(raw: unknown, base?: number): BorderInfo {
  const out: BorderInfo = { width: 0, color: null };
  if (!raw) return out;
  const s = String(raw).trim();
  const mw = /(-?[\d.]+)\s*(px|em|rem|pt)?/.exec(s);
  if (mw) out.width = resolveLength(mw[1] + (mw[2] || 'px'), base) || 0;
  const mc = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|\b[a-zA-Z]+\b)\s*$/.exec(s);
  if (mc) {
    const c = tryParseColor(mc[1]);
    if (c) out.color = c;
  }
  return out;
}

/**
 * First `box-shadow` layer.
 *
 * Colour fragments are removed before scanning for lengths: the `190`s inside
 * `rgba(190,190,190,.8)` would otherwise be read as a spread, blowing the shadow
 * out into a huge offset ring.
 */
export function parseBoxShadow(raw: unknown, base?: number): BoxShadowInfo | null {
  if (!raw || /^none$/i.test(String(raw).trim())) return null;
  const first = splitTopLevel(raw)[0] || '';
  if (!first) return null;

  let color: string | null = null;
  const mc = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|\b[a-zA-Z]+\b)/.exec(first);
  if (mc) color = tryParseColor(mc[1]);

  const numeric = first
    .replace(/rgba?\([^)]*\)/gi, ' ')
    .replace(/#[0-9a-fA-F]{3,8}/g, ' ')
    .replace(/(^|\s)[a-zA-Z]+(?=\s|$)/g, ' ');

  const nums: number[] = [];
  const re = /(-?[\d.]+)\s*(px|em|rem|pt)?/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(numeric)) !== null) {
    if (mm[0].trim() === '') {
      re.lastIndex++;
      continue;
    }
    const v = resolveLength(mm[1] + (mm[2] || 'px'), base);
    if (v != null) nums.push(v);
    if (nums.length >= 4) break;
  }
  if (!nums.length) return null;
  return {
    dx: nums[0] || 0,
    dy: nums.length > 1 ? nums[1] : 0,
    blur: nums.length > 2 ? nums[2] : 0,
    spread: nums.length > 3 ? nums[3] : 0,
    color: color || '#00000080',
  };
}

/** Expand a 1–4 value `padding` / `margin` shorthand. */
export function parseBoxSides(raw: unknown, base?: number, baseIsScaled = false, percentBasis?: number): BoxSides {
  const parts = String(raw || '').trim().split(/\s+/).map((x) => x.trim()).filter(Boolean);
  const vals = parts
    .map((p) => resolveLength(p, base, baseIsScaled, percentBasis))
    .filter((v): v is number => v != null);
  let out: BoxSides | null = null;
  if (vals.length === 1) out = { t: vals[0], r: vals[0], b: vals[0], l: vals[0] };
  else if (vals.length === 2) out = { t: vals[0], r: vals[1], b: vals[0], l: vals[1] };
  else if (vals.length === 3) out = { t: vals[0], r: vals[1], b: vals[2], l: vals[1] };
  else if (vals.length >= 4) out = { t: vals[0], r: vals[1], b: vals[2], l: vals[3] };
  return out || { t: 0, r: 0, b: 0, l: 0 };
}

/**
 * Read the uniform `scale()` of a `transform` declaration.
 *
 * `image-dialogue-v1` has no transform concept, so ignoring a template's
 * `transform: scale(.9)` inflates the whole panel — geometry, padding, radii and
 * font size alike — by ~11% and leaves the side and bottom margins wrong.
 *
 * @returns `null` when there is no scaling or the value is unusable.
 */
export function parseScale(raw: unknown): ScaleInfo | null {
  if (raw == null) return null;
  const s = String(raw);
  let sx = 1;
  let sy = 1;
  let found = false;
  const m = /scale\(\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+)\s*)?\)/.exec(s);
  if (m) {
    sx = parseFloat(m[1]);
    sy = m[2] != null ? parseFloat(m[2]) : sx;
    found = true;
  }
  const mx = /scaleX\(\s*(-?[\d.]+)\s*\)/.exec(s);
  if (mx) {
    sx = parseFloat(mx[1]);
    found = true;
  }
  const my = /scaleY\(\s*(-?[\d.]+)\s*\)/.exec(s);
  if (my) {
    sy = parseFloat(my[1]);
    found = true;
  }
  if (!found) return null;
  if (!Number.isFinite(sx) || sx <= 0) sx = 1;
  if (!Number.isFinite(sy) || sy <= 0) sy = 1;
  if (sx === 1 && sy === 1) return null;
  return { sx, sy };
}

/** Merge the `padding` shorthand with its `padding-*` longhands. */
export function sidesWithLonghand(obj: ScssDeclarations, base?: number, baseIsScaled = false, percentBasis?: number): BoxSides {
  const sides = parseBoxSides(obj.padding, base, baseIsScaled, percentBasis);
  for (const key of ['top', 'right', 'bottom', 'left'] as const) {
    const v = resolveLength(obj['padding' + key], base, baseIsScaled, percentBasis);
    if (v != null) sides[key.charAt(0) as 't' | 'r' | 'b' | 'l'] = v;
  }
  return sides;
}

/** Extract the file name from a `url("...")` value. */
export function urlBasename(raw: unknown): string | null {
  if (!raw) return null;
  const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(String(raw));
  if (!m) return null;
  const p = m[1].split(/[?#]/)[0];
  const seg = p.split(/[\\/]/);
  return seg[seg.length - 1] || null;
}

/** True when the block hides its box, so its other declarations must be ignored. */
export function hasVisibilityHidden(obj: ScssDeclarations | null | undefined): boolean {
  return /hidden|collapse/i.test(String((obj && obj.visibility) || ''));
}
