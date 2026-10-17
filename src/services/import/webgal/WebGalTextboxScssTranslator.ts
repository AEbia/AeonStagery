/**
 * Convert a WebGAL dialogue template's `textbox.scss` into
 * `image-dialogue-v1` presentation parameters.
 *
 * CSS semantics are computed by WebGalComputedStyle. This module maps those
 * values to the engine's three layers and records approximations (gradient
 * text, single shadow, auto height, framing). A single final affine pass folds
 * the main transform into geometry, typography and panel artwork.
 */
import type {
  DialogueImagePresentation,
  DialogueImageSpeakerStyle,
  DialogueImageTextStyle,
  DialogueNineSlice,
} from '../../../api/types/semantic-scene';
import {
  alphaOf, cssLength, paintColor, rgbOnly, rnd, STAGE_SCALE, STAGE_HEIGHT, STAGE_WIDTH,
  type BorderInfo, type BoxShadowInfo, type BoxSides, type Paint,
  type ScssBlocks, type ScaleInfo, type TextShadowInfo,
} from './WebGalScssSyntax';
import {
  computeWebGalTextboxStyle, computeWebGalTextboxBlocks,
  type WebGalComputedStyle, type WebGalComputedElement,
} from './WebGalComputedStyle';

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
  /** Body rectangle inside an expanded artwork canvas. */
  content?: { x: number; y: number; width: number; height: number };
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

/** Compatibility entry; painting consumes computed values through the same seam. */
export function extractWebGalTextBoxTheme(blocks: ScssBlocks): WebGalTextBoxTheme {
  return themeFromComputedStyle(computeWebGalTextboxBlocks(blocks));
}

function themeFromComputedStyle(computed: WebGalComputedStyle): WebGalTextBoxTheme {
  const { main, background: bg, name, nameBackground: nameBg, backgroundAfter: bgAfter, nameAfter } = computed;
  const hiddenPanel = (): WebGalPanelTheme => ({
    fill: { kind: 'solid', color: '#00000000' },
    border: { width: 0, color: null }, radius: 0, shadow: null, deco: null,
  });
  const textbox: WebGalPanelTheme = main.hidden || bg.hidden ? hiddenPanel() : {
    fill: bg.background ?? main.background ?? { kind: 'solid', color: '#00000000' },
    border: { ...(bg.hasBorder ? bg.border : main.border) },
    radius: bg.hasRadius ? bg.radius : main.radius,
    shadow: structuredClone(bg.hasBoxShadow ? bg.boxShadow : main.boxShadow),
    deco: bgAfter.imageFile ? {
      file: bgAfter.imageFile, size: bgAfter.decorationSize ?? rnd(120 * STAGE_SCALE),
      opacity: bgAfter.opacity, rotate: bgAfter.rotation,
      right: bgAfter.lengths.right ?? 0, bottom: bgAfter.lengths.bottom ?? 0,
    } : null,
  };
  // The visible label paints its own box even when the separate backdrop is
  // display:none. Body-panel transparency says nothing about that paint.
  const backdrop = nameBg.hidden ? name : nameBg;
  const labelHasFill = name.background != null
    && (name.background.kind !== 'solid' || alphaOf(name.background.color) > 0);
  const labelHasVisibleBorder = name.border.width > 0 && alphaOf(name.border.color) > 0;
  const namebox: WebGalPanelTheme = main.hidden ? hiddenPanel() : {
    fill: (labelHasFill ? name.background : backdrop.background) ?? { kind: 'solid', color: '#00000000' },
    // A transparent foreground border doesn't erase its sibling's border.
    border: { ...(labelHasVisibleBorder ? name.border : backdrop.border) },
    radius: name.hasRadius ? name.radius : backdrop.radius,
    shadow: structuredClone(name.hasBoxShadow ? name.boxShadow : backdrop.boxShadow),
    deco: !nameBg.hidden && nameAfter.imageFile ? {
      file: nameAfter.imageFile, size: nameAfter.decorationSize ?? 0,
      opacity: nameAfter.opacity, rotate: nameAfter.rotation,
      right: nameAfter.lengths.right ?? 0, bottom: nameAfter.lengths.bottom ?? 0,
    } : null,
  };
  return { textbox, namebox };
}

/**
 * Scale the theme's pixel quantities to match a template's `transform`.
 *
 * Radii and blur use the smaller factor so non-uniform scaling never stretches
 * them; offsets follow their own axis.
 */
