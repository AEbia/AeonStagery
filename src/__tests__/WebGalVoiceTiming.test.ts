import { describe, expect, it } from 'vitest';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { sceneStatementFactory } from '../services/semantic-scene/SceneStatementFactory';
import {
  applyWebGalVoiceTiming,
  audioDurationSeconds,
  wavDurationSeconds,
  webGalVoiceCandidates,
} from '../services/import/webgal/WebGalVoiceTiming';

function buildWav(dataSize: number, sampleRate = 16000): ArrayBuffer {
  const bytesPerSecond = sampleRate * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, bytesPerSecond, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  return buffer;
}

function dialogueDocument(voice: string, durationSeconds = 3): CurrentSceneDocument {
  return sceneStatementFactory.createDocument({
    meta: {
      title: 'test',
      fps: 60,
      resolution: [1920, 1080],
      characters: [],
      markers: [],
    },
    statements: [
      { time: 0, type: 'dialogue', params: { speaker: 'Soyo', text: '浣犲ソ', durationSeconds, voice } },
      { time: 3, type: 'dialogue', params: { speaker: 'Soyo', text: '娌℃湁閰嶉煶', durationSeconds } },
    ],
  });
}

function dialogueParams(document: CurrentSceneDocument, index: number): { voice?: string; durationSeconds: number } {
  const statement = document.statements[index];
  if (statement.type !== 'dialogue') throw new Error(`expected dialogue statement at ${index}`);
  return statement.params as { voice?: string; durationSeconds: number };
}

describe('wavDurationSeconds', () => {
  it('reads the duration from a valid WAV header', () => {
    expect(wavDurationSeconds(buildWav(16000))).toBeCloseTo(0.5, 3);
  });

  it('returns null for buffers that are not RIFF/WAVE', () => {
    expect(wavDurationSeconds(new ArrayBuffer(8))).toBeNull();
    const notWav = buildWav(100);
    new Uint8Array(notWav)[0] = 0x00;
    expect(wavDurationSeconds(notWav)).toBeNull();
  });
});

describe('audioDurationSeconds', () => {
  it('uses the browser decoder for formats beyond WAV', async () => {
    const originalAudioContext = globalThis.AudioContext;
    class MockAudioContext {
      async decodeAudioData() {
        return { duration: 1.75 } as AudioBuffer;
      }

      async close() {}
    }
    globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
    try {
      await expect(audioDurationSeconds(new ArrayBuffer(4))).resolves.toBe(1.75);
    } finally {
      globalThis.AudioContext = originalAudioContext;
    }
  });
});

describe('webGalVoiceCandidates', () => {
  it('proposes figure and root fallbacks for mounted vocal references', () => {
    expect(webGalVoiceCandidates('@mount/demo/vocal/soyo/a.wav')).toEqual([
      '@mount/demo/vocal/soyo/a.wav',
      '@mount/demo/figure/soyo/a.wav',
      '@mount/demo/soyo/a.wav',
    ]);
  });

  it('proposes project-relative figure and root fallbacks', () => {
    expect(webGalVoiceCandidates('vocal/soyo/a.wav')).toEqual([
      'vocal/soyo/a.wav',
      'figure/soyo/a.wav',
      'soyo/a.wav',
    ]);
  });
});

describe('applyWebGalVoiceTiming', () => {
  const resolveTo = (map: Record<string, string>) => async (reference: string) => {
    if (!(reference in map)) throw new Error(`unexpected reference ${reference}`);
    return map[reference];
  };
  const readAudioDuration = async (fsPath: string) => {
    if (fsPath.startsWith('missing/')) return null;
    return 2;
  };

  it('re-times a dialogue with its voice duration and keeps the resolved reference', async () => {
    const document = dialogueDocument('@mount/demo/vocal/soyo/a.wav');
    const result = await applyWebGalVoiceTiming(document, {
      resolveAudio: resolveTo({ '@mount/demo/vocal/soyo/a.wav': 'M:/game/vocal/soyo/a.wav' }),
      readAudioDuration,
    });
    expect(result.timed).toBe(1);
    expect(result.missing).toBe(0);
    expect(dialogueParams(result.document, 0).voice).toBe('@mount/demo/vocal/soyo/a.wav');
    expect(dialogueParams(result.document, 0).durationSeconds).toBeCloseTo(2.5, 3);
    expect(dialogueParams(result.document, 1).durationSeconds).toBe(3);
  });

  it('falls back to the figure root and rewrites the reference', async () => {
    const document = dialogueDocument('@mount/demo/vocal/soyo/a.wav');
    const result = await applyWebGalVoiceTiming(document, {
      resolveAudio: resolveTo({ '@mount/demo/figure/soyo/a.wav': 'M:/game/figure/soyo/a.wav' }),
      readAudioDuration,
    });
    expect(dialogueParams(result.document, 0).voice).toBe('@mount/demo/figure/soyo/a.wav');
    expect(dialogueParams(result.document, 0).durationSeconds).toBeCloseTo(2.5, 3);
  });

  it('keeps the estimate and reports missing when no candidate resolves', async () => {
    const document = dialogueDocument('vocal/soyo/a.wav');
    const result = await applyWebGalVoiceTiming(document, {
      resolveAudio: resolveTo({ 'vocal/soyo/a.wav': 'missing/vocal/soyo/a.wav' }),
      readAudioDuration,
    });
    expect(result.missing).toBe(1);
    expect(result.timed).toBe(0);
    expect(dialogueParams(result.document, 0).voice).toBe('vocal/soyo/a.wav');
    expect(dialogueParams(result.document, 0).durationSeconds).toBe(3);
  });

  it('shrinks the trailing buffer when reading faster', async () => {
    const document = dialogueDocument('vocal/soyo/a.wav');
    const result = await applyWebGalVoiceTiming(document, {
      speed: 2,
      resolveAudio: resolveTo({ 'vocal/soyo/a.wav': 'M:/game/vocal/soyo/a.wav' }),
      readAudioDuration,
    });
    expect(dialogueParams(result.document, 0).durationSeconds).toBeCloseTo(2.25, 3);
  });

  it('pushes later statements forward when a voice runs longer than the estimate', async () => {
    const document = dialogueDocument('@mount/demo/vocal/soyo/a.wav');
    const result = await applyWebGalVoiceTiming(document, {
      resolveAudio: async (reference) => reference,
      readAudioDuration: async () => 10.5,
    });
    const first = result.document.statements[0];
    const second = result.document.statements[1];
    expect(dialogueParams(result.document, 0).durationSeconds).toBeCloseTo(11, 3);
    // The next line must start when the first voice ends, not at the old
    // estimate time, or the two dialogues would overlap.
    expect(second.time).toBeCloseTo(first.time + 11, 3);
  });

  it('pulls later statements back when the voice is shorter than the estimate', async () => {
    const document = dialogueDocument('@mount/demo/vocal/soyo/a.wav');
    const result = await applyWebGalVoiceTiming(document, {
      resolveAudio: async (reference) => reference,
      readAudioDuration: async () => 1.5,
    });
    expect(dialogueParams(result.document, 0).durationSeconds).toBeCloseTo(2, 3);
    expect(result.document.statements[1].time).toBeCloseTo(2, 3);
  });
});
