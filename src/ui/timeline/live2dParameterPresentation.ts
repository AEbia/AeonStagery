const LEADING_PARAMETER_PREFIX = /^(?:parameterid|paramid|parameters|params|parameter|param)(?=$|[._:/\-\s\[]|[A-Z])/i;
const TOKEN_SEPARATOR = /[^A-Za-z0-9\u3400-\u9fff]+/g;

const AXIS_LABELS: Readonly<Record<string, string>> = {
  X: '左右',
  Y: '上下',
  Z: '倾斜',
};

const GENERIC_TOKEN_LABELS: Readonly<Record<string, string>> = {
  ANGLE: '角度',
  ARM: '手臂',
  BACK: '后',
  BASE: '整体',
  BODY: '身体',
  BREATH: '呼吸',
  BROW: '眉毛',
  CHEEK: '脸颊',
  CHANGE: '切换',
  CLOTHES: '服装',
  CUSTOM: '自定义',
  EYE: '眼睛',
  EYEBALL: '眼球',
  EYELID: '眼皮',
  FACE: '脸部',
  FLUFFY: '蓬松',
  FORM: '形态',
  FRONT: '前',
  HAIR: '头发',
  HAND: '手部',
  HEAD: '头部',
  HIGHLIGHT: '高光',
  IMPORT: '导入',
  L: '左',
  LEFT: '左',
  MOUTH: '嘴部',
  MOTION: '动作',
  MOTIONS: '动作',
  MASK: '遮罩',
  OPEN: '开合',
  OPACITY: '透明度',
  POSITION: '位置',
  R: '右',
  RIGHT: '右',
  SIDE: '侧',
  SCALE: '大小',
  SMILE: '笑眼',
  TEAR: '泪水',
  TERE: '害羞',
  UPPER: '上部',
  X: '左右',
  Y: '上下',
  Z: '倾斜',
};

/**
 * Converts Cubism parameter ids into compact author-facing Chinese labels.
 * The stored id remains untouched; this function is presentation-only.
 */
export function getLive2DParameterDisplayName(parameterId: string): string {
  const tokens = tokenizeParameterId(parameterId);
  if (tokens.length === 0) return '未命名参数';

  const side = resolveSide(tokens);
  const axis = resolveAxis(tokens);

  if (tokens.includes('EYELID')) return side ? `${side}眼皮` : '眼皮';

  if (tokens.includes('EYE')) {
    const isEyeball = tokens.includes('BALL') || tokens.includes('EYEBALL');
    const subject = isEyeball ? '眼球' : side ? `${side}眼` : '眼睛';
    if (tokens.includes('OPEN')) return `${subject}开合`;
    if (tokens.includes('SMILE')) return `${subject}微笑`;
    if (tokens.includes('FORM')) return `${subject}形态`;
    if (tokens.includes('HIGHLIGHT')) return `${subject}高光`;
    if (tokens.includes('SCALE')) return `${subject}大小`;
    if (axis) return `${subject}${axis}`;
    return subject;
  }

  if (tokens.includes('BROW')) {
    const subject = side ? `${side}眉` : '眉毛';
    if (tokens.includes('FORM')) return `${subject}形态`;
    if (tokens.includes('ANGLE')) return `${subject}角度`;
    if (axis) return `${subject}${axis}`;
    return subject;
  }

  if (tokens.includes('MOUTH')) {
    if (tokens.includes('OPEN')) return '嘴部开合';
    if (tokens.includes('FORM')) return formatFeatureVariant(tokens, 'FORM', '嘴部形态');
    if (tokens.includes('SCALE')) return '嘴部大小';
    if (axis) return `嘴部${axis}`;
    return '嘴部';
  }

  if (tokens.includes('UPPER') && tokens.includes('BODY')) return '上身';

  if (tokens.includes('BODY')) {
    return `身体${axis || (tokens.includes('ANGLE') ? '角度' : '')}`;
  }

  if (tokens.includes('ARM')) {
    return formatLimbLabel(tokens, 'ARM', side ? `${side}臂` : '手臂');
  }

  if (tokens.includes('HAND')) {
    return formatLimbLabel(tokens, 'HAND', side ? `${side}手` : '手部');
  }

  if (tokens.includes('ANGLE')) return `头部${axis || '角度'}`;
  if (tokens.includes('BREATH')) return '呼吸';
  if (tokens.includes('CHEEK')) return formatFeatureVariant(tokens, 'CHEEK', '脸颊');
  if (tokens.includes('TEAR')) return '泪水';
  if (tokens.includes('TERE')) return '害羞';

  if (tokens.includes('HAIR')) {
    if (tokens.includes('FRONT')) return '前发';
    if (tokens.includes('SIDE')) return '侧发';
    if (tokens.includes('BACK')) return '后发';
    if (tokens.includes('FLUFFY')) return '头发蓬松';
    return '头发';
  }

  if (tokens.includes('BASE')) return `整体${axis}`;
  if (tokens.includes('POSITION')) return `整体${axis || '位置'}`;
  if (tokens.includes('ROTATION')) return '整体旋转';
  if (tokens.includes('CLOTHES')) return formatFeatureVariant(tokens, 'CLOTHES', '服装');
  if (tokens.includes('MASK')) return formatFeatureVariant(tokens, 'MASK', '遮罩');
  if (tokens.includes('MOTIONS') || tokens.includes('MOTION')) {
    return formatFeatureVariant(tokens, tokens.includes('MOTIONS') ? 'MOTIONS' : 'MOTION', '动作');
  }
  if (tokens.includes('IMPORT')) return '导入';

  return formatGenericTokens(tokens);
}

function tokenizeParameterId(parameterId: string): string[] {
  let value = parameterId.trim();
  let previous = '';
  while (value !== previous) {
    previous = value;
    value = value
      .replace(LEADING_PARAMETER_PREFIX, '')
      .replace(/^[._:/\-\s\[\]]+/, '');
  }

  const tokens = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([A-Za-z])(\d)/g, '$1_$2')
    .replace(/(\d)([A-Za-z])/g, '$1_$2')
    .replace(TOKEN_SEPARATOR, '_')
    .split('_')
    .filter(Boolean)
    .map((token) => token.toUpperCase());

  const featureIndex = tokens.findIndex((token) => token === 'ARM' || token === 'HAND');
  const compactSideVariant = featureIndex >= 0 ? tokens[featureIndex + 1] : undefined;
  if (compactSideVariant && /^[LR][A-Z]$/.test(compactSideVariant)) {
    tokens.splice(featureIndex + 1, 1, compactSideVariant[0], compactSideVariant[1]);
  }

  return tokens;
}