function scaleTheme(theme: WebGalTextBoxTheme, sx: number, sy: number,
  slots: readonly ('textbox' | 'namebox')[] = ['textbox', 'namebox']): void {
  const uniform = Math.min(sx, sy);
  for (const slot of slots) {
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
  shadow: TextShadowInfo | null,
  sx: number,
  sy: number,
): Partial<DialogueImageTextStyle> {
  if (!shadow?.has) return {};
  const dx = shadow.offsetX * sx;
  const dy = shadow.distance * sy;
  return {
    dropShadow: true,
    dropShadowColor: shadow.color,
    dropShadowAlpha: rnd(shadow.alpha * 1000) / 1000,
    dropShadowBlur: Math.max(0, rnd(shadow.blur * Math.min(sx, sy))),
    // A symmetric group must lose its offset: the engine's drop shadow only
    // points one way, so keeping it turns an even glow into a corner smudge.
    dropShadowDistance: shadow.symmetric ? 0 : rnd(Math.hypot(dx, dy)),
    ...(!shadow.symmetric ? { dropShadowAngle: Math.atan2(dy, dx) } : {}),
  };
}

/** Resolve an element's transform origin in its unscaled border box. */
function origin(element: WebGalComputedElement, width: number, height: number): [number, number] {
  return [
    cssLength(element.transformOrigin[0], element.fontSize, width) ?? width / 2,
    cssLength(element.transformOrigin[1], element.fontSize, height) ?? height / 2,
  ];
}

/** Reserve the full visible box-shadow bounds around the nameplate body. */
function nameboxShadowInsets(shadow: BoxShadowInfo | null): [left: number, top: number, right: number, bottom: number] {
  if (!shadow) return [0, 0, 0, 0];
  // The SVG uses stdDeviation = CSS blur / 2; three standard deviations cover
  // the rendered blur while leaving a small antialiasing margin after rounding.
  const extent = shadow.spread + Math.max(0, shadow.blur) * 1.5;
  return [
    Math.max(0, Math.ceil(extent - shadow.dx)),
    Math.max(0, Math.ceil(extent - shadow.dy)),
    Math.max(0, Math.ceil(extent + shadow.dx)),
    Math.max(0, Math.ceil(extent + shadow.dy)),
  ];
}

/**
 * Translate a WebGAL `textbox.scss` into an `image-dialogue-v1` dialogue style.
 */
export function translateWebGalTextboxScss(
  css: string,
  options: WebGalScssTranslationOptions = {},
): WebGalScssTranslation {
  return mapWebGalTextboxStyle(computeWebGalTextboxStyle(css), options);
}

/** Engine mapping seam: consumes computed values, never raw declarations. */
export function mapWebGalTextboxStyle(
  computed: WebGalComputedStyle,
  options: WebGalScssTranslationOptions = {},
): WebGalScssTranslation {
  const sourceName = options.sourceName || 'textbox.scss';
  const strictCenter = options.strictCenter === true;
  const notes = [...computed.diagnostics];
  const { main, text: textBlock, outer, inner, name, outerName, innerName } = computed;
  // Visible layers inherit wrapper typography, then apply their own overrides.
  let fontSize = Math.max(1, outer.fontSize);
  let lineHeight = Math.max(fontSize, outer.lineHeight);

  // ── Layout ──
  // Engine geometry: `o = max(textbox.height, inset + textHeight + inset)` with
  // `textbox.height` pinned to the authored height, so supplying `height` keeps
  // the bottom edge fixed and grows upward — the equivalent of WebGAL's
  // `bottom: <n>px`. Supplying only `minHeight` would grow downward instead.
  // `left` / `right` percentages resolve against the containing block's width,
  // `bottom` against its height — never against a font size. The stage and the
  // WebGAL canvas are both 3:4, so a percentage of either lands on the same
  // stage pixel and the basis is used unscaled.
  let left = main.lengths.left;
  if (left == null) left = rnd(50 * STAGE_SCALE);
  let right = main.lengths.right;
  if (right == null) right = rnd(25 * STAGE_SCALE);
  let bottom = main.lengths.bottom;
  if (bottom == null) bottom = rnd(40 * STAGE_SCALE);
  let boxX = left;
  let boxW = Math.max(320, main.lengths.width ?? STAGE_WIDTH - left - right);

  // CSS resolves every percentage padding against the containing block *width*,
  // including the top and bottom ones.
  const pads = { ...main.padding };
  if (!main.hasPadding) {
    pads.t = rnd(fontSize * 0.4);
    pads.b = pads.t;
    pads.l = rnd(fontSize * 0.7);
    pads.r = pads.l;
    notes.push('主容器未声明内边距，已根据正文字号估算默认留白。');
  }

  if (strictCenter) {
    const maxW = Math.min(boxW, STAGE_WIDTH - pads.l - pads.r);
    boxW = maxW;
    boxX = Math.round((STAGE_WIDTH - maxW) / 2);
  }

  let boxH = main.lengths.height;
  if (boxH == null) boxH = main.lengths.minheight;
  const autoHeight = (boxH == null || boxH <= 0);
  // Tested inline rather than through `autoHeight` so the value is narrowed to a
  // number for the geometry maths below.
  if (boxH == null || boxH <= 0) boxH = Math.max(lineHeight + pads.t + pads.b, rnd(fontSize * 2));
  let boxY = Math.max(0, STAGE_HEIGHT - bottom - boxH);

  let textX = boxX + pads.l;
  let textW = Math.max(1, boxW - pads.l - pads.r);
  let textY = boxY + pads.t;
  const absoluteText = textBlock.position === 'absolute';
  const textLeft = absoluteText ? textBlock.lengths.left : null;
  const textRight = absoluteText ? textBlock.lengths.right : null;
  const textTop = absoluteText ? textBlock.lengths.top : null;
  const textInsetL = textBlock.padding.l + textBlock.border.width;
  const textInsetR = textBlock.padding.r + textBlock.border.width;
  const explicitTextW = textBlock.lengths.width;
  // Resolve the content width before alignment. Absolute insets constrain an
  // auto-sized box; relative insets only move its already laid-out border box.
  textW = Math.max(1, explicitTextW == null
    ? textW - (textLeft ?? 0) - (textRight ?? 0)
      - textBlock.margin.l - textBlock.margin.r - textInsetL - textInsetR
    : explicitTextW - (textBlock.boxSizing === 'border-box' ? textInsetL + textInsetR : 0));
  textX += (textLeft ?? 0) + textBlock.margin.l + textInsetL;
  textY += (textTop ?? 0) + textBlock.margin.t + textBlock.padding.t;
  if (textBlock.lengths.width != null && textLeft == null && textRight == null && main.flexAlign === 'center') {
    textX = boxX + pads.l
      + (boxW - pads.l - pads.r - textW - textInsetL - textInsetR
        - textBlock.margin.l - textBlock.margin.r) / 2
      + textBlock.margin.l + textInsetL;
  } else if (textRight != null && textLeft == null && textBlock.lengths.width != null) {
    textX = boxX + boxW - pads.r - textRight - textBlock.margin.r - textW - textInsetR;
  }
  if (textBlock.position === 'relative') {
    textX += textBlock.lengths.left ?? -(textBlock.lengths.right ?? 0);
    textY += textBlock.lengths.top ?? -(textBlock.lengths.bottom ?? 0);
  }
  textX = rnd(textX);
  let bodySx = textBlock.scale?.sx ?? 1;
  let bodySy = textBlock.scale?.sy ?? 1;
  const bodyUniform = Math.min(bodySx, bodySy);
  if (textBlock.scale) {
    const [ox, oy] = origin(textBlock, textW, textBlock.lengths.height ?? lineHeight);
    textX = rnd(textX + ox * (1 - bodySx));
    textY = rnd(textY + oy * (1 - bodySy));
    textW = Math.max(1, rnd(textW * bodySx));
    fontSize = Math.max(1, rnd(fontSize * bodyUniform));
    lineHeight = Math.max(fontSize, rnd(lineHeight * bodySy));
    notes.push('已将 `.text` 的独立缩放与 transform-origin 折算到正文位置、宽度和字形。');
  }

  const centerOffset = (boxX + boxW / 2) - (STAGE_WIDTH / 2);
  if (strictCenter) {
    notes.push('已启用**严格居中**（`strictCenter`）：文本区水平居中对齐画布中心（960px）。');
  } else if (Math.abs(centerOffset) > 0.5) {
    notes.push(`**水平偏心 ${centerOffset}px**：模板左右边距不对称`
      + `（\`left:${left}\` 与 \`right:${right}\`），已按设计保留水平偏移；`
      + '如需居中，可在导入时启用 `strictCenter`。');
  }

  if (autoHeight) {
    notes.push('模板未声明固定高度，文本框高度已根据行高与内边距自动估算；如需微调可调整 `textbox.height`。');
  }

  // ── Body text colour ──
  // The standard WebGAL idiom is `.outer { color: transparent; background: <c>;
  // background-clip: text }` — the visible colour comes from the background
  // gradient, not from `color`.
  const outerPaint = outer.background;

  let textColor: string | null = null;
  if (outerPaint && outer.backgroundClipText) {
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
      notes.push('**渐变裁切文字**：`.outer` 使用了 `background-clip: text`，'
        + `当前文本颜色仅支持纯色，已提取主色段颜色 \`${textColor}\`。`);
    } else {
      textColor = rgbOnly(outerPaint.color);
      notes.push(`**文字色取自 \`.outer\` 的 \`background-clip:text\`** → \`${textColor}\`。`);
    }
  }
  if (!textColor) {
    if (alphaOf(outer.color) > 0) textColor = rgbOnly(outer.color);
    else if (alphaOf(inner.color) > 0) textColor = rgbOnly(inner.color);
    else textColor = rgbOnly(textBlock.color);
  }

  // ── Outline ──
  // The engine defaults to `stroke = { color: 'transparent', width: 0 }`, so an
  // absent declaration means *no* outline. Never invent one: it would add a
  // black edge to solid text. A `.inner { visibility: hidden }` outline layer is
  // skipped for the same reason.
  let strokeColor = 'transparent';
  let strokeWidth = 0;
  if (inner.hidden) {
    if (inner.stroke.width > 0) notes.push('`.inner` 描边层设置为隐藏，已按无描边处理。');
  } else {
    strokeWidth = inner.stroke.width * bodyUniform;
    if (strokeWidth > 0) strokeColor = rgbOnly(inner.stroke.color);
  }

  const shadow = inner.hidden ? null : inner.textShadow;
  const nameShadow = outerName.hidden ? null : outerName.textShadow;

  // ── Nameplate ──
  let nameColor = rgbOnly(outerName.color);
  const nameOuterPaint = outerName.background;
  if (nameOuterPaint && outerName.backgroundClipText) {
    nameColor = paintColor(nameOuterPaint, nameColor);
    notes.push(`名牌文字色取自 \`.outerName\` 的 \`background-clip:text\` → \`${nameColor}\`。`);
  }

  let nameSize = Math.max(1, outerName.fontSize);
  let nameLineHeight = Math.max(nameSize, outerName.lineHeight);
  const nameTop = name.lengths.top ?? -60;
  const nameLeft = name.lengths.left ?? 20;
  let nameboxX = boxX + nameLeft;
  let nameboxY = boxY + nameTop;

  // The height must be a positive finite number: a zero would make the whole
  // template package invalid. Templates that rely on `line-height` set
  // `height: 0px`, so fall back to the line height.
  let nameH = name.lengths.height;
  if (nameH == null || nameH <= 0) {
    nameH = name.lengths.minheight;
  }
  if (nameH == null || nameH <= 0) nameH = Math.max(nameLineHeight, rnd(nameSize * 1.9));
  if (!(nameH > 0)) nameH = Math.max(1, rnd(nameSize * 1.9));

  const namePads = { ...name.padding };
  if (!name.hasPadding) {
    namePads.l = rnd(nameSize * 1.5);
    namePads.r = namePads.l;
    notes.push('姓名框未声明内边距，左右留白已按姓名字号的 1.5 倍估算。');
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
  let nameMinW = name.lengths.minwidth;
  if (nameMinW == null) nameMinW = name.lengths.width;
  if (nameMinW == null) nameMinW = rnd(namePadL + namePadR + nameSize * 2);
  nameMinW = Math.max(nameMinW, namePadL + namePadR + nameSize, 40);

  // Relative flex items keep their normal centered position before top/left
  // offsets. Keep an anchor in the presentation: the final name width is only
  // known after the renderer measures the actual speaker label.
  const centeredName = name.position !== 'absolute' && main.flexAlign === 'center';
  let nameAnchorX = centeredName ? 0.5 : 0;
  if (centeredName) nameboxX = boxX + pads.l + (boxW - pads.l - pads.r) / 2 + (name.lengths.left ?? 0);
  if (name.boxSizing !== 'border-box') {
    nameH += namePads.t + namePads.b + name.border.width * 2;
    nameMinW += name.border.width * 2;
  }
  const nameSx = name.scale?.sx ?? 1;
  const nameSy = name.scale?.sy ?? 1;
  const nameUniform = Math.min(nameSx, nameSy);
  if (name.scale) {
    const [ox, oy] = origin(name, nameMinW, nameH);
    // The border box may grow with the measured speaker label. Express the
    // width-dependent origin correction as an anchor on its scaled width:
    // left = x - unscaledWidth * anchor + origin * (1 - scale).
    const originFraction = name.transformOrigin[0].endsWith('%')
      ? (cssLength(name.transformOrigin[0], name.fontSize, 1) ?? 0.5) : 0;
    nameAnchorX = (nameAnchorX - originFraction * (1 - nameSx)) / nameSx;
    if (!name.transformOrigin[0].endsWith('%')) nameboxX += ox * (1 - nameSx);
    nameboxY = rnd(nameboxY + oy * (1 - nameSy));
    nameMinW = Math.max(1, rnd(nameMinW * nameSx));
    nameH = Math.max(1, rnd(nameH * nameSy));
    nameSize = Math.max(1, rnd(nameSize * nameUniform));
    nameLineHeight = Math.max(nameSize, rnd(nameLineHeight * nameSy));
    namePads.l = rnd(namePads.l * nameSx);
    namePads.r = rnd(namePads.r * nameSx);
    namePads.t = rnd(namePads.t * nameSy);
    namePads.b = rnd(namePads.b * nameSy);
    namePadL = Math.max(0, namePads.l);
    namePadR = Math.max(0, namePads.r);
    speakerPadding = [namePadL, namePads.t, namePadR, namePads.b];
    notes.push('已将 `.TextBox_showName` 的独立缩放折算到姓名框和姓名文字。');
  }

  // WebGAL themes commonly declare fonts on the visible overlay layers rather
  // than their `.text` / `.TextBox_showName` wrappers.
  const family = options.fontFamily || outer.fontFamily || textBlock.fontFamily;
  const nameFamily = options.fontFamily || outerName.fontFamily || name.fontFamily;
  const fontFile = options.fontFile || null;
  const align = textBlock.align ?? main.flexAlign ?? 'center';
  const nameAlign = name.align ?? 'left';
  const transform = computed.transform;
  const theme = themeFromComputedStyle(computed);
  scaleTheme(theme, nameSx, nameSy, ['namebox']);

  // `var` in the original: these stay undefined when the template has no
  // transform, and the later shadow maths relies on that (a missing factor is
  // treated as 1 rather than throwing).
  let uniformScale: number | undefined;

  if (transform) {
    // `transform-origin` defaults to 50% 50%, so scale about the centre of the
    // **unscaled** box.
    const sx = transform.sx;
    const sy = transform.sy;
    const [ox, oy] = origin(main, boxW, boxH);
    const originX = boxX + ox;
    const originY = boxY + oy;
    const scaleX = (p: number): number => rnd(originX + (p - originX) * sx);
    const scaleY = (p: number): number => rnd(originY + (p - originY) * sy);
    const scaleW = (w: number): number => Math.max(1, rnd(w * sx));
    const scaleH = (h: number): number => Math.max(1, rnd(h * sy));
    uniformScale = Math.min(sx, sy); // fonts and radii take the smaller factor
    bodySx *= sx;
    bodySy *= sy;

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
      + '已将缩放折算到对话框位置、尺寸、字号与圆角等具体属性。');
  }

  if (strokeWidth > 0) strokeWidth = Math.max(1, rnd(strokeWidth));

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
  const [nameboxShadowLeft, nameboxShadowTop, nameboxShadowRight, nameboxShadowBottom]
    = nameboxShadowInsets(theme.namebox.shadow);
  const nameboxTextureW = nameMinW + nameboxShadowLeft + nameboxShadowRight;
  const nameboxTextureH = nameH + nameboxShadowTop + nameboxShadowBottom;
  const nameboxContent = nameboxShadowLeft || nameboxShadowTop || nameboxShadowRight || nameboxShadowBottom
    ? { x: nameboxShadowLeft, y: nameboxShadowTop, width: nameMinW, height: nameH }
    : undefined;
  const nameboxCanvasX = rnd(nameboxX
    + nameAnchorX * (nameboxShadowLeft + nameboxShadowRight) - nameboxShadowLeft);
  const nameboxCanvasY = rnd(nameboxY - nameboxShadowTop);

  // A box shadow does not affect CSS layout. Keep the body's minHeight separate
  // from the larger artwork canvas used to avoid clipping its full shadow.
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
      width: nameboxTextureW,
      height: nameboxTextureH,
      nineSlice: [
        nameboxShadowLeft + nameboxPadSlice,
        nameboxShadowTop + nameboxVerticalSlice,
        nameboxShadowRight + nameboxRightSlice,
        nameboxShadowBottom + nameboxVerticalSlice,
      ],
      ...(nameboxContent ? { content: nameboxContent } : {}),
    },
  };

  notes.push(`**文本框高度**：框体 \`${boxH}px\``
    + (textboxShadowDy ? ` + 阴影预留 \`${textboxShadowDy}px\` = 贴图 \`${textboxTextureH}px\`` : '')
    + `；采用底边固定对齐（\`bottom: ${bottom}px\`），文本超出时向上扩展。`);

  const text: DialogueImageTextStyle = {
    fontFamily: family,
    fontSize,
    fontWeight: outer.fontWeight,
    color: textColor,
    x: textX,
    y: textY,
    maxWidth: textW,
    lineHeight,
    ...(outer.letterSpacing !== 0 ? { letterSpacing: rnd(outer.letterSpacing * bodySx) } : {}),
    align,
    strokeColor,
    strokeWidth,
    ...(main.hidden || textBlock.hidden ? { hidden: true } : {}),
  };

  // Each layer consumes its own computed typography, including inheritance.
  const speaker: DialogueImageSpeakerStyle = {
    fontFamily: nameFamily,
    fontSize: nameSize,
    fontWeight: outerName.fontWeight,
    color: nameColor,
    align: nameAlign,
    padding: [
      speakerPadding[0] + nameboxShadowLeft,
      speakerPadding[1] + nameboxShadowTop,
      speakerPadding[2] + nameboxShadowRight,
      speakerPadding[3] + nameboxShadowBottom,
    ],
    ...(outerName.letterSpacing !== 0 ? { letterSpacing: rnd(outerName.letterSpacing * nameSx * (transform?.sx ?? 1)) } : {}),
  };
  const speakerScaleX = nameSx * (transform?.sx ?? 1);
  const speakerScaleY = nameSy * (transform?.sy ?? 1);
  const speakerOffset: [number, number] = [
    rnd((outerName.lengths.left ?? 0) * speakerScaleX),
    rnd((outerName.lengths.top ?? 0) * speakerScaleY),
  ];
  if (speakerOffset.some((value) => value !== 0)) speaker.textOffset = speakerOffset;

  if (fontFile) {
    text.fontFile = fontFile;
    speaker.fontFile = fontFile;
  }
  Object.assign(text, toDropShadow(shadow, bodySx, bodySy));
  if (shadow?.has) {
    notes.push('多条 `text-shadow` 已合并为单层 `dropShadow`（按主要图层取：'
      + `blur=${text.dropShadowBlur}、distance=${text.dropShadowDistance}）；`
      + '对称辉光或多重阴影已按单层效果近似。');
  }

  // ── Nameplate outline (`.innerName`'s `-webkit-text-stroke`) ──
  if (innerName.hasStroke && !innerName.hidden) {
    const width = innerName.stroke.width > 0 ? Math.max(1, rnd(innerName.stroke.width * nameUniform * (uniformScale || 1))) : 0;
    speaker.strokeColor = rgbOnly(innerName.stroke.color);
    speaker.strokeWidth = width;
    notes.push(`**名牌文字描边**：\`speaker.strokeColor=${speaker.strokeColor}\`，`
      + `\`strokeWidth=${width}\`（对应 \`.innerName\` 的 \`-webkit-text-stroke\`）。`);
  }

  // ── Nameplate shadow (`.outerName`'s `text-shadow`) ──
  if (nameShadow?.has) {
    const nameDrop = toDropShadow(nameShadow, speakerScaleX, speakerScaleY);
    Object.assign(speaker, nameDrop);
    notes.push('**名牌文字阴影**：`speaker.dropShadow` 提取自 `.outerName` 的 `text-shadow`'
      + `（blur=${nameDrop.dropShadowBlur}、alpha=${nameDrop.dropShadowAlpha}、`
      + `distance=${nameDrop.dropShadowDistance}）。`);
  }
  // Some themes draw a second clipped glyph layer instead of text-shadow.
  // Its displacement is relative to the visible foreground, not the wrapper.
  if (!nameShadow?.has && !innerName.hidden && innerName.backgroundClipText && innerName.background) {
    const color = paintColor(innerName.background, innerName.color);
    const alpha = innerName.background.kind === 'solid' ? alphaOf(innerName.background.color) : 1;
    const dx = ((innerName.lengths.left ?? 0) - (outerName.lengths.left ?? 0)) * speakerScaleX;
    const dy = ((innerName.lengths.top ?? 0) - (outerName.lengths.top ?? 0)) * speakerScaleY;
    if (alpha > 0 && (dx !== 0 || dy !== 0)) {
      Object.assign(speaker, {
        dropShadow: true, dropShadowColor: rgbOnly(color), dropShadowAlpha: rnd(alpha * 1000) / 1000,
        dropShadowBlur: 0, dropShadowDistance: rnd(Math.hypot(dx, dy)), dropShadowAngle: Math.atan2(dy, dx),
      });
      notes.push('已将 `.innerName` 的错位裁切文字层转换为姓名文字阴影。');
    }
  }

  // ── Report ──
  notes.push(`**字号**：\`text.fontSize=${fontSize}\`，\`speaker.fontSize=${nameSize}\`（已按继承与层叠样式换算）。`);
  notes.push(`**名牌几何**：\`x=${nameboxX}, y=${nameboxY}`
    + `, width=${nameMinW}(下限), minHeight=${nameH}\``
    + `，\`speaker.padding=[${speakerPadding.join(', ')}]\`（left, top, right, bottom）。`);
  notes.push(`**名牌文字对齐**：\`speaker.align=${nameAlign}\`（保留左对齐与内边距配置）。`);
  notes.push(`**面板背景素材**：已生成对话框背景（${describePaint(theme.textbox.fill)}，`
    + `边框 ${theme.textbox.border.width || 0}px ${theme.textbox.border.color ? rgbOnly(theme.textbox.border.color) : '无'}，`
    + `圆角 ${textboxRadius}px）与名牌背景（${describePaint(theme.namebox.fill)}，`
    + `边框 ${theme.namebox.border.width || 0}px ${theme.namebox.border.color ? rgbOnly(theme.namebox.border.color) : '无'}，`
    + `圆角 ${nameboxRadiusCss >= 1000 ? '胶囊形' : `${nameboxRadius}px`}），`
    + '保存于 `assets/ui/dialogue/webgal/`。');
  if (textboxDeco || nameboxDeco) {
    notes.push('**角落装饰**：模板 `::after` 引用的装饰素材（`'
      + [textboxDeco && textboxDeco.file, nameboxDeco && nameboxDeco.file].filter(Boolean).join('` / `')
      + '`）已内联至背景贴图，并按圆角范围裁剪。');
  }
  notes.push('**入场动画无法迁移**：当前对话框样式仅支持静态展示，'
    + '模板中的 `@keyframes`（如淡入、逐字显示等动画）未导入。');
  if (!fontFile) {
    notes.push(`已保留字体族名称（正文：${family}；姓名：${nameFamily}），但模板未附带可复制的字体文件，显示效果取决于本机已安装字体。`);
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
        opacity: computed.background.opacity,
      },
      namebox: {
        image: `${PANEL_IMAGE_DIR}namebox.svg`,
        nineSlice: assetGeom.namebox.nineSlice,
        x: nameboxCanvasX,
        y: nameboxCanvasY,
        width: nameboxTextureW,
        ...(nameboxTextureH !== nameH ? { height: nameboxTextureH } : {}),
        minHeight: nameH,
        ...(nameAnchorX !== 0 ? { anchorX: nameAnchorX } : {}),
        ...((computed.nameBackground.hidden ? name.opacity : computed.nameBackground.opacity) !== 1
          ? { opacity: computed.nameBackground.hidden ? name.opacity : computed.nameBackground.opacity } : {}),
      },
      text,
      speaker,
    },
  };

  if (main.hidden || name.hidden) delete style.params.namebox;

  return { style, notes, theme, assetGeom };
}

/** Convenience re-export so callers can reuse the resolved scale without parsing twice. */
export type { ScaleInfo, BoxSides };
