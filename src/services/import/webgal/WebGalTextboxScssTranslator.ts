/**
 * Convert a WebGAL dialogue template's `textbox.scss` into
 * `image-dialogue-v1` presentation parameters.
 *
 * WebGAL templates describe their subtitle in a stylesheet, while AeonStagery
 * materials them into an explicit `DialogueImagePresentation`. This module
 * bridges the two: it reads the template's box, text and nameplate rules and
 * emits a presentation snapshot plus the theme metadata needed to draw matching
 * panel artwork (see the SCSS asset builder).
 *
 * Ordering matters and is preserved from the original converter:
 *
 * 1. resolve the font size and line height, because later paddings are derived
 *    from them;
 * 2. resolve the box geometry and the text column;
 * 3. colour, outline and shadow of the body text and the nameplate;
 * 4. apply the template's `transform: scale()` to **everything above** as a final
 *    affine pass, then derive the nine-slice slices from the scaled numbers.
 *
 * Ported from the standalone bridge tooling that shipped this conversion as a
 * browser-side patch; the resulting parameter objects are byte-compatible.
 */
import type {
  DialogueImagePresentation,
  DialogueImageSpeakerStyle,
  DialogueImageTextStyle,
  DialogueNineSlice,
} from '../../../api/types/semantic-scene';
import {
  alphaOf,
  declOf,
  firstLength,
  hasVisibilityHidden,
  lookup,
  parseBlocks,
  parseBorder,
  parseBoxShadow,
  parseColor,
  parsePaint,
  parseScale,
  parseTextShadow,
  paintColor,
  pickDecl,
  resolveLength,
  resolveWidthLike,
  rgbOnly,
  rnd,
  sidesWithLonghand,
  STAGE_SCALE,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  ROOT_FONT_PX,
  SHADOW_BLUR_RATIO,
  SHADOW_DIST_RATIO,
  tryParseColor,
  urlBasename,
  type BorderInfo,
  type BoxShadowInfo,
  type BoxSides,
  type Paint,
  type ScssBlocks,
  type ScssDeclarations,
  type ScaleInfo,
} from './WebGalScssSyntax';

/** A corner ornament referenced by a panel's `::after` rule. */
export interface WebGalPanelDecoration {
  /** File name only; the importer resolves it inside the template's `assets/`. */
  file: string;
  size: number;
  opacity: number;
  /** Degrees, from the rule's `transform: rotate(...)`. */
  rotate: number;
  right: number;
  bottom: number;
}

/** Paint and framing of a single panel (textbox or namebox). */
export interface WebGalPanelTheme {
  fill: Paint;
  border: BorderInfo;
  radius: number;
  shadow: BoxShadowInfo | null;
  deco: WebGalPanelDecoration | null;
}

/** Visual metadata used to draw the panel artwork. Not part of the engine params. */
export interface WebGalTextBoxTheme {
  textbox: WebGalPanelTheme;
  namebox: WebGalPanelTheme;
}

export interface WebGalNineSlicePanelGeometry {
  width: number;
  height: number;
  nineSlice: DialogueNineSlice;
}

/** Draw size of the generated artwork, matching what the engine renders at 1:1. */
export interface WebGalTextBoxAssetGeometry {
  textbox: WebGalNineSlicePanelGeometry;
  namebox: WebGalNineSlicePanelGeometry;
}

/** Presentation parameters, without the fields the caller fills in. */
export type WebGalDialogueParams = Omit<DialogueImagePresentation, 'renderer' | 'styleId'>;

export interface WebGalDialogueStyle {
  id: string;
  name: string;
  renderer: 'image-dialogue-v1';
  params: WebGalDialogueParams;
}

export interface WebGalScssTranslationOptions {
  /** Stylesheet file name, used to derive the style id and default label. */
  sourceName?: string;
  /**
   * Force the text column to the horizontal centre of the canvas instead of
   * honouring an asymmetric `left` / `right` pair.
   */
  strictCenter?: boolean;
  /** Font family from the template's `template.json` (SCSS rarely declares one). */
  fontFamily?: string;
  /** Font file shipped inside the template package. */
  fontFile?: string | null;
}

export interface WebGalScssTranslation {
  style: WebGalDialogueStyle;
  /** Human-readable record of every decision and approximation made. */
  notes: string[];
  theme: WebGalTextBoxTheme;
  assetGeom: WebGalTextBoxAssetGeometry;
}

const PANEL_IMAGE_DIR = 'ui/dialogue/webgal/';

/**
 * Read the painting metadata of both panels.
 *
 * Both panels take their base measurement from the **root** font size rather
 * than the resolved text size: `.TextBox_Background` / `.TextBox_showName` are
 * siblings of `.TextBox_main`, so they inherit the root size, and a template's
 * `240%` on `.text` only applies to that element. Using the resolved size here
 * used to inflate a `width: 6em` from 120px to 288px.
 */
