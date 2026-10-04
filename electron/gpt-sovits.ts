import { ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  GptSovitsGenerateDialogueVoiceRequest,
  GptSovitsLocalConfig,
  GptSovitsStartResult,
  GptSovitsStatusResult,
  GptSovitsStopResult,
} from '../src/services/voice/GptSovitsTypes';
import type { GenerateVoiceCandidateRequest, VoiceCandidateResult } from '../src/services/voice/VoiceAuthoringTypes';
import { replaceFileWithPlatformCompatibility } from './file-replacement';
import { getWorkbenchRoot } from './voice-authoring';
import {
  buildGeneratedVoiceRelativePath,
  createGptSovitsTtsRequestBody,
  createGptSovitsWeightRequestBody,
  createVoiceCandidateTtsRequestBody,
  ensureGeneratedVoicePathInsideProject,
  getGptSovitsApiBaseUrl,
  normalizeGptSovitsAudioResponse,
  normalizeGptSovitsConfig,
  validateGptSovitsGenerationInput,
  validateGptSovitsRoot,
} from '../src/services/voice/GptSovitsService';

let activeProcess: ChildProcessWithoutNullStreams | null = null;
let processState: GptSovitsStatusResult['state'] = 'stopped';
let activeLaunchKey = '';
let activeGeneration: Promise<VoiceCandidateResult> | null = null;
const logBuffer: string[] = [];

