import { describe, expect, it } from 'vitest';
import {
  classifyResourceKind,
  live2dIdentity,
  parseLive2DCapabilities,
  resourceMimeType,
  sniffAudioMetadata,
  sniffImageDimensions,
} from '../services/project-agent/ProjectAgentResourceMetadata';

function bytes(parts: Array<number | Uint8Array | string>): Uint8Array {
  const chunks = parts.map((part) => {
    if (typeof part === 'number') return Uint8Array.of(part);
    if (typeof part === 'string') return new TextEncoder().encode(part);
    return part;
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function u16be(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function u32be(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

function u32le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pngHeader(width: number, height: number): Uint8Array {
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, u32be(13), 'IHDR', u32be(width), u32be(height), 8, 6, 0, 0, 0]);
}

function jpegHeader(width: number, height: number): Uint8Array {
  return bytes([0xff, 0xd8, 0xff, 0xe0, u16be(15), 'JFIF\0', 1, 1, 0, 0, 0, 0, 0, 0, 0xff, 0xc0, u16be(17), 8, u16be(height), u16be(width), 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
}

function gifHeader(width: number, height: number): Uint8Array {
  return bytes(['GIF89a', u16le(width), u16le(height), 0x80, 0, 0]);
}

function webpLossyHeader(width: number, height: number): Uint8Array {
  return bytes(['RIFF', u32le(0), 'WEBP', 'VP8 ', u32le(10), 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f]);
}

function wavHeader(durationSeconds: number, byteRate = 88200): Uint8Array {
  const dataSize = durationSeconds * byteRate;
  return bytes([
    'RIFF', u32le(36 + dataSize), 'WAVE',
    'fmt ', u32le(16), u16le(1), u16le(1), u32le(44100), u32le(byteRate), u16le(2), u16le(16),
    'data', u32le(dataSize),
  ]);
}

describe('ProjectAgentResourceMetadata', () => {
  describe('resourceMimeType', () => {
    it('maps known resource extensions to mime types', () => {
      expect(resourceMimeType('bg/sky.png')).toBe('image/png');
      expect(resourceMimeType('figure/soyo/model.model3.json')).toBe('application/json');
      expect(resourceMimeType('bgm/song.mp3')).toBe('audio/mpeg');
      expect(resourceMimeType('vocal/line.wav')).toBe('audio/wav');
      expect(resourceMimeType('font/a.otf')).toBe('font/otf');
    });

    it('returns undefined for unknown extensions', () => {
      expect(resourceMimeType('notes/todo.txt')).toBeUndefined();
    });
  });

  describe('classifyResourceKind', () => {
    it('classifies live2d model entrypoints', () => {
      expect(classifyResourceKind('figure/soyo/school_winter-2023/model.json')).toBe('live2dModel');
      expect(classifyResourceKind('figure/soyo/school_winter-2023/model.model3.json')).toBe('live2dModel');
      expect(classifyResourceKind('figure/soyo/school_winter-2023/soyo.wmdl')).toBe('live2dModel');
    });

    it('classifies background, image, audio, font, animation and lut kinds', () => {
      expect(classifyResourceKind('background/sky.png')).toBe('background');
      expect(classifyResourceKind('images/logo.svg')).toBe('image');
      expect(classifyResourceKind('figure/soyo/tex.png')).toBe('image');
      expect(classifyResourceKind('bgm/bgm01.mp3')).toBe('bgm');
      expect(classifyResourceKind('vocal/soyo/line01.wav')).toBe('voice');
      expect(classifyResourceKind('sfx/hit.ogg')).toBe('sfx');
      expect(classifyResourceKind('fonts/a.ttf')).toBe('font');
      expect(classifyResourceKind('animation/fall.json')).toBe('animation');
      expect(classifyResourceKind('lut/warm.cube')).toBe('lut');
    });

    it('returns null for files that are not scene resources', () => {
      expect(classifyResourceKind('notes/todo.txt')).toBeNull();
      expect(classifyResourceKind('readme.md')).toBeNull();
    });
  });

  describe('live2dIdentity', () => {
    it('derives owner and outfit from figure-relative paths', () => {
      expect(live2dIdentity('figure/soyo/school_winter-2023/model.json')).toEqual({
        ownerId: 'soyo',
        outfitId: 'school_winter-2023',
      });
      expect(live2dIdentity('game/figure/anon/casual-2023/model.model3.json')).toEqual({
        ownerId: 'anon',
        outfitId: 'casual-2023',
      });
    });

    it('omits identity when the path is too shallow', () => {
      expect(live2dIdentity('figure/rana/model.json')).toEqual({});
    });
  });

  describe('sniffImageDimensions', () => {
    it('parses PNG dimensions from IHDR', () => {
      expect(sniffImageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    });

    it('parses JPEG dimensions from SOF0', () => {
      expect(sniffImageDimensions(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
    });

    it('parses GIF dimensions from the logical screen descriptor', () => {
      expect(sniffImageDimensions(gifHeader(320, 200))).toEqual({ width: 320, height: 200 });
    });

    it('parses WebP lossy dimensions', () => {
      expect(sniffImageDimensions(webpLossyHeader(800, 600))).toEqual({ width: 800, height: 600 });
    });

    it('returns null for unknown or truncated headers', () => {
      expect(sniffImageDimensions(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
      expect(sniffImageDimensions(new Uint8Array(0))).toBeNull();
    });
  });

  describe('sniffAudioMetadata', () => {
    it('derives WAV duration from the data chunk without decoding content', () => {
      const result = sniffAudioMetadata(wavHeader(10), 'audio/wav');
      expect(result).toEqual({ format: 'wav', durationSeconds: 10 });
    });

    it('returns format only when the header cannot yield a duration', () => {
      expect(sniffAudioMetadata(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg')).toEqual({ format: 'mp3' });
    });
  });

  describe('parseLive2DCapabilities', () => {
    it('parses cubism3 motions and expressions from FileReferences', () => {
      const json = JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: 'soyo.moc3',
          Motions: {
            Idle: [{ File: 'idle.motion3.json' }],
            'soyo/wave01': [{ File: 'wave.motion3.json' }],
          },
          Expressions: [
            { Name: 'sad' },
            { Name: 'happy' },
          ],
        },
      });
      const parsed = parseLive2DCapabilities(json, 'figure/soyo/model.model3.json');
      expect(parsed.motions).toEqual(['Idle', 'soyo/wave01']);
      expect(parsed.expressions).toEqual(['sad', 'happy']);
      expect(parsed.runtimeFamily).toBe('cubism3-plus');
    });

    it('parses cubism2 motions and expressions from top-level keys', () => {
      const json = JSON.stringify({
        model: 'soyo.moc',
        motions: { Idle: [{ File: 'idle.mtn' }], 'soyo/angry01': [{ File: 'angry.mtn' }] },
        expressions: [{ name: 'smile' }],
      });
      const parsed = parseLive2DCapabilities(json, 'figure/soyo/model.json');
      expect(parsed.motions).toEqual(['Idle', 'soyo/angry01']);
      expect(parsed.expressions).toEqual(['smile']);
      expect(parsed.runtimeFamily).toBe('cubism2');
    });

    it('returns empty capabilities for unreadable model content', () => {
      const parsed = parseLive2DCapabilities('not json', 'figure/soyo/model.json');
      expect(parsed.motions).toEqual([]);
      expect(parsed.expressions).toEqual([]);
      expect(parsed.runtimeFamily).toBe('unknown');
    });
  });
});
