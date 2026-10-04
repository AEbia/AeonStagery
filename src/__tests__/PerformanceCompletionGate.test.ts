import { describe, expect, it } from 'vitest';
import {
  assertMonotonicPerformanceCompletion,
  assertMonotonicPerformanceParams,
  isMonotonicPerformanceCompletion,
  isPerformanceFillableValue,
} from '../services/ai-authoring/performance';

describe('Performance completion gate', () => {
  it('treats empty string motion as fillable and whitespace as non-empty', () => {
    expect(isPerformanceFillableValue('')).toBe(true);
    expect(isPerformanceFillableValue(undefined)).toBe(true);
    expect(isPerformanceFillableValue(' ')).toBe(false);
    expect(isPerformanceFillableValue('wave')).toBe(false);
  });

  it('allows filling empty motion and missing lookAt leaves', () => {
    const violations = assertMonotonicPerformanceParams(
      { target: 'tomori', motion: '' },
      {
        target: 'tomori',
        motion: 'tomori/smile01',
        lookAt: { target: 'anon', intensity: 0.5 },
      },
    );
    expect(violations).toEqual([]);
  });

  it('forbids overwriting non-empty scalars and clearing them', () => {
    const overwrite = assertMonotonicPerformanceParams(
      { target: 'tomori', motion: 'tomori/smile01' },
      { target: 'tomori', motion: 'tomori/angry01' },
    );
    expect(overwrite.some((v) => v.code === 'overwrite_nonempty')).toBe(true);

    const clear = assertMonotonicPerformanceParams(
      { target: 'tomori', motion: 'tomori/smile01' },
      { target: 'tomori', motion: null },
    );
    expect(clear.some((v) => v.code === 'clear_nonempty')).toBe(true);
  });

  it('allows leaf fill on lookAt while preserving existing target', () => {
    const violations = assertMonotonicPerformanceParams(
      { target: 'tomori', lookAt: { target: 'anon' } },
      { target: 'tomori', lookAt: { target: 'anon', intensity: 0.8 } },
    );
    expect(violations).toEqual([]);
  });

  it('forbids changing immutable target identity', () => {
    const violations = assertMonotonicPerformanceParams(
      { target: 'tomori', motion: '' },
      { target: 'anon', motion: 'anon/smile01' },
    );
    expect(violations.some((v) => v.code === 'immutable_identity')).toBe(true);
  });

  it('forbids deleting existing performance statements', () => {
    const violations = assertMonotonicPerformanceCompletion({
      base: [
        {
          kind: 'companion',
          type: 'characterPerformance',
          line: 2,
          params: { target: '$speaker', motion: '' },
        },
      ],
      candidate: [],
    });
    expect(violations.some((v) => v.code === 'delete_performance_statement')).toBe(true);
  });

  it('accepts monotonic fill of an existing placeholder companion', () => {
    expect(isMonotonicPerformanceCompletion({
      base: [
        {
          kind: 'companion',
          type: 'characterPerformance',
          line: 2,
          params: { target: '$speaker', motion: '' },
        },
      ],
      candidate: [
        {
          kind: 'companion',
          type: 'characterPerformance',
          line: 2,
          params: { target: '$speaker', motion: 'tomori/smile01', priority: 1 },
        },
      ],
    })).toBe(true);
  });
});
