import { describe, expect, it } from 'vitest';
import { AiProseRequestBudget } from '../services/ai-authoring/AiProseRequestBudget';

describe('ADR-0022 shared AI request budget', () => {
  it('blocks at capacity and resumes the next request after release', async () => {
    const budget = new AiProseRequestBudget(1);
    const first = await budget.acquire();
    let secondAcquired = false;
    const secondPromise = budget.acquire().then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it('updates capacity without revoking active leases or bypassing queued waiters', async () => {
    const budget = new AiProseRequestBudget(2);
    const first = await budget.acquire();
    const second = await budget.acquire();
    let thirdAcquired = false;
    const thirdPromise = budget.acquire().then((lease) => {
      thirdAcquired = true;
      return lease;
    });

    budget.updateCapacity(1);
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    first.release();
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    second.release();
    const third = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    third.release();
  });
});
