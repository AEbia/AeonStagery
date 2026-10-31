/**
 * Human-friendly AI configuration status & error diagnostics for users who may
 * not be familiar with LLM APIs (Base URL, API Key, Model IDs, Tool Calling).
 */

export type AiErrorCategory =
  | 'missing_credential'
  | 'unauthorized'
  | 'quota_exceeded'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'tool_calling_unsupported'
  | 'unknown';

export interface AiErrorDiagnosis {
  readonly category: AiErrorCategory;
  readonly userTitle: string;
  readonly userMessage: string;
  readonly suggestion?: string;
  readonly suggestOpenSettings: boolean;
  readonly rawDetail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recognizes local loopback endpoints (such as Ollama `http://localhost:11434/v1`
 * or LM Studio `http://127.0.0.1:1234/v1`) that commonly run without an API key.
 */
export function isLocalLoopbackEndpoint(endpoint?: string | null): boolean {
  if (!endpoint || !endpoint.trim()) return false;
  const trimmed = endpoint.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase();
    return (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '::1'
      || host === '[::1]'
      || host.startsWith('127.')
    );
  } catch {
    return false;
  }
}

/**
 * Returns true when the environment has explicitly checked the stored credential,
 * confirmed no API key is configured, and the target endpoint is a remote cloud URL.
 */
export function shouldRequireAiCredentialSetup(options: {
  credentialChecked: boolean;
  credentialConfigured: boolean;
  endpoint?: string | null;
}): boolean {
  return (
    options.credentialChecked
    && !options.credentialConfigured
    && !isLocalLoopbackEndpoint(options.endpoint)
  );
}

export const MISSING_CREDENTIAL_GUIDE_MESSAGE =
  '尚未配置 AI 服务（API 密钥）。请先点击「前往 AI 设置」，填入大模型平台的 Base URL 与 API 密钥并点击「保存」后再试。';

