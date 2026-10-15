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
  alphaOf, paintColor, rgbOnly, rnd, STAGE_SCALE, STAGE_HEIGHT, STAGE_WIDTH,
  SHADOW_BLUR_RATIO, SHADOW_DIST_RATIO,
  type BorderInfo, type BoxShadowInfo, type BoxSides, type Paint,
  type ScssBlocks, type ScaleInfo, type TextShadowInfo,
} from './WebGalScssSyntax';
import {
  computeWebGalTextboxStyle, computeWebGalTextboxBlocks,
  type WebGalComputedStyle,
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
  const textbox: WebGalPanelTheme = {
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
  // Mapping approximation: a shared showName fill shades glyphs in a frameless
  // template; only a dedicated backdrop fill should create a nameplate there.
  const boxIsTransparent = textbox.fill.kind === 'solid' && alphaOf(textbox.fill.color) < 0.004;
  const namebox: WebGalPanelTheme = {
    fill: !computed.nameBackgroundHasPaint && boxIsTransparent
      ? { kind: 'solid', color: '#00000000' }
      : nameBg.background ?? name.background ?? { kind: 'solid', color: '#FFFFFF' },
    border: { ...(nameBg.hasBorder ? nameBg.border : name.border) },
    radius: nameBg.hasRadius ? nameBg.radius : name.radius,
    shadow: structuredClone(nameBg.hasBoxShadow ? nameBg.boxShadow : name.boxShadow),
    deco: nameAfter.imageFile ? {
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
  shadow: TextShadowInfo,
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
      : Math.max(1, rnd(Math.max(shadow.blur * (uniformScale || 1), fontSize * SHADOW_BLUR_RATIO))),
    // A symmetric group must lose its offset: the engine's drop shadow only
    // points one way, so keeping it turns an even glow into a corner smudge.
    dropShadowDistance: shadow.symmetric ? 0 : Math.max(0, rnd(
      Math.max(Math.abs(shadow.distance) * (axisScale || 1), fontSize * SHADOW_DIST_RATIO),
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
  let fontSize = Math.max(1, textBlock.fontSize);
  let lineHeight = Math.max(fontSize, textBlock.lineHeight);

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
    notes.push('主容器未声明内边距；按正文大小估算面板留白。');
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
      notes.push('**渐变裁切文字**：`.outer` 用 `background-clip:text` 上色，'
        + `引擎 \`text.color\` 不支持渐变，已取占比最大的那一段色 \`${textColor}\`。`);
    } else {
      textColor = rgbOnly(outerPaint.color);
      notes.push(`**文字色取自 \`.outer\` 的 \`background-clip:text\`** → \`${textColor}\``
        + '（WebGAL 模板的常规写法；`.outer` 的 `color` 通常是 `transparent`，不能直接用）。');
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
    if (inner.stroke.width > 0) notes.push('`.inner` 描边层被隐藏，已按无描边处理。');
  } else {
    strokeWidth = inner.stroke.width;
    if (strokeWidth > 0) strokeColor = rgbOnly(inner.stroke.color);
  }

  const shadow = inner.textShadow;
  const nameShadow = outerName.textShadow;

  // ── Nameplate ──
  let nameColor = rgbOnly(outerName.color);
  const nameOuterPaint = outerName.background;
  if (nameOuterPaint && outerName.backgroundClipText) {
    nameColor = paintColor(nameOuterPaint, nameColor);
    notes.push(`名牌文字色取自 \`.outerName\` 的 \`background-clip:text\` → \`${nameColor}\`。`);
  }

  let nameSize = Math.max(1, name.fontSize);
  let nameLineHeight = Math.max(nameSize, name.lineHeight);
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
    notes.push('姓名框未声明内边距；左右留白按姓名字号的 1.5 倍估算。');
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

  const family = options.fontFamily || textBlock.fontFamily;
  const nameFamily = options.fontFamily || name.fontFamily;
  const fontFile = options.fontFile || null;
  const align = textBlock.align ?? main.flexAlign ?? 'center';
  const nameAlign = name.align ?? 'left';
  const transform = computed.transform;
  const theme = themeFromComputedStyle(computed);

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
    fontWeight: textBlock.fontWeight,
    color: textColor,
    x: textX,
    y: textY,
    maxWidth: textW,
    lineHeight,
    align,
    strokeColor,
    strokeWidth,
  };

  // Each layer consumes its own computed typography, including inheritance.
  const speaker: DialogueImageSpeakerStyle = {
    fontFamily: nameFamily,
    fontSize: nameSize,
    fontWeight: name.fontWeight,
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
  if (innerName.hasStroke && !innerName.hidden) {
    const width = innerName.stroke.width > 0 ? Math.max(1, rnd(innerName.stroke.width * (uniformScale || 1))) : 0;
    speaker.strokeColor = rgbOnly(innerName.stroke.color);
    speaker.strokeWidth = width;
    notes.push(`**名牌文字描边**：\`speaker.strokeColor=${speaker.strokeColor}\` / `
      + `\`strokeWidth=${width}\` ← \`.innerName\` 的 \`-webkit-text-stroke\`。`);
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
  notes.push(`**字号**：\`text.fontSize=${fontSize}\`；\`speaker.fontSize=${nameSize}\`（计算继承和 inline 优先级后换算）。`);
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