export function registerGptSovitsHandlers(): void {
  ipcMain.handle('gptSovits:status', async (_event, config: Partial<GptSovitsLocalConfig>): Promise<GptSovitsStatusResult> => {
    return getStatus(config);
  });

  ipcMain.handle('gptSovits:start', async (_event, config: Partial<GptSovitsLocalConfig>): Promise<GptSovitsStartResult> => {
    const normalized = normalizeGptSovitsConfig(config);
    const validation = await validateGptSovitsRoot(normalized.rootPath, createNodeFsPort());
    if (!validation.valid || !validation.pythonPath || !validation.apiScriptPath) {
      processState = 'not-configured';
      return {
        success: false,
        state: 'not-configured',
        configured: false,
        apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
        logs: [...logBuffer],
        error: validation.errors.join(' '),
      };
    }

    if (activeProcess && !activeProcess.killed) {
      const nextLaunchKey = getLaunchKey(normalized);
      if (activeLaunchKey && activeLaunchKey !== nextLaunchKey) {
        return {
          success: false,
          state: processState,
          configured: true,
          apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
          pid: activeProcess.pid,
          logs: [...logBuffer],
          error: '已有 GPT-SoVITS API 进程在运行。请先停止当前 API，再用新的配置启动。',
        };
      }
      const status = await getStatus(normalized);
      return { ...status, success: true, state: status.state === 'running' ? 'running' : processState };
    }

    processState = 'starting';
    pushLog(`Starting GPT-SoVITS API: ${validation.pythonPath} ${validation.apiScriptPath} -a ${normalized.apiHost} -p ${normalized.apiPort}`);
    activeProcess = spawn(validation.pythonPath, [
      validation.apiScriptPath,
      '-a',
      normalized.apiHost,
      '-p',
      String(normalized.apiPort),
    ], {
      cwd: normalized.rootPath,
      windowsHide: true,
    });
    activeLaunchKey = getLaunchKey(normalized);

    activeProcess.stdout.on('data', (chunk) => pushLog(String(chunk)));
    activeProcess.stderr.on('data', (chunk) => pushLog(String(chunk)));
    activeProcess.on('exit', (code, signal) => {
      pushLog(`GPT-SoVITS API exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      activeProcess = null;
      activeLaunchKey = '';
      processState = 'stopped';
    });
    activeProcess.on('error', (error) => {
      pushLog(`GPT-SoVITS API failed: ${error.message}`);
      processState = 'error';
    });

    return {
      success: true,
      state: processState,
      configured: true,
      apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
      pid: activeProcess.pid,
      logs: [...logBuffer],
    };
  });

  ipcMain.handle('gptSovits:stop', async (): Promise<GptSovitsStopResult> => stopGptSovitsProcess());

  ipcMain.handle('gptSovits:generateDialogueVoice', async (_event, input: GptSovitsGenerateDialogueVoiceRequest) => {
    try {
      const validationError = validateGptSovitsGenerationInput(input);
      if (validationError) return { success: false, error: validationError };

      const normalizedConfig = normalizeGptSovitsConfig(input.config);
      const rootValidation = await validateGptSovitsRoot(normalizedConfig.rootPath, createNodeFsPort());
      if (!rootValidation.valid) {
        return { success: false, error: rootValidation.errors.join(' ') };
      }

      const apiBaseUrl = getGptSovitsApiBaseUrl(normalizedConfig);
      const status = await pingApi(apiBaseUrl);
      if (!status.ok) {
        processState = 'unreachable';
        return { success: false, error: `GPT-SoVITS API 不可用：${status.error}` };
      }

      const weightResult = await switchWeights(apiBaseUrl, input.preset);
      if (!weightResult.ok) {
        return { success: false, error: weightResult.error };
      }

      const ttsResult = await fetch(`${apiBaseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createGptSovitsTtsRequestBody(input.text, input.preset)),
      });
      if (!ttsResult.ok) {
        return { success: false, error: `GPT-SoVITS /tts 失败：${ttsResult.status} ${await safeResponseText(ttsResult)}` };
      }

      const rawBytes = Buffer.from(await ttsResult.arrayBuffer());
      const audio = normalizeGptSovitsAudioResponse(rawBytes, ttsResult.headers.get('content-type') ?? '');
      if (!audio.ok) return { success: false, error: audio.error };
      const bytes = Buffer.from(audio.bytes);
      const relativePath = buildGeneratedVoiceRelativePath(input);
      const generatedPath = ensureGeneratedVoicePathInsideProject(input.projectRootPath, relativePath, path);
      if (!generatedPath.ok) {
        return { success: false, error: generatedPath.error };
      }
      const absolutePath = generatedPath.absolutePath;
      const tempPath = `${absolutePath}.tmp`;
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      try {
        await fs.promises.writeFile(tempPath, bytes);
        await replaceFileWithPlatformCompatibility(tempPath, absolutePath);
      } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      return {
        success: true,
        relativePath: relativePath.replace(/\\/g, '/'),
        absolutePath,
      };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('voiceAuthoring:generateCandidate', async (_event, input: GenerateVoiceCandidateRequest): Promise<VoiceCandidateResult> => {
    if (activeGeneration) return { success: false, error: '已有语音生成任务正在执行，请等待完成。' };
    activeGeneration = generateCandidate(input);
    try {
      return await activeGeneration;
    } finally {
      activeGeneration = null;
    }
  });
}

async function generateCandidate(input: GenerateVoiceCandidateRequest): Promise<VoiceCandidateResult> {
  try {
    const normalized = normalizeGptSovitsConfig(input.config);
    if (!input.text?.trim()) throw new Error('生成文本不能为空。');
    if (!input.gptModelPath || !input.sovitsModelPath || !input.referenceAudioPath) throw new Error('模型与主参考音频必须完整选择。');
    const rootValidation = await validateGptSovitsRoot(normalized.rootPath, createNodeFsPort());
    if (!rootValidation.valid) throw new Error(rootValidation.errors.join(' '));
    const apiBaseUrl = getGptSovitsApiBaseUrl(normalized);
    let ping = await pingApi(apiBaseUrl);
    if (!ping.ok) {
      if (!activeProcess && rootValidation.pythonPath && rootValidation.apiScriptPath) {
        launchGptSovitsProcess(normalized, rootValidation.pythonPath, rootValidation.apiScriptPath);
      }
      ping = await waitForApi(apiBaseUrl, 15000);
      if (!ping.ok) throw new Error(`GPT-SoVITS API 不可用：${ping.error}`);
    }

    const preset = {
      id: 'workbench',
      name: 'workbench',
      gptWeightsPath: input.gptModelPath,
      sovitsWeightsPath: input.sovitsModelPath,
      refAudioPath: input.referenceAudioPath,
      promptText: input.promptText,
      promptLang: input.promptLang,
      textLang: input.options.textLang,
      speed: input.options.speed,
    };
    const weightResult = await switchWeights(apiBaseUrl, preset);
    if (!weightResult.ok) throw new Error(weightResult.error);
    const requestedSeed = input.options.seed;
    const seed = Number.isInteger(requestedSeed) && requestedSeed! >= 0
      ? requestedSeed!
      : Math.floor(Math.random() * 2147483646) + 1;
    const response = await fetch(`${apiBaseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createVoiceCandidateTtsRequestBody(input, seed)),
    });
    if (!response.ok) throw new Error(`GPT-SoVITS /tts 失败：${response.status} ${await safeResponseText(response)}`);
    const rawBytes = Buffer.from(await response.arrayBuffer());
    const audio = normalizeGptSovitsAudioResponse(rawBytes, response.headers.get('content-type') ?? '');
    if (!audio.ok) throw new Error(audio.error);
    const bytes = Buffer.from(audio.bytes);
    const durationSeconds = audio.durationSeconds;
    const sessionId = sanitizeCacheToken(input.sessionId);
    const candidateId = sanitizeCacheToken(input.candidateId);
    const sessionRoot = path.join(getWorkbenchRoot(), sessionId);
    const absolutePath = path.join(sessionRoot, `${candidateId}.wav`);
    const relative = path.relative(path.resolve(getWorkbenchRoot()), path.resolve(absolutePath));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('候选缓存路径无效。');
    await fs.promises.mkdir(sessionRoot, { recursive: true });
    const tempPath = `${absolutePath}.tmp`;
    await fs.promises.writeFile(tempPath, bytes);
    await replaceFileWithPlatformCompatibility(tempPath, absolutePath);
    await fs.promises.writeFile(path.join(sessionRoot, `${candidateId}.json`), JSON.stringify({
      candidateId,
      createdAt: new Date().toISOString(),
      input: { ...input, config: { ...input.config, rootPath: input.config.rootPath } },
      seed,
      byteLength: bytes.byteLength,
      durationSeconds,
    }, null, 2), 'utf8');
    return { success: true, candidateId, absolutePath, seed, byteLength: bytes.byteLength, durationSeconds };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

function launchGptSovitsProcess(config: GptSovitsLocalConfig, pythonPath: string, apiScriptPath: string): void {
  processState = 'starting';
  activeProcess = spawn(pythonPath, [apiScriptPath, '-a', config.apiHost, '-p', String(config.apiPort)], {
    cwd: config.rootPath,
    windowsHide: true,
  });
  activeLaunchKey = getLaunchKey(config);
  activeProcess.stdout.on('data', (chunk) => pushLog(String(chunk)));
  activeProcess.stderr.on('data', (chunk) => pushLog(String(chunk)));
  activeProcess.on('exit', (code, signal) => {
    pushLog(`GPT-SoVITS API exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    activeProcess = null;
    activeLaunchKey = '';
    processState = 'stopped';
  });
  activeProcess.on('error', (error) => {
    pushLog(`GPT-SoVITS API failed: ${error.message}`);
    processState = 'error';
  });
}

async function waitForApi(apiBaseUrl: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '启动超时。';
  while (Date.now() < deadline) {
    const result = await pingApi(apiBaseUrl);
    if (result.ok) return result;
    lastError = result.error;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { ok: false, error: lastError };
}

function sanitizeCacheToken(value: string): string {
  const clean = value?.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!clean) throw new Error('候选缓存 ID 无效。');
  return clean;
}

export function stopGptSovitsProcess(reason = 'Stopping GPT-SoVITS API.'): GptSovitsStopResult {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill();
    pushLog(reason);
  }
  activeProcess = null;
  activeLaunchKey = '';
  processState = 'stopped';
  return { success: true, state: 'stopped', logs: [...logBuffer] };
}

async function getStatus(config: Partial<GptSovitsLocalConfig>): Promise<GptSovitsStatusResult> {
  const normalized = normalizeGptSovitsConfig(config);
  const configured = !!normalized.rootPath;
  if (!configured) {
    return {
      success: false,
      state: 'not-configured',
      configured: false,
      apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
      logs: [...logBuffer],
      error: '请先配置 GPT-SoVITS 根目录。',
    };
  }
  const validation = await validateGptSovitsRoot(normalized.rootPath, createNodeFsPort());
  if (!validation.valid) {
    return {
      success: false,
      state: 'not-configured',
      configured: false,
      apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
      logs: [...logBuffer],
      error: validation.errors.join(' '),
    };
  }
  const ping = await pingApi(getGptSovitsApiBaseUrl(normalized));
  if (ping.ok) {
    processState = 'running';
    return {
      success: true,
      state: 'running',
      configured: true,
      apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
      pid: activeProcess?.pid,
      logs: [...logBuffer],
    };
  }
  return {
    success: false,
    state: activeProcess ? processState : 'unreachable',
    configured: true,
    apiBaseUrl: getGptSovitsApiBaseUrl(normalized),
    pid: activeProcess?.pid,
    logs: [...logBuffer],
    error: ping.error,
  };
}

async function pingApi(apiBaseUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${apiBaseUrl}/`, { method: 'GET' });
    if (response.ok || response.status === 404 || response.status === 405) return { ok: true };
    return { ok: false, error: `${response.status} ${await safeResponseText(response)}` };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function switchWeights(apiBaseUrl: string, preset: GptSovitsGenerateDialogueVoiceRequest['preset']): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = createGptSovitsWeightRequestBody(preset);
  const gptResult = await requestEndpointVariants(apiBaseUrl, '/set_gpt_weights', [
    { weights_path: preset.gptWeightsPath },
    { gpt_weights_path: preset.gptWeightsPath },
  ]);
  const sovitsResult = await requestEndpointVariants(apiBaseUrl, '/set_sovits_weights', [
    { weights_path: preset.sovitsWeightsPath },
    { sovits_weights_path: preset.sovitsWeightsPath },
  ]);
  if (gptResult.ok && sovitsResult.ok) {
    return { ok: true };
  }

  const combinedResult = await requestEndpointVariants(apiBaseUrl, '/set_weights', [body]);
  if (combinedResult.ok) return { ok: true };

  return {
    ok: false,
    error: `权重切换失败：GPT=${formatEndpointResult(gptResult)}; SoVITS=${formatEndpointResult(sovitsResult)}; combined=${formatEndpointResult(combinedResult)}`,
  };
}

function formatEndpointResult(result: { ok: true } | { ok: false; error: string }): string {
  return result.ok ? 'ok' : result.error;
}

async function requestEndpointVariants(apiBaseUrl: string, endpoint: string, bodies: Array<Record<string, unknown>>): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const body of bodies) {
    const postResult = await requestJson(`${apiBaseUrl}${endpoint}`, body);
    if (postResult.ok) return { ok: true };
    errors.push(`POST ${endpoint}: ${postResult.error}`);

    const query = new URLSearchParams();
    Object.entries(body).forEach(([key, value]) => query.set(key, String(value)));
    const getResult = await requestGet(`${apiBaseUrl}${endpoint}?${query.toString()}`);
    if (getResult.ok) return { ok: true };
    errors.push(`GET ${endpoint}: ${getResult.error}`);
  }
  return { ok: false, error: errors.join(' | ') };
}

async function requestJson(url: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    return { ok: false, error: `${response.status} ${await safeResponseText(response)}` };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function requestGet(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (response.ok) return { ok: true };
    return { ok: false, error: `${response.status} ${await safeResponseText(response)}` };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return '';
  }
}

function createNodeFsPort() {
  return {
    exists: (pathValue: string) => fs.existsSync(pathValue),
    join: (...parts: string[]) => path.join(...parts),
  };
}

function getLaunchKey(config: GptSovitsLocalConfig): string {
  return `${config.rootPath}|${config.apiHost}|${config.apiPort}`;
}

function pushLog(message: string): void {
  const clean = message.replace(/\s+$/g, '');
  if (!clean) return;
  logBuffer.push(clean.length > 1000 ? `${clean.slice(0, 1000)}...[truncated]` : clean);
  while (logBuffer.length > 80) logBuffer.shift();
}
