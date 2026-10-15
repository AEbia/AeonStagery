/**
 * Compute the supported WebGAL textbox CSS subset before engine mapping.
 *
 * Rules retain ordered declarations. Shorthands expand before cascade;
 * inheritance copies computed values, never priority. All relative units are
 * evaluated in WebGAL pixels, then converted to engine pixels at this seam.
 * The translator needs no knowledge of inline priority or length bases.
 */
import {
  cascadeDeclarations, cssLength as length, expandDeclaration, isImportantDeclaration,
  parseBorder, parseBoxShadow, parsePaint, parseScale, parseScssRules,
  parseTextShadow, ROOT_FONT_PX, rnd, rulesOf, selectorSpecificity,
  STAGE_SCALE, stripComments, tryParseColor, urlBasename,
  WEBGAL_STAGE_HEIGHT, WEBGAL_STAGE_WIDTH,
  type BorderInfo, type BoxShadowInfo, type BoxSides, type Paint,
  type ScaleInfo, type ScssBlocks, type ScssDeclaration, type ScssRule,
  type TextShadowInfo,
} from './WebGalScssSyntax';

export type CssAlignment = 'left' | 'center' | 'right';
const LENGTHS = ['left', 'right', 'top', 'bottom', 'width', 'height', 'minwidth', 'minheight'] as const;
type LengthProperty = typeof LENGTHS[number];

/** All numeric lengths here are engine-stage pixels, before transform. */
export interface WebGalComputedElement {
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  fontWeight: '400' | '700';
  color: string;
  align: CssAlignment | null;
  flexAlign: CssAlignment | null;
  padding: BoxSides;
  hasPadding: boolean;
  lengths: Record<LengthProperty, number | null>;
  background: Paint | null;
  backgroundClipText: boolean;
  border: BorderInfo;
  hasBorder: boolean;
  radius: number;
  hasRadius: boolean;
  boxShadow: BoxShadowInfo | null;
  hasBoxShadow: boolean;
  textShadow: TextShadowInfo;
  stroke: { width: number; color: string };
  hasStroke: boolean;
  hidden: boolean;
  imageFile: string | null;
  decorationSize: number | null;
  opacity: number;
  rotation: number;
}

export interface WebGalComputedStyle {
  main: WebGalComputedElement;
  text: WebGalComputedElement;
  outer: WebGalComputedElement;
  inner: WebGalComputedElement;
  background: WebGalComputedElement;
  name: WebGalComputedElement;
  nameBackground: WebGalComputedElement;
  outerName: WebGalComputedElement;
  innerName: WebGalComputedElement;
  backgroundAfter: WebGalComputedElement;
  nameAfter: WebGalComputedElement;
  nameBackgroundHasPaint: boolean;
  transform: ScaleInfo | null;
  diagnostics: string[];
}

type Node = Exclude<keyof WebGalComputedStyle, 'transform' | 'diagnostics' | 'nameBackgroundHasPaint'>;
const SELECTORS: Record<Node, string> = {
  main: '.TextBox_main', text: '.text', outer: '.outer', inner: '.inner',
  background: '.TextBox_Background', name: '.TextBox_showName',
  nameBackground: '.TextBox_ShowName_Background', outerName: '.outerName',
  innerName: '.innerName', backgroundAfter: '.TextBox_Background::after',
  nameAfter: '.TextBox_ShowName_Background::after',
};
// WebGAL's name label and backdrop are sibling divs; both carry showName and
// both receive inline font-size:200%. Text layers inherit from .text.
const PARENTS: Record<Node, Node | null> = {
  main: null, text: 'main', outer: 'text', inner: 'text', background: 'main',
  name: 'main', nameBackground: 'main', outerName: 'name', innerName: 'name',
  backgroundAfter: 'background', nameAfter: 'nameBackground',
};

