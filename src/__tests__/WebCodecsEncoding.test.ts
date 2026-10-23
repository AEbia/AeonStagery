import { afterEach, describe, expect, it, vi } from 'vitest';
import { EncodedVideoStreamWriter, resolveNativeEncoderConfig } from '../engine/export/WebCodecsEncoding';
import { installMockExportEncoder, MockExportEncoder } from './helpers/MockExportEncoder';

function chunk(bytes: number[], timestamp = 0): EncodedVideoChunk {
  return { type: 'key', timestamp, duration: null, byteLength: bytes.length,
    copyTo(destination) {
      const output = ArrayBuffer.isView(destination) ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength) : new Uint8Array(destination);
      output.set(bytes);
    } };
}

afterEach(() => vi.unstubAllGlobals());

describe('native WebCodecs streams', () => {
  it.each([
    ['libx264', 'avc1.'], ['libx265', 'hvc1.'], ['libvpx-vp9', 'vp09.'], ['libaom-av1', 'av01.'],
  ] as const)('requests the selected standard for %s', async (encoder, prefix) => {
    installMockExportEncoder();
    const config = await resolveNativeEncoderConfig({ width: 1920, height: 1080, fps: 30, bitrate: 12e6, outputPath: '/out', codec: encoder, isEncoded: true });
    expect(config.codec.startsWith(prefix)).toBe(true);
    expect(config.latencyMode).toBe('quality');
    expect(MockExportEncoder.isConfigSupported).toHaveBeenCalled();
  });

  it('does not start an unsupported native configuration', async () => {
    installMockExportEncoder();
    MockExportEncoder.supports = () => false;
    await expect(resolveNativeEncoderConfig({ width: 1920, height: 1080, fps: 60, bitrate: 12e6, outputPath: '/out', codec: 'libx265', isEncoded: true })).rejects.toThrow('WebCodecs');
  });

  it.each([['vp9', 'VP90'], ['av1', 'AV01']] as const)('writes %s IVF with a rational timebase and unmodified frame payloads', (codec, fourcc) => {
    const writer = new EncodedVideoStreamWriter(codec, 3840, 2160, 30000 / 1001);
    const first = writer.write(chunk([1, 2, 3]));
    const second = writer.write(chunk([4, 5], Math.round(1e6 * 1001 / 30000)));
    const header = new DataView(first.buffer);
    expect(new TextDecoder().decode(first.subarray(0, 4))).toBe('DKIF');
    expect(new TextDecoder().decode(first.subarray(8, 12))).toBe(fourcc);
    expect(header.getUint16(12, true)).toBe(3840);
    expect(header.getUint16(14, true)).toBe(2160);
    expect(header.getUint32(16, true) / header.getUint32(20, true)).toBeCloseTo(30000 / 1001, 6);
    expect([...first.subarray(44)]).toEqual([1, 2, 3]);
    expect(new DataView(second.buffer).getBigUint64(4, true)).toBe(1n);
    expect([...second.subarray(12)]).toEqual([4, 5]);
  });

  it('converts HEVC decoder configuration and length-prefixed NALs to Annex B', () => {
    const writer = new EncodedVideoStreamWriter('hevc', 1920, 1080, 30);
    const description = new Uint8Array(31);
    description[21] = 3; description[22] = 1;
    description.set([32, 0, 1, 0, 3, 0x40, 1, 2], 23);
    const output = writer.write(chunk([0, 0, 0, 2, 0x26, 1]), { decoderConfig: { codec: 'hvc1.1.6.L120.B0', description } });
    expect([...output]).toEqual([0, 0, 0, 1, 0x40, 1, 2, 0, 0, 0, 1, 0x26, 1]);
  });

  it('rejects a missing or reordered frame instead of silently inventing its timestamp', () => {
    const writer = new EncodedVideoStreamWriter('h264', 1920, 1080, 60);
    writer.write(chunk([0, 0, 1, 0x65]));
    expect(() => writer.write(chunk([0, 0, 1, 0x65], 50000))).toThrow('时间戳');
  });
});
