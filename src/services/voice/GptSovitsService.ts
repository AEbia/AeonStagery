import type {
  GptSovitsGenerateDialogueVoiceRequest,
  GptSovitsLocalConfig,
  GptSovitsVoicePreset,
} from './GptSovitsTypes';
import type { GenerateVoiceCandidateRequest } from './VoiceAuthoringTypes';

export interface GptSovitsRootValidationResult {
  valid: boolean;
  pythonPath?: string;
  apiScriptPath?: string;
  configPath?: string;
  errors: string[];
}

export interface GptSovitsFileSystemPort {
  exists(pathValue: string): boolean | Promise<boolean>;
  join(...parts: string[]): string;
}

export type GptSovitsAudioResponseResult =
  | { ok: true; bytes: Uint8Array; durationSeconds: number }
  | { ok: false; error: string };

export function normalizeGptSovitsConfig(config: Partial<GptSovitsLocalConfig> | null | undefined): GptSovitsLocalConfig {
  const apiHost = typeof config?.apiHost === 'string' && config.apiHost.trim()
    ? config.apiHost.trim()
    : '127.0.0.1';
  const rawPort = Number(config?.apiPort ?? 9880);
  const apiPort = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 9880;
  const rootPath = typeof config?.rootPath === 'string' ? config.rootPath.trim() : '';
  return { apiHost, apiPort, rootPath };
}

export function getGptSovitsApiBaseUrl(config: Partial<GptSovitsLocalConfig> | null | undefined): string {
  const normalized = normalizeGptSovitsConfig(config);
  const host = normalized.apiHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `http://${host}:${normalized.apiPort}`;
}

export function createGptSovitsTtsRequestBody(text: string, preset: GptSovitsVoicePreset): Record<string, unknown> {
  return {
    text,
    text_lang: normalizeGptSovitsLanguage(preset.textLang || 'all_ja'),
    ref_audio_path: preset.refAudioPath,
    prompt_lang: normalizeGptSovitsLanguage(preset.promptLang || 'all_ja'),
    prompt_text: preset.promptText || '',
    media_type: 'wav',
    speed_factor: preset.speed || 1,
    streaming_mode: false,
  };
}

export function createVoiceCandidateTtsRequestBody(
  input: GenerateVoiceCandidateRequest,
  seed: number,
): Record<string, unknown> {
  const options = input.options;
  return {
    text: input.text,
    text_lang: normalizeGptSovitsLanguage(options.textLang || 'all_ja'),
    ref_audio_path: input.referenceAudioPath,
    aux_ref_audio_paths: input.auxiliaryReferenceAudioPaths ?? [],
    prompt_lang: normalizeGptSovitsLanguage(input.promptLang || 'all_ja'),
    prompt_text: input.promptText || '',
    top_k: options.topK ?? 5,
    top_p: options.topP ?? 1,
    temperature: options.temperature ?? 1,
    text_split_method: options.textSplitMethod ?? 'cut5',
    batch_size: options.batchSize ?? 1,
    batch_threshold: options.batchThreshold ?? 0.75,
    split_bucket: options.splitBucket ?? true,
    speed_factor: options.speed || 1,
    fragment_interval: options.fragmentInterval ?? 0.3,
    seed,
    media_type: 'wav',
    streaming_mode: false,
    parallel_infer: options.parallelInfer ?? true,
    repetition_penalty: options.repetitionPenalty ?? 1.35,
    sample_steps: options.sampleSteps ?? 32,
    super_sampling: options.superSampling ?? false,
  };
}

export function normalizeGptSovitsAudioResponse(bytes: Uint8Array, contentType = ''): GptSovitsAudioResponseResult {
  if (bytes.byteLength === 0) return { ok: false, error: 'GPT-SoVITS 返回了空音频。' };

  const responseKind = contentType.toLowerCase();
  const textError = parseTextualAudioError(bytes, responseKind);
  if (textError) return { ok: false, error: textError };

  if (!hasAscii(bytes, 0, 'RIFF') || !hasAscii(bytes, 8, 'WAVE')) {
    const typeLabel = contentType.trim() || 'unknown content-type';
    return { ok: false, error: `GPT-SoVITS 返回的不是有效 WAV 音频（${typeLabel}, ${bytes.byteLength} bytes）。` };
  }

  const finalized = finalizeWavHeader(bytes);
  if (!finalized.ok) return finalized;
  return finalized;
}

