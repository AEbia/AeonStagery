import { describe, it, expect, vi } from 'vitest';
import { ValidationStore } from '../ui/store/ValidationStore';
import type { ValidationIssue } from '../api/types/validation';

describe('ValidationStore', () => {
  it('initializes with default empty values', () => {
    const store = new ValidationStore();
    expect(store.issues).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.errorsCount).toBe(0);
    expect(store.warningsCount).toBe(0);
  });

  it('updates issues, counts, maps and notifies listeners', () => {
    const store = new ValidationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const issues: ValidationIssue[] = [
      { actionId: 'a1', severity: 'error', message: 'First error' },
      { actionId: 'a1', severity: 'warning', message: 'First warning' },
      { actionId: 'a2', severity: 'warning', message: 'Second warning' },
    ];

    store._setIssues(issues);

    expect(store.issues).toBe(issues);
    expect(store.errorsCount).toBe(1);
    expect(store.warningsCount).toBe(2);

    // O(1) APIs
    expect(store.getSeverityByActionId('a1')).toBe('error'); // Error has precedence
    expect(store.getSeverityByActionId('a2')).toBe('warning');
    expect(store.getSeverityByActionId('a3')).toBeNull();

    expect(store.getIssueMessageByActionId('a1')).toBe('[错误] First error\n[警告] First warning');
    expect(store.getIssueMessageByActionId('a2')).toBe('[警告] Second warning');
    expect(store.getIssueMessageByActionId('a3')).toBeNull();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('updates loading and notifies listeners', () => {
    const store = new ValidationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store._setLoading(true);
    expect(store.loading).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    store._setLoading(true); // duplicate, no notify
    expect(listener).toHaveBeenCalledTimes(1);

    store._setLoading(false);
    expect(store.loading).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('allows unsubscribing', () => {
    const store = new ValidationStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store._setLoading(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store._setLoading(false);
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });
});
