export type ExperimentalFeatureId =
  | 'voice-generation'
  | 'collaboration-editing'
  | 'wmdl'
  | 'advanced-visual';

export interface ExperimentalFeatureDefinition {
  id: ExperimentalFeatureId;
  userName: string;
  purpose: string;
  limitations: readonly string[];
  possibleImpact: string;
}

export type ExperimentalFeatureReadState = Partial<Record<ExperimentalFeatureId, boolean>>;

export type ExperimentalFeaturePromptDecision = 'continue' | 'decline';

export const EXPERIMENTAL_FEATURES: readonly ExperimentalFeatureDefinition[] = Object.freeze([
  {
    id: 'voice-generation',
    userName: '语音生成',
    purpose: '为对白生成或应用角色语音。',
    limitations: Object.freeze([
      '依赖本机语音生成服务和已配置模型。',
      '只有明确应用结果后才会修改对白。',
    ]),
    possibleImpact: '可能需要较长处理时间，并产生新的项目音频素材。',
  },
  {
    id: 'collaboration-editing',
    userName: '协作编辑',
    purpose: '从项目主页启动多人协作编辑会话。',
    limitations: Object.freeze([
      '需要主机和参与者使用兼容版本。',
      '确认前不得创建项目、启动服务器或连接房间。',
    ]),
    possibleImpact: '会打开本机协作服务或连接远端房间，并同步当前项目状态。',
  },
  {
    id: 'wmdl',
    userName: '拼好模',
    purpose: '使用已经组合好的 WebGAL 模型包装入口。',
    limitations: Object.freeze([
      '首课不使用拼好模。',
      '只在普通角色管理中直接选择时提示。',
    ]),
    possibleImpact: '模型引用会按包装入口保存，加载结果取决于包装内声明的真实模型。',
  },
  {
    id: 'advanced-visual',
    userName: '高级视觉能力',
    purpose: '使用镜头和视觉类的高级语句能力。',
    limitations: Object.freeze([
      '覆盖语句库 camera 和 visual 两类。',
      '不解析模板组合、已有项目或场景 JSON。',
    ]),
    possibleImpact: '可能改变舞台画面、镜头运动或后期视觉效果。',
  },
]);

const EXPERIMENTAL_FEATURE_IDS = new Set<ExperimentalFeatureId>(
  EXPERIMENTAL_FEATURES.map((feature) => feature.id),
);

export function listExperimentalFeatures(): readonly ExperimentalFeatureDefinition[] {
  return EXPERIMENTAL_FEATURES;
}

export function isExperimentalFeatureId(value: unknown): value is ExperimentalFeatureId {
  return typeof value === 'string' && EXPERIMENTAL_FEATURE_IDS.has(value as ExperimentalFeatureId);
}

export function getExperimentalFeatureDefinition(
  id: ExperimentalFeatureId,
): ExperimentalFeatureDefinition {
  const definition = EXPERIMENTAL_FEATURES.find((feature) => feature.id === id);
  if (!definition) {
    throw new Error(`Unknown experimental feature: ${id}`);
  }
  return definition;
}

export function normalizeExperimentalFeatureReadState(
  value: unknown,
): ExperimentalFeatureReadState {
  if (!value || typeof value !== 'object') return {};

  const normalized: ExperimentalFeatureReadState = {};
  for (const [key, read] of Object.entries(value)) {
    if (read === true && isExperimentalFeatureId(key)) {
      normalized[key] = true;
    }
  }
  return normalized;
}

export function shouldPromptExperimentalFeature(
  id: ExperimentalFeatureId,
  readState: ExperimentalFeatureReadState,
): boolean {
  return readState[id] !== true;
}

export function applyExperimentalFeaturePromptDecision(
  id: ExperimentalFeatureId,
  readState: ExperimentalFeatureReadState,
  decision: ExperimentalFeaturePromptDecision,
): { allowed: boolean; readState: ExperimentalFeatureReadState } {
  if (decision === 'decline') {
    return {
      allowed: false,
      readState: normalizeExperimentalFeatureReadState(readState),
    };
  }

  return {
    allowed: true,
    readState: {
      ...normalizeExperimentalFeatureReadState(readState),
      [id]: true,
    },
  };
}

export function resetExperimentalFeatureReadState(): ExperimentalFeatureReadState {
  return {};
}