export function createGptSovitsWeightRequestBody(preset: GptSovitsVoicePreset): Record<string, unknown> {
  return {
    gpt_weights_path: preset.gptWeightsPath,
    sovits_weights_path: preset.sovitsWeightsPath,
  };
}

export function buildGeneratedVoiceRelativePath(input: Pick<GptSovitsGenerateDialogueVoiceRequest, 'sceneId' | 'actionId'>, timestamp = Date.now()): string {
  const sceneId = sanitizePathToken(input.sceneId || 'scene');
  const actionId = sanitizePathToken(input.actionId || 'dialogue');
  return `vocal/generated/${sceneId}-${actionId}-${timestamp}.wav`;
}

export function ensureGeneratedVoicePathInsideProject(
  projectRootPath: string,
  relativePath: string,
  pathPort: { resolve(...parts: string[]): string; relative(from: string, to: string): string },
): { ok: true; absolutePath: string } | { ok: false; error: string } {
  const projectRoot = pathPort.resolve(projectRootPath);
  const absolutePath = pathPort.resolve(projectRoot, relativePath);
  const relativeToProject = pathPort.relative(projectRoot, absolutePath);
  const isOutsideProject = relativeToProject === '..'
    || relativeToProject.startsWith('../')
    || relativeToProject.startsWith('..\\')
    || pathPort.resolve(relativeToProject) === relativeToProject;
  if (isOutsideProject) {
    return { ok: false, error: '生成语音路径超出当前项目目录，已取消写入。' };
  }
  return { ok: true, absolutePath };
}

export function validateGptSovitsGenerationInput(input: GptSovitsGenerateDialogueVoiceRequest): string | null {
  const config = normalizeGptSovitsConfig(input.config);
  if (!config.rootPath) return '请先配置 GPT-SoVITS 根目录。';
  if (!input.projectRootPath) return '当前没有打开项目，无法保存生成语音。';
  if (!input.text.trim()) return '当前对白没有文本，无法生成语音。';
  const presetError = validateGptSovitsPreset(input.preset);
  if (presetError) return presetError;
  return null;
}

export function validateGptSovitsPreset(preset: GptSovitsVoicePreset | null | undefined): string | null {
  if (!preset) return '请先在项目配置中添加 GPT-SoVITS 音色 preset。';
  if (!hasText(preset.gptWeightsPath)) return '当前音色缺少 GPT 权重路径。';
  if (!hasText(preset.sovitsWeightsPath)) return '当前音色缺少 SoVITS 权重路径。';
  if (!hasText(preset.refAudioPath)) return '当前音色缺少参考音频路径。';
  if (!hasText(preset.promptLang)) return '当前音色缺少 prompt 语言。';
  if (!hasText(preset.textLang)) return '当前音色缺少生成文本语言。';
  return null;
}

