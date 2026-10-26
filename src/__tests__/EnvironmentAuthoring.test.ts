import { describe, expect, it } from 'vitest';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import {
  generateEnvironmentLayerId,
  resolveEnvironmentLayerSelection,
} from '../ui/timeline/environmentAuthoring';

const scene: SceneScript = {
  sceneId: 'environment-authoring',
  meta: { title: 'environment-authoring' },
  timeline: [
    { _id: 'bg', time: 0, action: 'setBackground', params: { image: 'bg.png' } },
    { _id: 'fog', time: 1, action: 'setEnvironmentLayer', params: { layerId: 'fog-bank', label: '前景雾', image: 'fog.png' } },
    { _id: 'wall', time: 2, action: 'setEnvironmentLayer', params: { layerId: 'back-wall', image: 'wall.png' } },
    { _id: 'rain', time: 3, action: 'setEnvironmentLayer', params: { layerId: 'soft-rain', label: 'Soft Rain', image: 'rain.png' } },
  ],
};

describe('environmentAuthoring', () => {
  it('resolves existing layers by ID regardless of labels or resource names', () => {
    expect(resolveEnvironmentLayerSelection(scene, 'fog-bank')).toEqual({
      layerId: 'fog-bank',
      label: '前景雾',
      isExisting: true,
    });

    expect(resolveEnvironmentLayerSelection(scene, 'back-wall')).toEqual({
      layerId: 'back-wall',
      label: undefined,
      isExisting: true,
    });
    expect(resolveEnvironmentLayerSelection(scene, '前景雾').isExisting).toBe(false);
  });

  it('generates unique ids for new author-facing names', () => {
    expect(generateEnvironmentLayerId(scene, 'Soft Rain')).toBe('soft-rain-2');
    expect(generateEnvironmentLayerId(scene, '前景光')).toBe('environment-layer-1');
  });
});
