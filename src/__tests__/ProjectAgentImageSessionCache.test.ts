import { describe, expect, it } from 'vitest';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';

function payload(bytes: number, detail: 'auto' | 'low' | 'high', fingerprint: string) {
  return {
    mimeType: 'image/png',
    bytes: new Uint8Array(bytes),
    width: 10,
    height: 10,
    detail,
    contentFingerprint: fingerprint,
  };
}

describe('ProjectAgentImageSessionCache', () => {
  it('keeps separate entries for the same reference at different detail levels', () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', payload(3, 'auto', 'fp-1'));
    cache.set('images/bg.png', payload(4, 'high', 'fp-1'));

    const auto = cache.get('images/bg.png', 'fp-1', 'auto');
    const high = cache.get('images/bg.png', 'fp-1', 'high');
    expect(auto?.bytes).toHaveLength(3);
    expect(high?.bytes).toHaveLength(4);
    expect(auto?.detail).toBe('auto');
    expect(high?.detail).toBe('high');
  });

  it('keeps separate entries for the same reference with different content fingerprints', () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', payload(3, 'auto', 'fp-old'));
    cache.set('images/bg.png', payload(5, 'auto', 'fp-new'));

    expect(cache.get('images/bg.png', 'fp-old', 'auto')?.bytes).toHaveLength(3);
    expect(cache.get('images/bg.png', 'fp-new', 'auto')?.bytes).toHaveLength(5);
  });

  it('returns null when the requested fingerprint and detail do not match any entry', () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', payload(3, 'auto', 'fp-1'));
    expect(cache.get('images/bg.png', 'fp-stale', 'auto')).toBeNull();
    expect(cache.get('images/bg.png', 'fp-1', 'low')).toBeNull();
    expect(cache.get('images/other.png', 'fp-1', 'auto')).toBeNull();
  });

  it('resolves the matching entry and clears all entries on clear()', () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', payload(3, 'auto', 'fp-1'));
    const resolved = cache.resolve({
      reference: 'images/bg.png',
      contentFingerprint: 'fp-1',
      detail: 'auto',
    });
    expect(resolved?.bytes).toHaveLength(3);
    cache.clear();
    expect(cache.get('images/bg.png', 'fp-1', 'auto')).toBeNull();
  });
});
