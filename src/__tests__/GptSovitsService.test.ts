import { describe, expect, it, vi } from 'vitest';
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
} from '../services/voice/GptSovitsService';
import type { GptSovitsVoicePreset } from '../services/voice/GptSovitsTypes';

const preset: GptSovitsVoicePreset = {
  id: 'tomori',
  name: 'Tomori',
  gptWeightsPath: 'D:/models/tomori-gpt.ckpt',
  sovitsWeightsPath: 'D:/models/tomori-sovits.pth',
  refAudioPath: 'D:/refs/tomori.wav',
  promptText: '今日は歌います。',
  promptLang: 'ja',
  textLang: 'zh',
  speed: 1.1,
};

describe('GptSovitsService', () => {
  it('normalizes API config without hardcoding a local root path', () => {
    expect(normalizeGptSovitsConfig(null)).toEqual({
      apiHost: '127.0.0.1',
      apiPort: 9880,
      rootPath: '',
    });
    expect(getGptSovitsApiBaseUrl({ apiHost: 'http://localhost/', apiPort: 9000, rootPath: '' })).toBe('http://localhost:9000');
  });

  it('builds the GPT-SoVITS tts request body with wav output', () => {
    expect(createGptSovitsTtsRequestBody('你好', preset)).toMatchObject({
      text: '你好',
      text_lang: 'zh',
      ref_audio_path: 'D:/refs/tomori.wav',
      prompt_lang: 'ja',
      prompt_text: '今日は歌います。',
      media_type: 'wav',
      speed_factor: 1.1,
      streaming_mode: false,
    });
  });

  it('defaults missing GPT-SoVITS languages to Japanese for new workbench requests', () => {
    expect(createGptSovitsTtsRequestBody('こんにちは', {
      ...preset,
      promptLang: '',
      textLang: '',
    })).toMatchObject({
      text_lang: 'all_ja',
      prompt_lang: 'all_ja',
    });

    expect(createVoiceCandidateTtsRequestBody({
      config: { apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' },
      sessionId: 'session', candidateId: 'candidate', text: 'こんにちは',
      gptModelPath: 'D:/models/a.ckpt', sovitsModelPath: 'D:/models/a.pth',
      referenceAudioPath: 'D:/refs/main.wav',
      promptText: '', promptLang: '',
      options: { textLang: '', speed: 1 },
    }, 7)).toMatchObject({
      text_lang: 'all_ja',
      prompt_lang: 'all_ja',
    });
  });

  it('builds a combined weight-switch payload for fallback APIs', () => {
    expect(createGptSovitsWeightRequestBody(preset)).toEqual({
      gpt_weights_path: 'D:/models/tomori-gpt.ckpt',
      sovits_weights_path: 'D:/models/tomori-sovits.pth',
    });
  });

  it('maps the complete v2Pro workbench options to the API v2 request', () => {
    const body = createVoiceCandidateTtsRequestBody({
      config: { apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' },
      sessionId: 'session', candidateId: 'candidate', text: '你好',
      gptModelPath: 'D:/models/a.ckpt', sovitsModelPath: 'D:/models/a.pth',
      referenceAudioPath: 'D:/refs/main.wav', auxiliaryReferenceAudioPaths: ['D:/refs/aux.wav'],
      promptText: '', promptLang: 'all_zh',
      options: {
        textLang: 'all_zh', speed: 1.1, topK: 15, topP: 0.8, temperature: 0.9,
        textSplitMethod: 'cut2', batchSize: 4, batchThreshold: 0.6, splitBucket: false,
        fragmentInterval: 0.2, parallelInfer: false, repetitionPenalty: 1.2,
        sampleSteps: 16, superSampling: true,
      },
    }, 42);

    expect(body).toMatchObject({
      text: '你好', text_lang: 'all_zh', ref_audio_path: 'D:/refs/main.wav',
      aux_ref_audio_paths: ['D:/refs/aux.wav'], prompt_text: '', prompt_lang: 'all_zh',
      top_k: 15, top_p: 0.8, temperature: 0.9, text_split_method: 'cut2',
      batch_size: 4, batch_threshold: 0.6, split_bucket: false, speed_factor: 1.1,
      fragment_interval: 0.2, seed: 42, parallel_infer: false,
      repetition_penalty: 1.2, sample_steps: 16, super_sampling: true,
      media_type: 'wav', streaming_mode: false,
    });
  });

  it('validates missing root, text, project, and preset inputs before generation', () => {
    expect(validateGptSovitsGenerationInput({
      config: { apiHost: '127.0.0.1', apiPort: 9880, rootPath: '' },
      preset,
      text: '你好',
      projectRootPath: 'D:/project',
      sceneId: 'main',
      actionId: 'a1',
    })).toContain('根目录');
    expect(validateGptSovitsGenerationInput({
      config: { apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' },
      preset,
      text: '',
      projectRootPath: 'D:/project',
      sceneId: 'main',
      actionId: 'a1',
    })).toContain('没有文本');
    expect(validateGptSovitsGenerationInput({
      config: { apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' },
      preset: { ...preset, refAudioPath: '' },
      text: '你好',
      projectRootPath: 'D:/project',
      sceneId: 'main',
      actionId: 'a1',
    })).toContain('参考音频');
    expect(validateGptSovitsGenerationInput({
      config: { apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' },
      preset: { ...preset, gptWeightsPath: null as any },
      text: '你好',
      projectRootPath: 'D:/project',
      sceneId: 'main',
      actionId: 'a1',
    })).toContain('GPT 权重');
  });

  it('validates GPT-SoVITS root files with clear missing-file errors', async () => {
    const exists = vi.fn(async (pathValue: string) => pathValue.endsWith('runtime/python.exe'));
    const result = await validateGptSovitsRoot('D:/GPT-SoVITS', {
      exists,
      join: (...parts: string[]) => parts.join('/'),
    });

    expect(result.valid).toBe(false);
    expect(result.pythonPath).toBe('D:/GPT-SoVITS/runtime/python.exe');
    expect(result.errors).toEqual([
      '缺少 api_v2.py。',
      '缺少 GPT-SoVITS 配置文件。',
    ]);
  });

  it('builds generated voice paths under vocal/generated', () => {
    expect(buildGeneratedVoiceRelativePath({ sceneId: 'main scene', actionId: 'dialogue/01' }, 123)).toBe('vocal/generated/main-scene-dialogue-01-123.wav');
  });

  it('keeps generated voice output inside the current project root', async () => {
    const path = await import('node:path');

    expect(ensureGeneratedVoicePathInsideProject('D:/project', 'vocal/generated/a.wav', path.win32)).toEqual({
      ok: true,
      absolutePath: 'D:\\project\\vocal\\generated\\a.wav',
    });
    expect(ensureGeneratedVoicePathInsideProject('D:/project', '../outside.wav', path.win32)).toEqual({
      ok: false,
      error: '生成语音路径超出当前项目目录，已取消写入。',
    });
    expect(ensureGeneratedVoicePathInsideProject('D:/project', 'D:/elsewhere/a.wav', path.win32)).toEqual({
      ok: false,
      error: '生成语音路径超出当前项目目录，已取消写入。',
    });
    expect(ensureGeneratedVoicePathInsideProject('D:/project', '..cache/a.wav', path.win32)).toEqual({
      ok: true,
      absolutePath: 'D:\\project\\..cache\\a.wav',
    });
  });

  it('normalizes stream-style WAV responses before writing candidates', () => {
    const wav = createTestWav({ dataBytes: 32000, riffSize: 0xffffffff, dataSize: 0xffffffff });
    const result = normalizeGptSovitsAudioResponse(wav, 'audio/wav');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    expect(result.durationSeconds).toBe(1);
    expect(view.getUint32(4, true)).toBe(result.bytes.byteLength - 8);
    expect(view.getUint32(40, true)).toBe(32000);
  });

  it('rejects empty or non-audio GPT-SoVITS responses instead of saving 0s files', () => {
    expect(normalizeGptSovitsAudioResponse(new Uint8Array(), 'audio/wav')).toEqual({
      ok: false,
      error: 'GPT-SoVITS 返回了空音频。',
    });

    const emptyWav = normalizeGptSovitsAudioResponse(createTestWav({ dataBytes: 0 }), 'audio/wav');
    expect(emptyWav).toEqual({
      ok: false,
      error: 'GPT-SoVITS 返回了 0s WAV 音频，请检查参考音频、prompt 文本和模型组合。',
    });

    const json = new TextEncoder().encode('{"message":"no audio"}');
    expect(normalizeGptSovitsAudioResponse(json, 'application/json')).toEqual({
      ok: false,
      error: 'GPT-SoVITS 返回了非音频响应：{"message":"no audio"}',
    });
  });
});

function createTestWav({
  dataBytes,
  riffSize,
  dataSize,
}: {
  dataBytes: number;
  riffSize?: number;
  dataSize?: number;
}): Uint8Array {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, riffSize ?? (36 + dataBytes), true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataSize ?? dataBytes, true);
  bytes.fill(1, 44);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