const INHERITED = new Set([
  'fontsize', 'fontfamily', 'fontweight', 'lineheight', 'color', 'textalign',
  'textshadow', 'visibility', 'webkittextstroke', 'textstroke',
]);
const INITIAL: Record<string, string> = {
  fontsize: `${ROOT_FONT_PX}px`, fontfamily: 'sans-serif', fontweight: 'normal',
  lineheight: 'normal', color: 'white', textalign: '', textshadow: 'none',
  visibility: 'visible', backgroundcolor: 'transparent', backgroundimage: 'none',
  backgroundclip: 'border-box', border: 'none', borderradius: '0', boxshadow: 'none',
  opacity: '1',
};
function initialValue(property: string): string {
  if ((LENGTHS as readonly string[]).includes(property)) {
    return property === 'minwidth' || property === 'minheight' ? '0' : 'auto';
  }
  return INITIAL[property] ?? '0';
}
const SUPPORTED = new Set([
  ...Object.keys(INITIAL), ...LENGTHS,
  'padding', 'paddingtop', 'paddingright', 'paddingbottom', 'paddingleft',
  'background', 'webkitbackgroundclip', 'backgroundsize', 'transform', 'alignitems',
  'webkittextstroke', 'textstroke',
]);
// Recognized layout/animation declarations outside the engine style mapping.
const IGNORED = new Set([
  'position', 'display', 'overflow', 'zindex', 'pointerevents', 'content',
  'animation', 'animationname', 'animationduration', 'animationtimingfunction',
  'animationfillmode', 'animationdelay', 'transition', 'cursor', 'userselect',
  'justifycontent', 'flexdirection', 'whitespace',
]);
const normalize = (property: string): string => property.replace(/^-+/, '').replace(/-/g, '');
const stage = (value: number): number => rnd(value * STAGE_SCALE);

function alignment(value: string): CssAlignment | null {
  if (/^(left|start|flex-start)$/.test(value)) return 'left';
  if (/^(right|end|flex-end)$/.test(value)) return 'right';
  return value === 'center' ? 'center' : null;
}

interface SourceStyle {
  values: Record<string, string>;
  font: number;
  line: { kind: 'ratio' | 'length'; value: number };
  width: number;
  height: number;
  result: WebGalComputedElement;
}

/** Match only selectors in this known textbox tree; unrelated suffixes don't apply. */
function matches(selector: string, node: Node): boolean {
  const tokens = selector.trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
  const matchPart = (part: string, target: Node): boolean => {
    const aliases = [SELECTORS[target]];
    if (target === 'nameBackground') aliases.push('.TextBox_showName');
    return aliases.includes(part) || part === '*';
  };
  if (!tokens.length || !matchPart(tokens[tokens.length - 1], node)) return false;
  let current: Node | null = node;
  for (let i = tokens.length - 2; i >= 0; i--) {
    const direct = tokens[i] === '>';
    if (direct) i--;
    if (i < 0) return false;
    current = current == null ? null : PARENTS[current];
    if (!direct) {
      while (current && !matchPart(tokens[i], current)) current = PARENTS[current];
    }
    if (!current || !matchPart(tokens[i], current)) return false;
  }
  return true;
}