export async function validateGptSovitsRoot(
  rootPath: string,
  fsPort: GptSovitsFileSystemPort,
): Promise<GptSovitsRootValidationResult> {
  const cleanRoot = rootPath.trim();
  const result: GptSovitsRootValidationResult = {
    valid: false,
    errors: [],
  };
  if (!cleanRoot) {
    result.errors.push('请先填写 GPT-SoVITS 根目录。');
    return result;
  }

  const pythonCandidates = [
    fsPort.join(cleanRoot, 'runtime', 'python.exe'),
    fsPort.join(cleanRoot, 'runtime', 'python'),
  ];
  const apiCandidates = [
    fsPort.join(cleanRoot, 'api_v2.py'),
    fsPort.join(cleanRoot, 'GPT_SoVITS', 'api_v2.py'),
  ];
  const configCandidates = [
    fsPort.join(cleanRoot, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'),
    fsPort.join(cleanRoot, 'GPT_SoVITS', 'configs', 'tts_infer.yaml.example'),
    fsPort.join(cleanRoot, 'config.py'),
  ];

  result.pythonPath = await firstExistingPath(pythonCandidates, fsPort);
  result.apiScriptPath = await firstExistingPath(apiCandidates, fsPort);
  result.configPath = await firstExistingPath(configCandidates, fsPort);

  if (!result.pythonPath) result.errors.push('缺少 runtime/python.exe。');
  if (!result.apiScriptPath) result.errors.push('缺少 api_v2.py。');
  if (!result.configPath) result.errors.push('缺少 GPT-SoVITS 配置文件。');
  result.valid = result.errors.length === 0;
  return result;
}

async function firstExistingPath(paths: string[], fsPort: GptSovitsFileSystemPort): Promise<string | undefined> {
  for (const pathValue of paths) {
    if (await fsPort.exists(pathValue)) return pathValue;
  }
  return undefined;
}

function sanitizePathToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function normalizeGptSovitsLanguage(value: string): string {
  const clean = value.trim();
  const aliases: Record<string, string> = {
    chinese: 'all_zh',
    japanese: 'all_ja',
    korean: 'all_ko',
    cantonese: 'all_yue',
  };
  return aliases[clean.toLowerCase()] ?? clean;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finalizeWavHeader(bytes: Uint8Array): GptSovitsAudioResponseResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  let dataChunkOffset = -1;
  let dataChunkSize = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataOffset + 12 <= bytes.byteLength) {
      byteRate = view.getUint32(chunkDataOffset + 8, true);
    }

    if (chunkId === 'data') {
      dataChunkOffset = offset;
      dataChunkSize = chunkSize;
      break;
    }

    if (chunkSize === 0) break;
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate) {
    return { ok: false, error: 'GPT-SoVITS 返回的 WAV 缺少有效 fmt chunk。' };
  }
  if (dataChunkOffset < 0) {
    return { ok: false, error: 'GPT-SoVITS 返回的 WAV 缺少 data chunk。' };
  }

  const dataStart = dataChunkOffset + 8;
  const availableDataBytes = Math.max(0, bytes.byteLength - dataStart);
  if (availableDataBytes === 0) {
    return { ok: false, error: 'GPT-SoVITS 返回了 0s WAV 音频，请检查参考音频、prompt 文本和模型组合。' };
  }

  if (dataChunkSize > availableDataBytes && dataChunkSize !== 0xffffffff) {
    return { ok: false, error: `GPT-SoVITS 返回的 WAV 数据不完整（声明 ${dataChunkSize} bytes，实际 ${availableDataBytes} bytes）。` };
  }

  const effectiveDataSize = dataChunkSize === 0 || dataChunkSize === 0xffffffff
    ? availableDataBytes
    : dataChunkSize;
  if (effectiveDataSize === 0) {
    return { ok: false, error: 'GPT-SoVITS 返回了 0s WAV 音频，请检查参考音频、prompt 文本和模型组合。' };
  }

  const normalized = dataChunkSize === effectiveDataSize && view.getUint32(4, true) === bytes.byteLength - 8
    ? bytes
    : patchWavSizes(bytes, dataChunkOffset, effectiveDataSize);
  const durationSeconds = Number((effectiveDataSize / byteRate).toFixed(3));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ok: false, error: 'GPT-SoVITS 返回了 0s WAV 音频，请检查参考音频、prompt 文本和模型组合。' };
  }

  return { ok: true, bytes: normalized, durationSeconds };
}

function patchWavSizes(bytes: Uint8Array, dataChunkOffset: number, dataChunkSize: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint32(4, copy.byteLength - 8, true);
  view.setUint32(dataChunkOffset + 4, dataChunkSize, true);
  return copy;
}

function parseTextualAudioError(bytes: Uint8Array, contentType: string): string | null {
  if (!contentType.includes('json') && !contentType.startsWith('text/')) {
    const first = firstNonWhitespaceByte(bytes);
    if (first !== 0x7b && first !== 0x5b) return null;
  }

  const text = new TextDecoder().decode(bytes.slice(0, 1000)).trim();
  if (!text) return 'GPT-SoVITS 返回了文本响应而不是音频。';
  return `GPT-SoVITS 返回了非音频响应：${text.slice(0, 300)}`;
}

function firstNonWhitespaceByte(bytes: Uint8Array): number | undefined {
  for (const byte of bytes.slice(0, 64)) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
  }
  return undefined;
}

function hasAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = '';
  for (let index = start; index < end && index < bytes.byteLength; index += 1) {
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}
