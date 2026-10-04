import { describe, expect, it, vi } from 'vitest';
import { SnapshotStore } from '../engine/SnapshotStore';
import type { ModelSnapshot } from '../engine/Live2DConfig';

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: {
    get: vi.fn((key: string) => {
      const values: Record<string, number> = {
        snapshotMaxCount: 5000,
      };
      return values[key];
    }),
  },
}));

function snapshot(params: number[], motionKey?: string): ModelSnapshot {
  return {
    params: new Float32Array(params),
    opacities: new Float32Array([1]),
    motion: motionKey ? { key: motionKey, startTime: 10 } : undefined,
  };
}

describe('SnapshotStore', () => {
  it('does not let an active-motion default pose snapshot overwrite a valid pose', () => {
    const store = new SnapshotStore();
    store.insert(10, new Map([['char1', snapshot([1, 2, 3], 'angry01')]]));

    store.insert(10.005, new Map([['char1', snapshot([0, 0, 0], 'angry01')]]));

    const cached = store.findBefore(10.005);
    expect(cached?.time).toBe(10);
    expect(Array.from(cached!.models.get('char1')!.params)).toEqual([1, 2, 3]);
  });

  it('filters polluted active-motion snapshots when merging prebake results', () => {
    const store = new SnapshotStore();

    const merged = store.mergeFrom([
      { time: 10, models: new Map([['char1', snapshot([0, 0, 0], 'cry02')]]) },
      { time: 10.1, models: new Map([['char1', snapshot([4, 5, 6], 'cry02')]]) },
    ]);

    expect(merged).toBe(1);
    expect(store.size).toBe(1);
    const cached = store.findBefore(10.1);
    expect(cached?.time).toBe(10.1);
    expect(Array.from(cached!.models.get('char1')!.params)).toEqual([4, 5, 6]);
  });
});
