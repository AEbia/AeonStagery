import { describe, it, expect, beforeEach } from 'vitest';
import { getLogger, getLogBreadcrumbs, clearLogBreadcrumbs } from '../engine/Logger';

describe('Logger Breadcrumbs Ring Buffer', () => {
  beforeEach(() => {
    clearLogBreadcrumbs();
  });

  it('captures logs into the breadcrumb ring buffer', () => {
    const logger = getLogger('TestContext');
    logger.info('User opened scene');
    logger.warn('Resource warning', { assetId: 'bg-01' });

    const breadcrumbs = getLogBreadcrumbs();
    expect(breadcrumbs.length).toBe(2);
    expect(breadcrumbs[0]).toMatchObject({
      level: 'info',
      context: 'TestContext',
      message: 'User opened scene',
    });
    expect(breadcrumbs[1].level).toBe('warn');
    expect(breadcrumbs[1].context).toBe('TestContext');
    expect(breadcrumbs[1].message).toContain('Resource warning');
    expect(breadcrumbs[0].timestamp).toBeDefined();
  });

  it('limits ring buffer size to 100 entries max (FIFO drop)', () => {
    const logger = getLogger('StressContext');
    for (let i = 0; i < 120; i++) {
      logger.info(`Log message ${i}`);
    }

    const breadcrumbs = getLogBreadcrumbs();
    expect(breadcrumbs.length).toBe(100);
    // Oldest 20 dropped, first is message 20
    expect(breadcrumbs[0].message).toBe('Log message 20');
    expect(breadcrumbs[99].message).toBe('Log message 119');
  });

  it('clears breadcrumbs correctly', () => {
    const logger = getLogger('ClearTest');
    logger.error('Fatal issue');
    expect(getLogBreadcrumbs().length).toBe(1);

    clearLogBreadcrumbs();
    expect(getLogBreadcrumbs().length).toBe(0);
  });
});