function compute(rules: readonly ScssRule[], diagnostics: string[]): WebGalComputedStyle {
  const report = (message: string): void => { if (!diagnostics.includes(message)) diagnostics.push(message); };
  const valuesByNode = new Map<Node, Record<string, string>>();
  let nameBackgroundHasPaint = false;
  for (const node of Object.keys(SELECTORS) as Node[]) {
    const declarations = rules.filter((rule) => matches(rule.selector, node))
      .sort((a, b) => selectorSpecificity(a.selector) - selectorSpecificity(b.selector))
      .flatMap((rule) => rule.declarations.map((declaration) => ({ ...declaration, selector: rule.selector })));
    // Validate before cascade, so unsupported/invalid declarations cannot hide
    // an earlier supported value. This is intentionally a bounded CSS subset.
    const accepted: ScssDeclaration[] = [];
    for (const declaration of declarations) {
      const property = normalize(declaration.property);
      if (!SUPPORTED.has(property)) {
        if (!IGNORED.has(property)) report(`不支持的 CSS 属性：${SELECTORS[node]} 的 ${declaration.property}。`);
        continue;
      }
      if (/\b(?:var|calc|clamp|min|max)\(|\$|^(revert|revert-layer)$/i.test(declaration.value)) {
        report(`不支持的 CSS 值：${SELECTORS[node]} 的 ${declaration.property}: ${declaration.value}。`);
        continue;
      }
      const expanded = expandDeclaration(declaration);
      const keyword = /^(inherit|initial|unset)$/.test(declaration.value);
      const invalidPadding = property.startsWith('padding') && !keyword && (
        !expanded.length || expanded.some((part) => {
          const number = length(part.value, ROOT_FONT_PX, WEBGAL_STAGE_WIDTH);
          return number == null || number < 0;
        })
      );
      const invalidFont = property === 'fontsize' && !keyword && (
        (length(declaration.value, ROOT_FONT_PX, ROOT_FONT_PX) ?? -1) < 0
      );
      const invalidColor = (property === 'color' || property === 'backgroundcolor')
        && !keyword && declaration.value.toLowerCase() !== 'currentcolor' && !tryParseColor(declaration.value);
      const invalidBackground = (property === 'background' || property === 'backgroundimage')
        && !keyword && declaration.value !== 'none' && !parsePaint(declaration.value)
        && !/^url\(/i.test(declaration.value);
      const invalidLength = (LENGTHS as readonly string[]).includes(property) && !keyword
        && declaration.value !== 'auto' && length(declaration.value, ROOT_FONT_PX, WEBGAL_STAGE_WIDTH) == null;
      const invalidLine = property === 'lineheight' && !keyword && declaration.value !== 'normal'
        && (length(declaration.value, ROOT_FONT_PX, ROOT_FONT_PX) ?? -1) < 0;
      if (invalidPadding || invalidFont || invalidColor || invalidBackground || invalidLength || invalidLine) {
        report(`无法计算 CSS 声明：${SELECTORS[node]} 的 ${declaration.property}: ${declaration.value}；已忽略。`);
        continue;
      }
      if ((property === 'background' || property === 'backgroundimage') && declaration.value.includes('gradient(')) {
        if (declaration.value.includes('),')) report(`${SELECTORS[node]} 的多层背景仅取首个线性渐变。`);
      }
      if (node === 'nameBackground' && declaration.selector.includes('.TextBox_ShowName_Background')
        && ['background', 'backgroundcolor', 'backgroundimage'].includes(property)) {
        nameBackgroundHasPaint = true;
      }
      accepted.push(declaration);
    }
    const cascaded = cascadeDeclarations(accepted);
    if ((node === 'name' || node === 'nameBackground') && !isImportantDeclaration(cascaded, 'fontsize')) {
      cascaded.fontsize = '200%';
    }
    valuesByNode.set(node, cascaded);
  }
  for (const rule of rules) {
    if (!(Object.keys(SELECTORS) as Node[]).some((node) => matches(rule.selector, node))) {
      report(`未映射 CSS 选择器：${rule.selector}。`);
    }
  }

  const sources = new Map<Node, SourceStyle>();
  const resolve = (node: Node): SourceStyle => {
    const cached = sources.get(node);
    if (cached) return cached;
    const parentNode = PARENTS[node];
    const parent = parentNode ? resolve(parentNode) : null;
    const authored = valuesByNode.get(node) ?? {};
    const values: Record<string, string> = {};
    for (const key of new Set([...Object.keys(INITIAL), ...Object.keys(authored), ...INHERITED])) {
      const specified = authored[key];
      const inherit = specified === 'inherit' || ((specified == null || specified === 'unset') && INHERITED.has(key));
      values[key] = inherit ? (parent?.values[key] ?? INITIAL[key] ?? '')
        : specified === 'initial' || specified === 'unset' ? initialValue(key)
          : specified ?? INITIAL[key] ?? '';
    }
    const fontInherited = authored.fontsize == null || authored.fontsize === 'inherit' || authored.fontsize === 'unset';
    const font = fontInherited ? (parent?.font ?? ROOT_FONT_PX)
      : length(values.fontsize, parent?.font ?? ROOT_FONT_PX, parent?.font ?? ROOT_FONT_PX) ?? parent?.font ?? ROOT_FONT_PX;
    const safeFont = font > 0 ? font : parent?.font ?? ROOT_FONT_PX;
    if (font <= 0) report(`${SELECTORS[node]} 的字号为零；引擎需要正字号，已采用继承字号。`);
    const lineInherited = authored.lineheight == null || authored.lineheight === 'inherit' || authored.lineheight === 'unset';
    let line: SourceStyle['line'];
    if (lineInherited && parent) line = parent.line;
    else if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(values.lineheight)) line = { kind: 'ratio', value: Number(values.lineheight) };
    else if (values.lineheight === 'normal') line = { kind: 'ratio', value: 1.6 };
    else {
      const absolute = length(values.lineheight, safeFont, safeFont);
      line = absolute != null && absolute >= 0 ? { kind: 'length', value: absolute } : { kind: 'ratio', value: 1.6 };
      if (absolute == null) report(`无法计算 CSS 行高：${SELECTORS[node]} 的 ${values.lineheight}；按 1.6 倍字号近似。`);
    }
    // Main's containing block is the stage; absolute nameplate divs use main.
    const container = node === 'main' ? null : sources.get('main') ?? resolve('main');
    const containingWidth = container?.width ?? WEBGAL_STAGE_WIDTH;
    const containingHeight = container?.height ?? WEBGAL_STAGE_HEIGHT;
    const sourceLengths = Object.fromEntries(LENGTHS.map((key) => {
      const vertical = ['top', 'bottom', 'height', 'minheight'].includes(key);
      const result = length(values[key], safeFont, vertical ? containingHeight : containingWidth);
      if (values[key] && result == null && values[key] !== 'auto') {
        report(`无法计算 CSS 长度：${SELECTORS[node]} 的 ${key}: ${values[key]}。`);
      }
      return [key, result];
    })) as Record<LengthProperty, number | null>;
    const padding: BoxSides = { t: 0, r: 0, b: 0, l: 0 };
    for (const [side, key] of [['top', 't'], ['right', 'r'], ['bottom', 'b'], ['left', 'l']] as const) {
      const sourcePadding = length(values[`padding${side}`], safeFont, containingWidth) ?? 0;
      padding[key] = stage(sourcePadding);
      values[`padding${side}`] = `${sourcePadding}px`;
    }
    const color = values.color.toLowerCase() === 'currentcolor' ? parent?.result.color ?? '#FFFFFFFF'
      : tryParseColor(values.color) ?? parent?.result.color ?? '#FFFFFFFF';
    const backgroundColor = values.backgroundcolor.toLowerCase() === 'currentcolor' ? color : values.backgroundcolor;
    const backgroundImage = values.backgroundimage;
    const painted = Object.keys(authored).some((key) => key === 'backgroundcolor' || key === 'backgroundimage');
    const image = backgroundImage === 'inherit' ? parent?.result.background : parsePaint(backgroundImage);
    const background = painted ? image ?? parsePaint(backgroundColor) ?? { kind: 'solid' as const, color: '#00000000' } : null;
    if (/^url\(/i.test(backgroundImage) && node !== 'backgroundAfter' && node !== 'nameAfter') {
      report(`${SELECTORS[node]} 的背景图片无法映射到面板填充，已采用背景色。`);
    }
    const strokeValue = values.webkittextstroke || values.textstroke;
    const strokeMatch = /^([^\s]+)\s+(.+)$/.exec(strokeValue ?? '');
    const strokeWidth = strokeMatch ? length(strokeMatch[1], safeFont, safeFont) : null;
    const radius = length(values.borderradius.split(/\s+/)[0], safeFont, containingWidth) ?? 0;
    if (values.borderradius.trim().split(/\s+/).length > 1) report(`${SELECTORS[node]} 的多值圆角按首个半径近似。`);
    const shadowInherited = authored.textshadow == null || authored.textshadow === 'inherit' || authored.textshadow === 'unset';
    const textShadow = shadowInherited && parent ? parent.result.textShadow : parseTextShadow(values.textshadow, safeFont, color);
    if (values.textshadow !== 'none' && !textShadow.has) report(`无法计算 CSS 阴影：${SELECTORS[node]} 的 ${values.textshadow}。`);
    const result: WebGalComputedElement = {
      fontSize: stage(safeFont), lineHeight: stage(line.kind === 'ratio' ? safeFont * line.value : line.value),
      fontFamily: values.fontfamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
      fontWeight: /^(bold|bolder|[6-9]00)$/.test(values.fontweight) ? '700' : '400',
      color, align: alignment(values.textalign), flexAlign: alignment(values.alignitems),
      padding, hasPadding: Object.keys(authored).some((key) => key.startsWith('padding')),
      lengths: Object.fromEntries(LENGTHS.map((key) => [key, sourceLengths[key] == null ? null : stage(sourceLengths[key])])) as Record<LengthProperty, number | null>,
      background, backgroundClipText: /text/i.test(values.webkitbackgroundclip || values.backgroundclip),
      border: parseBorder(values.border, safeFont), hasBorder: authored.border != null,
      radius: Math.max(0, stage(radius)), hasRadius: authored.borderradius != null,
      boxShadow: parseBoxShadow(values.boxshadow, safeFont), hasBoxShadow: authored.boxshadow != null, textShadow,
      hasStroke: !!strokeMatch,
      stroke: { width: Math.max(0, (strokeWidth ?? 0) * STAGE_SCALE), color: tryParseColor(strokeMatch?.[2]) ?? '#000000FF' },
      hidden: /^(hidden|collapse)$/.test(values.visibility), imageFile: urlBasename(backgroundImage),
      decorationSize: sourceLengths.width != null ? stage(sourceLengths.width)
        : values.backgroundsize ? stage(length(values.backgroundsize.split(/\s+/)[0], safeFont, containingWidth) ?? 0) : null,
      opacity: Number.isFinite(Number(values.opacity)) ? Math.max(0, Math.min(1, Number(values.opacity))) : 1,
      rotation: Number(/rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(values.transform)?.[1] ?? 0),
    };
    // Store computed source-space values for subsequent inheritance. Copying
    // an authored `1em` would incorrectly recompute it with the child's font.
    values.fontsize = `${safeFont}px`;
    values.lineheight = line.kind === 'ratio' ? String(line.value) : `${line.value}px`;
    values.color = color;
    values.backgroundcolor = backgroundColor;
    for (const key of LENGTHS) {
      if (sourceLengths[key] != null) values[key] = `${sourceLengths[key]}px`;
    }
    if (strokeMatch && strokeWidth != null) {
      const computedStroke = `${strokeWidth}px ${strokeMatch[2]}`;
      if (values.webkittextstroke) values.webkittextstroke = computedStroke;
      else values.textstroke = computedStroke;
    }
    values.borderradius = `${radius}px`;
    // Missing main geometry retains the importer's existing layout estimate.
    const source: SourceStyle = {
      values, font: safeFont, line,
      width: sourceLengths.width ?? (node === 'main' ? WEBGAL_STAGE_WIDTH - (sourceLengths.left ?? 50) - (sourceLengths.right ?? 25) : containingWidth),
      height: sourceLengths.height ?? sourceLengths.minheight ?? containingHeight,
      result,
    };
    sources.set(node, source);
    return source;
  };
  const elements = Object.fromEntries((Object.keys(SELECTORS) as Node[]).map((node) => [node, resolve(node).result])) as Record<Node, WebGalComputedElement>;
  const transformValue = valuesByNode.get('main')?.transform;
  if (transformValue && !/^(none|(?:scale(?:X|Y)?\([^)]*\)\s*)+)$/i.test(transformValue)) {
    report(`不支持的主容器 transform：${transformValue}；仅映射 scale/scaleX/scaleY。`);
  }
  return { ...elements, nameBackgroundHasPaint, transform: parseScale(transformValue), diagnostics };
}

export function computeWebGalTextboxStyle(css: string): WebGalComputedStyle {
  const source = stripComments(css);
  const diagnostics: string[] = [];
  if (/@[\w-]+/.test(source)) diagnostics.push('SCSS at-rule（含条件规则、mixin 和动画）未计算；仅转换静态规则。');
  if (/\$[\w-]+/.test(source)) diagnostics.push('SCSS 变量未求值；请先编译为静态 CSS。');
  return compute(parseScssRules(css), diagnostics);
}

/** Compatibility for callers of extractWebGalTextBoxTheme(parseBlocks(css)). */
export function computeWebGalTextboxBlocks(blocks: ScssBlocks): WebGalComputedStyle {
  return compute(rulesOf(blocks), []);
}
