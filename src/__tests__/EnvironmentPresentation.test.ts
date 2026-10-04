import { describe, expect, it } from 'vitest';
import type { TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import {
  collectEnvironmentLayerPresentations,
  getEnvironmentActionLayerId,
  getEnvironmentTrackKind,
} from '../ui/timeline/environmentPresentation';

const scene: TimelineScene = {
  sceneId: 'scene-test',
  meta: { title: 'test' },
  timeline: [
    { _id: 'a1', time: 0, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'bg.png' } },
    { _id: 'a2', time: 1, action: 'setEnvironmentLayer', params: { layerId: 'fog', label: '前景雾', image: 'fog.png' } },
    { _id: 'a3', time: 2, action: 'transformEnvironmentLayer', params: { layerId: 'fog', x: 0.4 } },
    { _id: 'a4', time: 3, action: 'setEnvironmentLayer', params: { layerId: 'back-wall', image: 'wall.png' } },
  ],
};

describe('environmentPresentation', () => {
  it('reads the canonical background layer id', () => {
    expect(getEnvironmentActionLayerId(scene.timeline[0])).toBe('background');
  });

  it('prefers authored labels and falls back to friendly environment labels', () => {
    const layers = collectEnvironmentLayerPresentations(scene);
    expect(layers.get('background')?.displayLabel).toBe('背景');
    expect(layers.get('fog')?.displayLabel).toBe('前景雾');
    expect(layers.get('back-wall')?.displayLabel).toBe('环境层 2');
  });

  it('maps environment tracks to a shared presentation kind', () => {
    expect(getEnvironmentTrackKind('environment')).toBe('environment');
    expect(getEnvironmentTrackKind('env:background')).toBe('background');
    expect(getEnvironmentTrackKind('env:fog')).toBe('environment');
    expect(getEnvironmentTrackKind('char:1')).toBe('character');
  });
});
