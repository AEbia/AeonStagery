export type SignatureTrack = 'dialogue' | 'character' | 'camera' | 'environment' | 'audio';
export interface SignatureBlock {
  track: SignatureTrack;
  start: number;
  length: number;
}
export const SIGNATURE_TRACKS: readonly SignatureTrack[] = ['dialogue', 'character', 'camera', 'environment', 'audio'];

/** FNV-1a + mulberry32: a stable timeline fingerprint, independent of runtime state. */
export function buildStageSignature(seed: string, blocksPerTrack = 5): SignatureBlock[] {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193);
  }
  const random = () => {
    hash = (hash + 0x6d2b79f5) | 0;
    let value = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const count = Number.isFinite(blocksPerTrack) ? Math.max(0, Math.floor(blocksPerTrack)) : 5;
  return SIGNATURE_TRACKS.flatMap((track) => Array.from({ length: count }, (_, index) => {
    const slot = 100 / count;
    const start = index * slot + random() * slot * 0.25;
    return { track, start, length: Math.min((index + 1) * slot - start, slot * (0.25 + random() * 0.55)) };
  }));
}
