import { describe, expect, it } from 'vitest';
import { ExportEtaEstimator } from '../ui/ExportEtaEstimator';

describe('ExportEtaEstimator', () => {
  it('smooths a brief progress jump instead of abruptly changing the estimate', () => {
    const estimator = new ExportEtaEstimator();
    let estimate: number | null = null;

    for (let second = 0; second <= 10; second += 1) {
      estimate = estimator.update(second * 2, second * 1000);
    }

    if (estimate === null) throw new Error('Expected an estimate after sustained progress.');
    const stableEstimate = estimate;
    const afterProgressJump = estimator.update(50, 11_000);

    if (afterProgressJump === null) throw new Error('Expected the estimate to remain available.');
    expect(afterProgressJump).toBeGreaterThan(stableEstimate * 0.75);
    expect(afterProgressJump).toBeLessThan(stableEstimate * 1.25);
  });

  it('drops a stale estimate after progress has stopped', () => {
    const estimator = new ExportEtaEstimator();

    for (let second = 0; second <= 10; second += 1) {
      estimator.update(second * 2, second * 1000);
    }

    expect(estimator.update(20, 15_000)).toBeNull();
  });
});
