import { describe, expect, it } from 'vitest';
import { avccToAnnexB } from '../engine/export/avccToAnnexB';

describe('AVCC to Annex B conversion', () => {
  it('converts multiple NAL units from a buffer subview without changing the source', () => {
    const source = new Uint8Array([99, 0, 0, 0, 2, 0xaa, 0xbb, 0, 0, 0, 1, 0xcc, 99]);
    expect(avccToAnnexB(source.subarray(1, -1))).toEqual(new Uint8Array([
      0, 0, 0, 1, 0xaa, 0xbb, 0, 0, 0, 1, 0xcc,
    ]));
    expect(source[4]).toBe(2);
  });

  it('prepends SPS and PPS from a decoder description subview', () => {
    const config = new Uint8Array([99, 1, 0x4d, 0, 0x2a, 0xff, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 1, 0x68, 99]);
    expect(avccToAnnexB(new Uint8Array([0, 0, 0, 1, 0xaa]), config.subarray(1, -1))).toEqual(new Uint8Array([
      0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0xaa,
    ]));
  });

  it.each([
    [0, 0, 0],
    [0, 0, 0, 3, 0xaa],
    [0xff, 0xff, 0xff, 0xff],
    [0, 0, 0, 0],
  ])('rejects incomplete or empty NAL units: %j', (...bytes) => {
    expect(() => avccToAnnexB(new Uint8Array(bytes))).toThrow();
  });
});