function resolveSide(tokens: readonly string[]): string {
  if (tokens.includes('L') || tokens.includes('LEFT')) return '左';
  if (tokens.includes('R') || tokens.includes('RIGHT')) return '右';
  return '';
}

function resolveAxis(tokens: readonly string[]): string {
  const axis = tokens.find((token) => token === 'X' || token === 'Y' || token === 'Z');
  return axis ? AXIS_LABELS[axis] : '';
}

function formatLimbLabel(tokens: readonly string[], feature: 'ARM' | 'HAND', subject: string): string {
  if (tokens.includes('CHANGE')) return `${subject}切换`;
  if (tokens.includes('ADJUSTMENT')) return `${subject}调整`;

  const featureIndex = tokens.indexOf(feature);
  const variants = tokens
    .slice(featureIndex + 1)
    .filter((token) => !['L', 'LEFT', 'R', 'RIGHT', 'FOR'].includes(token))
    .map(formatVariantToken);

  return variants.length > 0 ? `${subject} ${variants.join('-')}` : subject;
}

function formatFeatureVariant(tokens: readonly string[], feature: string, subject: string): string {
  const featureIndex = tokens.indexOf(feature);
  const variants = tokens.slice(featureIndex + 1).map((token) => (
    AXIS_LABELS[token] ?? formatVariantToken(token)
  ));
  return variants.length > 0 ? `${subject} ${variants.join('-')}` : subject;
}

function formatVariantToken(token: string): string {
  if (/^\d+$/.test(token)) return String(Number(token));
  return token.length === 1 ? token : toTitleCase(token);
}

function formatGenericTokens(tokens: readonly string[]): string {
  const parts = tokens.map((token) => GENERIC_TOKEN_LABELS[token] ?? formatVariantToken(token));
  return parts.join(' ').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1');
}

function toTitleCase(value: string): string {
  return `${value.slice(0, 1)}${value.slice(1).toLowerCase()}`;
}