export function diagnoseAiError(
  error: unknown,
  options: { status?: number; code?: string } = {},
): AiErrorDiagnosis {
  const record = isRecord(error) ? error : undefined;
  const details = isRecord(record?.details) ? record.details : undefined;
  const rawMessage = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error ?? '未知错误');

  const statusFromText = (() => {
    const match = rawMessage.match(/\bHTTP\s+(\d{3})\b/i);
    return match ? Number(match[1]) : undefined;
  })();

  const status = options.status
    ?? (typeof record?.status === 'number' ? record.status : undefined)
    ?? (typeof details?.status === 'number' ? details.status : undefined)
    ?? statusFromText;

  const code = options.code
    ?? (typeof record?.code === 'string' ? record.code : undefined)
    ?? (typeof details?.code === 'string' ? details.code : undefined);

  if (
    code === 'missing_credential'
    || /尚未配置\s*AI|尚未配置.*密钥|未配置\s*API\s*密钥/i.test(rawMessage)
  ) {
    return {
      category: 'missing_credential',
      userTitle: '尚未配置 AI 服务（API 密钥）',
      userMessage: '使用 AI 功能前，需要先在「AI 设置」中配置大模型服务商的接口地址（Base URL）并保存 API 密钥。',
      suggestion: '点击「前往 AI 设置」，按顶部三步说明粘贴密钥并点击「保存」即可开始使用。',
      suggestOpenSettings: true,
    };
  }

  if (
    status === 401
    || /\b(401|unauthorized|invalid[_\s-]?api[_\s-]?key|didn't provide an api key|authentication\s+failed|incorrect api key|令牌|密钥无效|未提供.*密钥)\b/i.test(rawMessage)
  ) {
    return {
      category: 'unauthorized',
      userTitle: 'API 密钥未配置或无效（HTTP 401）',
      userMessage: 'AI 服务商拒绝了身份验证。通常是因为尚未配置 API 密钥、输入后未点击「保存」，或密钥与当前填写的 Base URL 平台不一致。',
      suggestion: '请打开「AI 设置」，确认 Base URL 与申请密钥的平台一致，重新粘贴 API 密钥并点击「保存」。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  if (
    status === 402
    || /\b(402|insufficient[_\s-]?quota|insufficient[_\s-]?balance|billing|余额不足|额度不足|欠费|arrears)\b/i.test(rawMessage)
  ) {
    return {
      category: 'quota_exceeded',
      userTitle: 'AI 账户余额或调用额度不足',
      userMessage: '当前 API 密钥所属的大模型服务商账户余额或免费额度已用尽。',
      suggestion: '请前往对应大模型平台后台查看余额与账单，或在「AI 设置」中更换其他可用平台的密钥。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  if (
    status === 403
    || /\b(403|forbidden|permission[_\s-]?denied|access[_\s-]?denied|无权限|权限不足)\b/i.test(rawMessage)
  ) {
    return {
      category: 'forbidden',
      userTitle: '接口拒绝访问（HTTP 403）',
      userMessage: '当前 API 密钥无权调用所选模型，或服务商限制了该请求。',
      suggestion: '请打开「AI 设置」确认所选模型是否已在该平台开通权限，或点击「获取模型」切换其他可用模型。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  if (
    status === 404
    || /\b(404|model[_\s-]?not[_\s-]?found|does not exist|not found|找不到模型|模型不存在)\b/i.test(rawMessage)
  ) {
    return {
      category: 'not_found',
      userTitle: '接口地址或模型名称不正确（HTTP 404）',
      userMessage: '服务商找不到请求的接口或模型。常见原因是 Base URL 漏写了 /v1，或更换了服务商却仍保留着默认的 gpt-4o-mini 模型名。',
      suggestion: '请打开「AI 设置」检查 Base URL，点击「获取模型」从下拉列表中选择该平台支持的模型名称。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  if (
    status === 429
    || code === 'capability_probe_rate_limited'
    || /\b(429|rate[_\s-]?limit|too many requests|请求过多|频率限制|限流)\b/i.test(rawMessage)
  ) {
    return {
      category: 'rate_limited',
      userTitle: '请求过于频繁（HTTP 429）',
      userMessage: '已触发大模型服务商的调用频率或并发限制。',
      suggestion: '请稍等片刻后重试，或在「AI 设置」中将「最大并发」调小（例如设为 1）。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  if (
    code === 'request_timeout'
    || /\b(fetch failed|failed to fetch|networkerror|econnrefused|enotfound|etimedout|socket hang up|timed out|stream inactivity|连接超时|无法连接)\b/i.test(rawMessage)
  ) {
    return {
      category: 'network',
      userTitle: '无法连接到 AI 服务器（网络异常或超时）',
      userMessage: '未能连接到当前配置的 Base URL 接口地址。',
      suggestion: '请检查网络状态,或者尝试启用代理。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  if (
    code === 'native_tool_calling_unsupported'
    || code === 'native_tool_calling_unknown'
    || code === 'capability_required'
    || /tool\s*calling/i.test(rawMessage)
  ) {
    return {
      category: 'tool_calling_unsupported',
      userTitle: '当前模型无法用于项目 Agent',
      userMessage: rawMessage,
      suggestion: '请打开「AI 设置」检查 API 密钥与接口地址，并将模型更换为支持工具调用（Tool Calling）的主流模型（如 deepseek-chat、qwen-max、glm-4、gpt-4o 等）。',
      suggestOpenSettings: true,
    };
  }

  if (
    code === 'configuration'
    || code === 'provider_configuration_required'
    || /provider is not configured|does not match the configured provider|AI 设置无效/i.test(rawMessage)
  ) {
    return {
      category: 'missing_credential',
      userTitle: 'AI 服务配置需要检查',
      userMessage: '当前 AI 接口地址、模型或密钥配置尚未就绪。',
      suggestion: '请打开「AI 设置」检查 Base URL、模型名称与 API 密钥，并点击「测试连接」。',
      suggestOpenSettings: true,
      rawDetail: rawMessage,
    };
  }

  return {
    category: 'unknown',
    userTitle: 'AI 请求失败',
    userMessage: rawMessage,
    suggestOpenSettings: (status !== undefined && status >= 400 && status < 500) || false,
  };
}