export function extractWebGalTextBoxTheme(blocks: ScssBlocks): WebGalTextBoxTheme {
  const main = lookup(blocks, '.TextBox_main');
  const bg = lookup(blocks, '.TextBox_Background');
  const nameBg = lookup(blocks, '.TextBox_ShowName_Background');
  const name = lookup(blocks, '.TextBox_showName');
  const bgAfter = lookup(blocks, '.TextBox_Background::after');
  const nameAfter = lookup(blocks, '.TextBox_ShowName_Background::after');

  const base = ROOT_FONT_PX;
  const nameBase = ROOT_FONT_PX;

  // The background may live on the backdrop element or on the container itself:
  // some templates paint `.TextBox_Background`, others write the fill directly
  // on `.TextBox_main`. Checking only one of them yields the wrong (often
  // fully transparent) fill.
  const textboxFillRaw = pickDecl(bg, ['background', 'backgroundcolor', 'backgroundimage'])
    || pickDecl(main, ['background', 'backgroundcolor', 'backgroundimage']);

  const textbox: WebGalPanelTheme = {
    fill: parsePaint(textboxFillRaw) || { kind: 'solid', color: '#00000000' },
    border: parseBorder(pickDecl(bg, ['border']) || pickDecl(main, ['border']), base),
    radius: firstLength(pickDecl(bg, ['borderradius']) || declOf(main, 'borderradius'), base) || 0,
    shadow: parseBoxShadow(pickDecl(bg, ['boxshadow']) || pickDecl(main, ['boxshadow']), base),
    deco: null,
  };
  const textboxDecoFile = urlBasename(declOf(bgAfter, 'backgroundimage'));
  if (textboxDecoFile) {
    const opacity = parseFloat(declOf(bgAfter, 'opacity') || '1');
    const deg = /(-?[\d.]+)deg/.exec(String(declOf(bgAfter, 'transform') || ''));
    textbox.deco = {
      file: textboxDecoFile,
      size: resolveLength(declOf(bgAfter, 'width', 'backgroundsize'), base)
        || rnd(base * 6 * STAGE_SCALE),
      opacity: Number.isNaN(opacity) ? 1 : opacity,
      rotate: deg ? parseFloat(deg[1]) : 0,
      right: resolveLength(declOf(bgAfter, 'right'), base) || 0,
      bottom: resolveLength(declOf(bgAfter, 'bottom'), base) || 0,
    };
  }

  // The nameplate fill must not fall back to `.TextBox_showName`'s `background`
  // unconditionally: WebGAL renders the nameplate as two sibling divs (backdrop
  // plus label) that share `.TextBox_showName`, and in a frameless subtitle
  // template that declaration only shades the glyphs rather than becoming a
  // plate. So a template whose dialogue box is itself transparent keeps a
  // transparent nameplate; only a box with a fill falls back.
  const nameFillRaw = pickDecl(nameBg, ['background', 'backgroundcolor', 'backgroundimage']);
  const boxIsTransparent = !!(textbox.fill && textbox.fill.kind === 'solid'
    && alphaOf(textbox.fill.color) < 0.004);
  const namebox: WebGalPanelTheme = {
    fill: (!nameFillRaw && boxIsTransparent)
      ? { kind: 'solid', color: '#00000000' }
      : (parsePaint(nameFillRaw || pickDecl(name, ['background', 'backgroundcolor', 'backgroundimage']))
        || { kind: 'solid', color: '#FFFFFF' }),
    border: parseBorder(pickDecl(nameBg, ['border']) || pickDecl(name, ['border']), nameBase),
    radius: firstLength(pickDecl(nameBg, ['borderradius']) || declOf(name, 'borderradius'), nameBase) || 0,
    shadow: parseBoxShadow(pickDecl(nameBg, ['boxshadow']) || pickDecl(name, ['boxshadow']), nameBase),
    deco: null,
  };
  const nameDecoFile = urlBasename(declOf(nameAfter, 'backgroundimage'));
  if (nameDecoFile) {
    namebox.deco = {
      file: nameDecoFile,
      size: resolveLength(declOf(nameAfter, 'width', 'backgroundsize'), nameBase) || 0,
      opacity: 1,
      rotate: 0,
      right: resolveLength(declOf(nameAfter, 'right'), nameBase) || 0,
      bottom: resolveLength(declOf(nameAfter, 'bottom'), nameBase) || 0,
    };
  }

  return { textbox, namebox };
}

/**
 * Scale the theme's pixel quantities to match a template's `transform`.
 *
 * Radii and blur use the smaller factor so non-uniform scaling never stretches
 * them; offsets follow their own axis.
 */
function scaleTheme(theme: WebGalTextBoxTheme, sx: number, sy: number): void {
  const uniform = Math.min(sx, sy);
  for (const slot of ['textbox', 'namebox'] as const) {
    const panel = theme[slot];
    if (!panel) continue;
    if (panel.radius) panel.radius = rnd(panel.radius * uniform);
    if (panel.border && panel.border.width) panel.border.width = rnd(panel.border.width * uniform);
    if (panel.shadow) {
      panel.shadow.dx = rnd(panel.shadow.dx * sx);
      panel.shadow.dy = rnd(panel.shadow.dy * sy);
      panel.shadow.blur = rnd(panel.shadow.blur * uniform);
      panel.shadow.spread = rnd(panel.shadow.spread * uniform);
    }
    if (panel.deco) {
      panel.deco.size = rnd(panel.deco.size * uniform);
      panel.deco.right = rnd(panel.deco.right * sx);
      panel.deco.bottom = rnd(panel.deco.bottom * sy);
    }
  }
}

/** Read the alignment a template expresses through `text-align` or flex `align-items`. */
function resolveTextAlignment(main: ScssDeclarations, textBlock: ScssDeclarations): 'left' | 'center' | 'right' {
  const ta = String(declOf(main, 'textalign') || declOf(textBlock, 'textalign') || '').trim();
  const ai = String(main.alignitems || '').trim();
  if (/^(left|start)$/.test(ta)) return 'left';
  if (/^(right|end)$/.test(ta)) return 'right';
  if (ta === 'center') return 'center';
  if (/^(flex-start|start|left)$/.test(ai)) return 'left';
  if (/^(flex-end|end|right)$/.test(ai)) return 'right';
  if (ai === 'center') return 'center';
  return 'center';
}

