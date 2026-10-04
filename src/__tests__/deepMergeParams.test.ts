import { describe, it, expect } from 'vitest';
import { deepMergeParams } from '../ui/store/deepMergeParams';

describe('deepMergeParams', () => {
  it('merges flat keys (shallow case)', () => {
    const result = deepMergeParams(
      { move: 'push', easing: 'smooth' },
      { easing: 'accelerate' },
    );
    expect(result).toEqual({ move: 'push', easing: 'accelerate' });
  });

  it('deep-merges nested objects — preserves sibling keys', () => {
    const result = deepMergeParams(
      { focus: { character: 'tomori', part: 'head' } },
      { focus: { part: 'chest' } },
    );
    expect(result).toEqual({
      focus: { character: 'tomori', part: 'chest' },
    });
  });

  it('deep-merges three levels deep', () => {
    const result = deepMergeParams(
      { focus: { offset: { x: 0.5, y: 0.3 } } },
      { focus: { offset: { x: 0.7 } } },
    );
    expect(result).toEqual({
      focus: { offset: { x: 0.7, y: 0.3 } },
    });
  });

  it('paramsDelete removes specified keys after merge', () => {
    const result = deepMergeParams(
      { a: 1, b: 2, c: 3 },
      { b: 99 },
      ['c'],
    );
    expect(result).toEqual({ a: 1, b: 99 });
  });

  it('paramsDelete removes nested keys by path after merge', () => {
    const result = deepMergeParams(
      { focus: { character: 'tomori', part: 'head' }, easing: 'smooth' },
      { focus: { character: 'tomori' } },
      ['focus.part'],
    );
    expect(result).toEqual({
      focus: { character: 'tomori' },
      easing: 'smooth',
    });
  });

  it('params: null clears all params', () => {
    const result = deepMergeParams(
      { a: 1, b: { nested: true } },
      null,
    );
    expect(result).toEqual({});
  });

  it('does not mutate the original params object', () => {
    const original = { a: 1 };
    const patch = { b: 2 };
    const result = deepMergeParams(original, patch);
    expect(result).not.toBe(original);
    expect((original as any).b).toBeUndefined();
    expect((patch as any).a).toBeUndefined();
  });

  it('does not mutate nested original objects', () => {
    const original = { focus: { character: 'tomori' } };
    const patch = { focus: { part: 'head' } };
    deepMergeParams(original, patch);
    // original.focus should be unchanged
    expect(original.focus).toEqual({ character: 'tomori' });
    expect((original.focus as any).part).toBeUndefined();
  });

  it('replaces arrays rather than merging them', () => {
    const result = deepMergeParams(
      { keyframes: [{ time: 0, zoom: 1 }, { time: 1, zoom: 2 }] },
      { keyframes: [{ time: 3, zoom: 1.5 }] },
    );
    expect(result).toEqual({
      keyframes: [{ time: 3, zoom: 1.5 }],
    });
  });

  it('handles paramsDelete on a key that was also in the patch', () => {
    // If the same key appears in both `params` and `paramsDelete`,
    // the delete wins (patch value is discarded).
    const result = deepMergeParams(
      { a: 1, b: 2 },
      { a: 99 },
      ['a'],
    );
    expect(result).toEqual({ b: 2 });
  });

  // ── Defensive: existing is undefined or null ──

  it('treats undefined existing as empty object', () => {
    const result = deepMergeParams(
      undefined as any,
      { a: 1, b: 2 },
    );
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('treats null existing as empty object', () => {
    const result = deepMergeParams(
      null as any,
      { a: 1 },
    );
    expect(result).toEqual({ a: 1 });
  });

  it('handles undefined existing with paramsDelete', () => {
    const result = deepMergeParams(
      undefined as any,
      { a: 1, b: 2, c: 3 },
      ['b'],
    );
    expect(result).toEqual({ a: 1, c: 3 });
  });

  it('paramsDelete a non-existent key is a no-op', () => {
    const result = deepMergeParams(
      { a: 1 },
      { b: 2 },
      ['nonexistent'],
    );
    expect(result).toEqual({ a: 1, b: 2 });
  });
});