/**
 * Read the nameplate's horizontal alignment.
 *
 * WebGAL's `.TextBox_showName` label is block-level and therefore left aligned
 * (it declares no `text-align` itself), with the left inset coming from
 * `padding-left`; a template may still opt into centring. Rendering it as
 * centred squashes short names into the middle of the plate.
 */
function resolveNameAlignment(name: ScssDeclarations, nameBackground: ScssDeclarations): 'left' | 'center' | 'right' {
  const nta = String(declOf(name, 'textalign') || declOf(nameBackground, 'textalign') || '')
    .trim().toLowerCase();
  if (nta === 'center') return 'center';
  if (nta === 'right' || nta === 'end') return 'right';
  return 'left';
}

function describePaint(paint: Paint | null): string {
  if (!paint) return '无';
  if (paint.kind === 'solid') {
    const a = alphaOf(paint.color);
    return a >= 0.999 ? rgbOnly(paint.color) : `rgba(${rgbOnly(paint.color)}, ${rnd(a * 100) / 100})`;
  }
  return `linear-gradient(${paint.angle}deg, `
    + paint.stops.map((s) => `${rgbOnly(s.color)} ${rnd(s.pos * 100)}%`).join(', ') + ')';
}

/** Convert a `text-shadow` grouping into the engine's `dropShadow*` parameters. */
function toDropShadow(
  shadow: ReturnType<typeof parseTextShadow>,
  fontSize: number,
  uniformScale: number | undefined,
  axisScale: number | undefined,
): Partial<DialogueImageTextStyle> {
  if (!shadow.has) return {};
  return {
    dropShadow: true,
    dropShadowColor: shadow.color,
    dropShadowAlpha: rnd(shadow.alpha * 1000) / 1000,
    // A symmetric layer group is an outline: its blur is a fixed pixel value in
    // the stylesheet and must not be inflated by the font size, which would
    // smear the crisp edge the template asked for.
    dropShadowBlur: shadow.symmetric
      ? Math.max(1, rnd(shadow.blur * (uniformScale || 1)))
      : Math.max(1, rnd(Math.max(shadow.blur, fontSize * SHADOW_BLUR_RATIO) * (uniformScale || 1))),
    // A symmetric group must lose its offset: the engine's drop shadow only
    // points one way, so keeping it turns an even glow into a corner smudge.
    dropShadowDistance: shadow.symmetric ? 0 : Math.max(0, rnd(
      Math.max(Math.abs(shadow.distance), fontSize * SHADOW_DIST_RATIO) * (axisScale || 1),
    )),
  };
}

/**
 * Translate a WebGAL `textbox.scss` into an `image-dialogue-v1` dialogue style.
 */
export function translateWebGalTextboxScss(
  css: string,
  options: WebGalScssTranslationOptions = {},
): WebGalScssTranslation {
  const sourceName = options.sourceName || 'textbox.scss';
  const strictCenter = options.strictCenter === true;
  const notes: string[] = [];
  const blocks = parseBlocks(css);

  const main = lookup(blocks, '.TextBox_main');
  const outer = lookup(blocks, '.outer');
  const inner = lookup(blocks, '.inner');
  const name = lookup(blocks, '.TextBox_showName');
  const outerName = lookup(blocks, '.outerName');
  const textBlock = lookup(blocks, '.text');

  // ── Font size ──
  // `.text` declares its own size, which in CSS beats the one inherited from
  // `.TextBox_main` while its `%` / `em` resolve against that inherited value.
  // Reading only the parent drops the child's declaration entirely: a `40px`
  // parent with `.text { font-size: 240% }` renders at 96px, not at 40px.
  const mainFs = resolveLength(main.fontsize, ROOT_FONT_PX);
  let fontSize: number;
  if (textBlock.fontsize != null) {
    // `.TextBox_main` inherits the root size when it declares none.
    const parentFs = mainFs ?? ROOT_FONT_PX;
    fontSize = resolveLength(textBlock.fontsize, parentFs, mainFs != null) ?? parentFs;
    if (mainFs == null) {
      notes.push(`\`.TextBox_main\` 未设 \`font-size\`，字号取自 \`.text\` 的 `
        + `\`${textBlock.fontsize}\`（按 WebGAL 根字号 ${ROOT_FONT_PX}px 换算）。`);
    }
  } else if (mainFs != null) {
    fontSize = mainFs;
  } else {
    fontSize = rnd(48 * STAGE_SCALE);
    notes.push(`模板未声明 \`font-size\`（靠继承），已回退到 ${fontSize}px。`);
  }
  // A font size has to be a positive finite number: `0` measures as an empty
  // text and a negative one is invalid CSS outright, and either would leave the
  // engine with a layer it cannot lay out. Anything unusable falls back to the
  // inherited root size rather than being carried through.
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    fontSize = ROOT_FONT_PX * STAGE_SCALE;
    notes.push(`模板的 \`font-size\` 不是正数，已回退到 ${fontSize}px。`);
  }

  // ── Line height (ratio or absolute) ──
  let lineHeight: number;
  const lineHeightRaw = declOf(main, 'lineheight') || declOf(textBlock, 'lineheight');
  if (lineHeightRaw != null) {
    const raw = String(lineHeightRaw).trim().replace(/!\s*\w+\s*$/, '').trim();
    const absolute = /^(-?[\d.]+)\s*(px|pt)$/.exec(raw);
    if (absolute) {
      lineHeight = rnd(parseFloat(absolute[1]) * (absolute[2] === 'pt' ? 96 / 72 : 1) * STAGE_SCALE);
    } else {
      const numeric = /^([\d.]+)/.exec(raw);
      if (numeric) {
        const num = parseFloat(numeric[1]);
        lineHeight = rnd(raw.slice(-1) === '%' ? (fontSize * num) / 100 : fontSize * num);
      } else lineHeight = rnd(fontSize * 1.6);
    }
  } else lineHeight = rnd(fontSize * 1.6);
  lineHeight = Math.max(lineHeight, fontSize);

  // ── Layout ──
  // Engine geometry: `o = max(textbox.height, inset + textHeight + inset)` with
  // `textbox.height` pinned to the authored height, so supplying `height` keeps
  // the bottom edge fixed and grows upward — the equivalent of WebGAL's
  // `bottom: <n>px`. Supplying only `minHeight` would grow downward instead.
  // `left` / `right` percentages resolve against the containing block's width,
  // `bottom` against its height — never against a font size. The stage and the
  // WebGAL canvas are both 3:4, so a percentage of either lands on the same
  // stage pixel and the basis is used unscaled.
  let left = resolveLength(main.left, ROOT_FONT_PX, false, STAGE_WIDTH);
  if (left == null) left = rnd(50 * STAGE_SCALE);
  let right = resolveLength(main.right, ROOT_FONT_PX, false, STAGE_WIDTH);
  if (right == null) right = rnd(25 * STAGE_SCALE);
  let bottom = resolveLength(main.bottom, ROOT_FONT_PX, false, STAGE_HEIGHT);
  if (bottom == null) bottom = rnd(40 * STAGE_SCALE);
  let boxX = left;
  let boxW = Math.max(320, STAGE_WIDTH - left - right);

  // CSS resolves every percentage padding against the containing block *width*,
  // including the top and bottom ones.
  const pads = sidesWithLonghand(main, ROOT_FONT_PX, false, STAGE_WIDTH);
  if (!main.padding && !main.paddingtop && !main.paddingleft) {
    pads.t = rnd(fontSize * 0.4);
    pads.b = pads.t;
    pads.l = rnd(fontSize * 0.7);
    pads.r = pads.l;
  }

  if (strictCenter) {
    const maxW = Math.min(boxW, STAGE_WIDTH - pads.l - pads.r);
    boxW = maxW;
    boxX = Math.round((STAGE_WIDTH - maxW) / 2);
  }

  let boxH = resolveLength(declOf(main, 'height'), ROOT_FONT_PX, false, STAGE_HEIGHT);
  if (boxH == null) boxH = resolveLength(declOf(main, 'minheight'), ROOT_FONT_PX, false, STAGE_HEIGHT);
  const autoHeight = (boxH == null || boxH <= 0);
  // Tested inline rather than through `autoHeight` so the value is narrowed to a
  // number for the geometry maths below.
  if (boxH == null || boxH <= 0) boxH = Math.max(lineHeight + pads.t + pads.b, rnd(fontSize * 2));
  let boxY = Math.max(0, STAGE_HEIGHT - bottom - boxH);

  let textX = boxX + pads.l;
  let textW = Math.max(1, boxW - pads.l - pads.r);
  let textY = boxY + pads.t;

  const centerOffset = (boxX + boxW / 2) - (STAGE_WIDTH / 2);
  if (strictCenter) {
    notes.push('已启用**严格居中**（`strictCenter`）：文本区中心对齐画布中心 960px。');
  } else if (Math.abs(centerOffset) > 0.5) {
    notes.push(`**水平偏心 ${centerOffset}px**：这是模板自身的设计`
      + `（\`left:${left}\` 与 \`right:${right}\` 不对称），忠实还原的结果。`
      + '若想强制居中，可在导入时传 `strictCenter: true`。');
  }

  if (autoHeight) {
    notes.push('⚠️ 模板未声明固定高度，`height` 由行高+内边距估算，若观感不符请直接调 `textbox.height`。');
  }

  // ── Body text colour ──
  // The standard WebGAL idiom is `.outer { color: transparent; background: <c>;
  // background-clip: text }` — the visible colour comes from the background
  // gradient, not from `color`.
  const clipRaw = declOf(outer, 'webkitbackgroundclip', 'backgroundclip');
  let outerPaint = parsePaint(declOf(outer, 'background', 'backgroundcolor'));
  if (!outerPaint) outerPaint = parsePaint(declOf(outer, 'backgroundimage'));

  let textColor: string | null = null;
  if (outerPaint && clipRaw && /text/i.test(clipRaw)) {
    if (outerPaint.kind === 'linear') {
      let span = 0;
      let picked = outerPaint.stops[0];
      for (let si = 0; si < outerPaint.stops.length; si++) {
        const next = outerPaint.stops[si + 1] ? outerPaint.stops[si + 1].pos : 1;
        if (next - outerPaint.stops[si].pos > span) {
          span = next - outerPaint.stops[si].pos;
          picked = outerPaint.stops[si];
        }
      }
      textColor = rgbOnly(picked.color);
      notes.push('**渐变裁切文字**：`.outer` 用 `background-clip:text` 上色，'
        + `引擎 \`text.color\` 不支持渐变，已取占比最大的那一段色 \`${textColor}\`。`);
    } else {
      textColor = rgbOnly(outerPaint.color);
      notes.push(`**文字色取自 \`.outer\` 的 \`background-clip:text\`** → \`${textColor}\``
        + '（WebGAL 模板的常规写法；`.outer` 的 `color` 通常是 `transparent`，不能直接用）。');
    }
  }
  if (!textColor) {
    const innerCol = tryParseColor(inner.color);
    const mainCol = tryParseColor(main.color);
    if (innerCol && alphaOf(innerCol) > 0) textColor = rgbOnly(innerCol);
    else if (mainCol && alphaOf(mainCol) > 0) textColor = rgbOnly(mainCol);
    else textColor = '#FFFFFF';
  }

  // ── Outline ──
  // The engine defaults to `stroke = { color: 'transparent', width: 0 }`, so an
  // absent declaration means *no* outline. Never invent one: it would add a
  // black edge to solid text. A `.inner { visibility: hidden }` outline layer is
  // skipped for the same reason.
  let strokeColor = 'transparent';
  let strokeWidth = 0;
  const strokeRaw = declOf(inner, 'webkittextstroke', 'textstroke');
  if (hasVisibilityHidden(inner)) {
    if (strokeRaw) {
      notes.push('`.inner` 声明了 `-webkit-text-stroke` 但带 `visibility: hidden`'
        + '（描边层被隐藏），已按**无描边**处理。');
    }
  } else if (strokeRaw) {
    const m = /^([\d.]+)\s*(px|em)?\s+(.+)$/.exec(String(strokeRaw).trim());
    if (m) {
      strokeWidth = m[2] === 'em'
        ? rnd(parseFloat(m[1]) * fontSize) // `fontSize` is already rescaled
        : rnd(parseFloat(m[1]) * STAGE_SCALE);
      strokeColor = rgbOnly(parseColor(m[3], '#000000'));
    }
  }

  // ── Shadow ──
  const shadow = parseTextShadow(declOf(inner, 'textshadow') || declOf(outerName, 'textshadow'));
  // The nameplate carries its own shadow: the engine's speaker layer has a
  // separate `dropShadow` group, and templates routinely give `.inner` and
  // `.outerName` different values. Parsed here, resolved once the nameplate font
  // size is known.
  const nameShadow = parseTextShadow(declOf(outerName, 'textshadow') || declOf(name, 'textshadow'));

  // ── Nameplate ──
  const nameOuter = lookup(blocks, '.outerName');
  let nameColor = rgbOnly(parseColor(name.color, '#FFFFFF'));
  const nameClip = declOf(nameOuter, 'webkitbackgroundclip', 'backgroundclip');
  let nameOuterPaint = parsePaint(declOf(nameOuter, 'background', 'backgroundcolor'));
  if (!nameOuterPaint) nameOuterPaint = parsePaint(declOf(nameOuter, 'backgroundimage'));
  if (nameOuterPaint && nameClip && /text/i.test(nameClip)) {
    nameColor = paintColor(nameOuterPaint, nameColor);
    notes.push(`名牌文字色取自 \`.outerName\` 的 \`background-clip:text\` → \`${nameColor}\`。`);
  }

  // The nameplate font size has two stacked pitfalls:
  //  1. `.TextBox_showName`'s `%` / `em` resolve against its **parent**
  //     (`.TextBox_main`), not the root, so a template with
  //     `.TextBox_main { font-size: 30px }` would have its `100%` read as 20px.
  //  2. WebGAL puts an inline `font-size: 200%` on **both** nameplate divs, and
  //     an inline style outranks a template rule — only `!important` wins. A
  //     nameplate without `!important` therefore renders at twice its parent.
  let mainFontSize = resolveLength(main.fontsize, ROOT_FONT_PX);
  const mainFontSizeDeclared = main.fontsize != null;
  if (mainFontSize == null) mainFontSize = ROOT_FONT_PX;
  const nameFontSizeRaw = declOf(name, 'fontsize');
  let nameSize: number | null;
  if (nameFontSizeRaw != null && /!\s*important/i.test(String(nameFontSizeRaw))) {
    nameSize = resolveLength(nameFontSizeRaw, mainFontSize, mainFontSizeDeclared);
  } else if (mainFontSizeDeclared) {
    nameSize = rnd(mainFontSize * 2);
  } else {
    nameSize = resolveLength(nameFontSizeRaw, mainFontSize, mainFontSizeDeclared);
  }
  if (nameSize == null) nameSize = rnd(fontSize * 0.98);
  // Same reason as the body size: the nameplate inherits the parent's number,
  // so a negative `font-size` would otherwise reach the geometry and the
  // nine-slice with it.
  if (!Number.isFinite(nameSize) || nameSize <= 0) nameSize = rnd(fontSize * 0.98) || 1;

  let nameLineHeight = resolveLength(name.lineheight, nameSize, true);
  if (nameLineHeight == null) nameLineHeight = rnd(nameSize * 1.6);
  const nameTop = resolveLength(name.top, ROOT_FONT_PX, false, STAGE_HEIGHT) ?? -60;
  const nameLeft = resolveLength(name.left, ROOT_FONT_PX, false, STAGE_WIDTH) ?? 20;
  let nameboxX = boxX + nameLeft;
  let nameboxY = boxY + nameTop;

  // The height must be a positive finite number: a zero would make the whole
  // template package invalid. Templates that rely on `line-height` set
  // `height: 0px`, so fall back to the line height.
  let nameH = firstLength(declOf(name, 'height'), nameSize, true, STAGE_HEIGHT);
  if (nameH == null || nameH <= 0) {
    nameH = firstLength(declOf(name, 'minheight'), nameSize, true, STAGE_HEIGHT);
  }
  if (nameH == null || nameH <= 0) nameH = Math.max(nameLineHeight, rnd(nameSize * 1.9));
  if (!(nameH > 0)) nameH = Math.max(1, rnd(nameSize * 1.9));

  const namePads = sidesWithLonghand(name, nameSize, true, STAGE_WIDTH);
  if (!name.padding && !name.paddingleft && !name.paddingright) {
    namePads.l = rnd(nameSize * 1.5);
    namePads.r = namePads.l;
  }
  let namePadL = Math.max(0, namePads.l);
  let namePadR = Math.max(0, namePads.r);

  // The engine's speaker padding order is `[left, top, right, bottom]`, which is
  // **not** the CSS shorthand order.
  let speakerPadding: [number, number, number, number] = [
    namePadL, Math.max(0, namePads.t), namePadR, Math.max(0, namePads.b),
  ];

  // `min-width` acts as a floor; the engine takes the wider of it and the
  // measured label. `width` is required by the schema. Note that `min-width:
  // 25%` resolves against the containing block, not the font size.
  let nameMinW = resolveWidthLike(declOf(name, 'minwidth'), nameSize, boxW);
  if (nameMinW == null) nameMinW = resolveWidthLike(declOf(name, 'width'), nameSize, boxW);
  if (nameMinW == null) nameMinW = rnd(namePadL + namePadR + nameSize * 2);
  nameMinW = Math.max(nameMinW, namePadL + namePadR + nameSize, 40);

  const family = options.fontFamily
    || (declOf(main, 'fontfamily') || declOf(textBlock, 'fontfamily') || 'sans-serif')
      .split(',')[0].trim().replace(/^["']|["']$/g, '');
  const fontFile = options.fontFile || null;

  const align = resolveTextAlignment(main, textBlock);
  const nameBackground = lookup(blocks, '.TextBox_ShowName_Background');
  const nameAlign = resolveNameAlignment(name, nameBackground);

  // ── `transform: scale()` ──
  const transform = parseScale(main.transform);

  const theme = extractWebGalTextBoxTheme(blocks);

  // `var` in the original: these stay undefined when the template has no
  // transform, and the later shadow maths relies on that (a missing factor is
  // treated as 1 rather than throwing).
  let uniformScale: number | undefined;
  let axisScaleY: number | undefined;

  if (transform) {
    // `transform-origin` defaults to 50% 50%, so scale about the centre of the
    // **unscaled** box.
    const sx = transform.sx;
    const sy = transform.sy;
    const originX = boxX + boxW / 2;
    const originY = boxY + boxH / 2;
    const scaleX = (p: number): number => rnd(originX + (p - originX) * sx);
    const scaleY = (p: number): number => rnd(originY + (p - originY) * sy);
    const scaleW = (w: number): number => Math.max(1, rnd(w * sx));
    const scaleH = (h: number): number => Math.max(1, rnd(h * sy));
    uniformScale = Math.min(sx, sy); // fonts and radii take the smaller factor
    axisScaleY = sy;

    const previousTextX = textX;
    const previousTextY = textY;
    const previousTextW = textW;
    const previousNameX = nameboxX;
    const previousNameY = nameboxY;

    boxX = scaleX(boxX);
    boxY = scaleY(boxY);
    boxW = scaleW(boxW);
    boxH = scaleH(boxH);
    pads.l = rnd(pads.l * sx);
    pads.r = rnd(pads.r * sx);
    pads.t = rnd(pads.t * sy);
    pads.b = rnd(pads.b * sy);
    textX = scaleX(previousTextX);
    textY = scaleY(previousTextY);
    textW = scaleW(previousTextW);

    fontSize = Math.max(1, rnd(fontSize * uniformScale));
    lineHeight = Math.max(fontSize, rnd(lineHeight * sy));
    if (strokeWidth > 0) strokeWidth = Math.max(1, rnd(strokeWidth * uniformScale));

    nameSize = Math.max(1, rnd(nameSize * uniformScale));
    nameLineHeight = Math.max(nameSize, rnd(nameLineHeight * sy));
    nameH = Math.max(1, rnd(nameH * sy));
    namePads.l = rnd(namePads.l * sx);
    namePads.r = rnd(namePads.r * sx);
    namePads.t = rnd(namePads.t * sy);
    namePads.b = rnd(namePads.b * sy);
    namePadL = Math.max(0, namePads.l);
    namePadR = Math.max(0, namePads.r);
    speakerPadding = [namePadL, Math.max(0, namePads.t), namePadR, Math.max(0, namePads.b)];
    nameMinW = Math.max(40, Math.max(rnd(nameMinW * sx), namePadL + namePadR + nameSize));
    nameboxX = scaleX(previousNameX);
    nameboxY = scaleY(previousNameY);

    scaleTheme(theme, sx, sy);

    notes.push(`**已折算模板的 \`transform: scale(${sx}${sy !== sx ? `, ${sy}` : ''})\`**：`
      + 'WebGAL 靠这层整体缩放定尺寸，引擎没有 transform 概念，'
      + '逐项折算后对话框位置、大小、字号、圆角才与网页端一致。');
  }

  // ── Nine-slice slices ──
  // The artwork is drawn 1:1 with what the engine renders, so the fixed slices
  // must not overlap the derived radii.
  //
  // Everything below is clamped at the source rather than at the exit: a
  // negative radius (`border-radius: -50px`, which CSS discards as invalid) must
  // not reach the artwork, the notes or the parameters — `PIXI.NineSlicePlane`
  // takes these four numbers unclamped, and a negative inset makes it collapse.
  const clampRadius = (value: number): number => Math.max(0, Number.isFinite(value) ? value : 0);
  const textboxRadius = Math.min(
    clampRadius(theme.textbox.radius),
    clampRadius(Math.floor(Math.min(boxW, boxH) / 2)),
  );
  const textboxBorder = Math.max(0, theme.textbox.border.width || 0);
  let textboxPad = clampRadius(Math.min(textboxRadius + textboxBorder + 4, Math.floor(Math.min(boxW, boxH) / 3)));
  const textboxDeco = theme.textbox.deco;
  let textboxRightSlice = textboxPad;
  let textboxBottomSlice = textboxPad;
  if (textboxDeco) {
    textboxRightSlice = Math.max(textboxRightSlice, Math.min(480, (textboxDeco.size || 0) + 8));
    textboxBottomSlice = Math.max(textboxBottomSlice, Math.min(480, (textboxDeco.size || 0) + 8));
  }
  textboxPad = Math.min(textboxPad, Math.floor(boxW / 3));
  textboxRightSlice = Math.min(textboxRightSlice, Math.floor(boxW / 3));
  textboxBottomSlice = Math.min(textboxBottomSlice, Math.floor(boxH / 3));

  const nameboxRadiusCss = clampRadius(theme.namebox.radius);
  // `border-radius: 9999px` means a pill, i.e. half the height.
  const nameboxRadius = nameboxRadiusCss >= 1000
    ? Math.floor(nameH / 2)
    : Math.min(nameboxRadiusCss, clampRadius(Math.floor(nameH / 2)));
  const nameboxBorder = Math.max(0, theme.namebox.border.width || 0);
  const nameboxPadSlice = clampRadius(
    Math.min(nameboxRadius + nameboxBorder + 4, Math.floor(nameH / 2)),
  );
  const nameboxDeco = theme.namebox.deco;
  let nameboxRightSlice = nameboxPadSlice;
  if (nameboxDeco) {
    nameboxRightSlice = Math.max(nameboxRightSlice, Math.min(nameMinW / 3, (nameboxDeco.size || 0) + 8));
  }
  const nameboxVerticalSlice = Math.max(0, Math.min(Math.floor(nameH / 3), 24));

  // A downward `box-shadow` is painted outside the element and takes no layout
  // space, but the artwork has a fixed canvas, so reserve the offset or the
  // shadow is clipped. Artwork height = box height + dy.
  const textboxShadowDy = (theme.textbox.shadow && theme.textbox.shadow.dy > 0)
    ? Math.max(1, Math.round(theme.textbox.shadow.dy))
    : 0;
  const textboxTextureH = boxH + textboxShadowDy;

  const assetGeom: WebGalTextBoxAssetGeometry = {
    textbox: {
      width: boxW,
      height: textboxTextureH,
      nineSlice: [textboxPad, textboxPad, textboxRightSlice, textboxBottomSlice],
    },
    namebox: {
      width: nameMinW,
      height: nameH,
      nineSlice: [nameboxPadSlice, nameboxVerticalSlice, nameboxRightSlice, nameboxVerticalSlice],
    },
  };

  notes.push(`**文本框高度**：框体 \`${boxH}px\``
    + (textboxShadowDy ? ` + 阴影预留 \`${textboxShadowDy}px\` = 贴图 \`${textboxTextureH}px\`` : '')
    + `。引擎此时会**保持底边不动、向上生长**（等价 WebGAL 的 \`bottom:${bottom}px\`），`
    + '所以长台词不会溢出屏幕下沿。');

  const text: DialogueImageTextStyle = {
    fontFamily: family,
    fontSize,
    fontWeight: /^(bold|bolder|[6-9]00)$/.test(String(declOf(main, 'fontweight') || 'bold').trim())
      ? '700' : '400',
    color: textColor,
    x: textX,
    y: textY,
    maxWidth: textW,
    lineHeight,
    align,
    strokeColor,
    strokeWidth,
  };

  // `.TextBox_showName` rarely declares `font-weight`, so it inherits
  // `.TextBox_main`'s `normal` and should read as 400; falling back to 700 for a
  // missing declaration bolded every nameplate.
  const speaker: DialogueImageSpeakerStyle = {
    fontFamily: family,
    fontSize: nameSize,
    fontWeight: /^(bold|bolder|[6-9]00)$/.test(
      String(name.fontweight || main.fontweight || '').trim().toLowerCase(),
    ) ? '700' : '400',
    color: nameColor,
    align: nameAlign,
    padding: speakerPadding,
  };

  if (fontFile) {
    text.fontFile = fontFile;
    speaker.fontFile = fontFile;
  }
  Object.assign(text, toDropShadow(shadow, fontSize, uniformScale, axisScaleY));
  if (shadow.has) {
    notes.push('多条 `text-shadow` 已归并为单个 `dropShadow`（按不透明度取主层：'
      + `blur=${text.dropShadowBlur}、distance=${text.dropShadowDistance}）。`
      + '引擎不支持多重阴影，四向对称辉光会以单层近似。');
  }

  // ── Nameplate outline (`.innerName`'s `-webkit-text-stroke`) ──
  const innerName = lookup(blocks, '.innerName');
  const nameStrokeRaw = declOf(innerName, 'webkittextstroke', 'textstroke');
  if (nameStrokeRaw && !hasVisibilityHidden(innerName)) {
    const m = /^([\d.]+)\s*(px|em)?\s+(.+)$/.exec(String(nameStrokeRaw).trim());
    if (m) {
      // `nameSize` already carries the transform's uniform scale, so `em` must
      // not fold it in a second time; `px` is a raw WebGAL length that still
      // needs both the stage scale and that same transform scale — the same
      // split the body outline uses. A zero width stays zero rather than being
      // rounded up to a visible outline.
      const raw_width = m[2] === 'em'
        ? parseFloat(m[1]) * nameSize
        : parseFloat(m[1]) * STAGE_SCALE * (uniformScale || 1);
      const width = raw_width > 0 ? Math.max(1, rnd(raw_width)) : 0;
      speaker.strokeColor = rgbOnly(parseColor(m[3], '#000000'));
      speaker.strokeWidth = width;
      notes.push(`**名牌文字描边**：\`speaker.strokeColor=${speaker.strokeColor}\` / `
        + `\`strokeWidth=${width}\` ← \`.innerName\` 的 \`-webkit-text-stroke\`。`);
    }
  }

  // ── Nameplate shadow (`.outerName`'s `text-shadow`) ──
  if (nameShadow.has) {
    const nameDrop = toDropShadow(nameShadow, nameSize, uniformScale, axisScaleY);
    Object.assign(speaker, nameDrop);
    notes.push('**名牌文字阴影**：`speaker.dropShadow` ← `.outerName` 的 `text-shadow`'
      + `（blur=${nameDrop.dropShadowBlur}、alpha=${nameDrop.dropShadowAlpha}、`
      + `distance=${nameDrop.dropShadowDistance}）。`);
  }

  // ── Report ──
  notes.push(`**字号**：\`text.fontSize=${fontSize}\`（模板 \``
    + `${declOf(textBlock, 'fontsize') || main.fontsize || '-'}\` × WebGAL 根字号 `
    + `${ROOT_FONT_PX}px）；\`speaker.fontSize=${nameSize}\`。`);
  notes.push(`**名牌几何**：\`x=${nameboxX}, y=${nameboxY}`
    + `, width=${nameMinW}(下限), minHeight=${nameH}\``
    + `；\`speaker.padding=[left, top, right, bottom]=[${speakerPadding.join(', ')}]\``
    + '（引擎顺序，非 CSS 顺序）。');
  notes.push(`**名牌文字对齐**：\`speaker.align=${nameAlign}\`——WebGAL 的 `
    + '`.TextBox_showName` 内文字默认**左对齐**，左留白由 `padding-left` 给出；'
    + '引擎会把名字居中（短名字尤其明显），故显式输出该字段。');
  notes.push(`**底色已随素材生成**：对话框 \`${describePaint(theme.textbox.fill)}\``
    + `+\`${theme.textbox.border.width || 0}px `
    + `${theme.textbox.border.color ? rgbOnly(theme.textbox.border.color) : '无'}\``
    + `，圆角 ${textboxRadius}px；名牌 \`${describePaint(theme.namebox.fill)}\`+\``
    + `${theme.namebox.border.width || 0}px `
    + `${theme.namebox.border.color ? rgbOnly(theme.namebox.border.color) : '无'}\``
    + `，圆角 ${nameboxRadiusCss >= 1000 ? '胶囊' : `${nameboxRadius}px`}\`。`
    + '素材文件在包内 `assets/ui/dialogue/webgal/`。');
  if (textboxDeco || nameboxDeco) {
    notes.push('**角落装饰**：模板的 `::after` 引用了 `'
      + [textboxDeco && textboxDeco.file, nameboxDeco && nameboxDeco.file].filter(Boolean).join('` / `')
      + '`。它们会被内联进生成的贴图，并裁切到圆角框内 —— 模板用负偏移让装饰只露出一角，'
      + 'WebGAL 靠父元素的 `overflow: hidden` 遮挡，引擎没有这一层，故按同样的范围裁剪。');
  }
  notes.push('**入场动画无法迁移**：引擎 `textbox`/`namebox`/`text` 三个图层的参数白名单里'
    + '**没有任何动画字段**，模板的 `@keyframes` 淡入与逐字显示无法在样式层面还原，需引擎侧新增能力。');
  if (!fontFile) {
    notes.push('模板未声明字体（WebGAL 的字体写在 `template.json`，不在 scss 里）。'
      + '导入器会尝试读取同级 `template.json` 的 `fonts` 并复制到项目 `fonts/`。');
  }

  const style: WebGalDialogueStyle = {
    id: `webgal-${String(sourceName).replace(/\.scss$/i, '').replace(/[^\w-]+/g, '-').toLowerCase()}`,
    name: `WebGAL ${sourceName.replace(/\.scss$/i, '')}`,
    renderer: 'image-dialogue-v1',
    params: {
      textbox: {
        image: `${PANEL_IMAGE_DIR}textbox.svg`,
        nineSlice: assetGeom.textbox.nineSlice,
        x: boxX,
        y: boxY,
        width: boxW,
        height: textboxTextureH,
        opacity: 1,
      },
      namebox: {
        image: `${PANEL_IMAGE_DIR}namebox.svg`,
        nineSlice: assetGeom.namebox.nineSlice,
        x: nameboxX,
        y: nameboxY,
        width: nameMinW,
        minHeight: nameH,
      },
      text,
      speaker,
    },
  };

  return { style, notes, theme, assetGeom };
}

/** Convenience re-export so callers can reuse the resolved scale without parsing twice. */
export type { ScaleInfo, BoxSides };
