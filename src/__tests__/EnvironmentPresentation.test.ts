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

  it('displays layer IDs even when authored labels and resource names are present', () => {
    const layers = collectEnvironmentLayerPresentations(scene);
    expect(layers.get('background')?.displayLabel).toBe('background');
    expect(layers.get('fog')?.displayLabel).toBe('fog');
    expect(layers.get('back-wall')?.displayLabel).toBe('back-wall');
    expect(layers.get('fog')?.sourceFile).toBe('fog.png');
  });

  it('keeps IDs stable through transforms and resource names that match', () => {
    const layers = collectEnvironmentLayerPresentations({ ...scene, timeline: [
      { _id: 'a', action: 'setEnvironmentLayer', params: { layerId: 'a', file: 'day/fog.png' } },
      { _id: 'b', action: 'setEnvironmentLayer', params: { layerId: 'b', file: 'night/fog.png' } },
      { _id: 'move', action: 'transformEnvironmentLayer', params: { layerId: 'a', x: 0.5 } },
      { _id: 'win', action: 'setEnvironmentLayer', params: { layerId: 'win', image: 'assets\\trees.png' } },
    ] });
    expect(layers.get('a')?.displayLabel).toBe('a');
    expect(layers.get('b')?.displayLabel).toBe('b');
    expect(layers.get('win')?.displayLabel).toBe('win');
  });

  it('maps environment tracks to a shared presentation kind', () => {
    expect(getEnvironmentTrackKind('environment')).toBe('environment');
    expect(getEnvironmentTrackKind('env:background')).toBe('background');
    expect(getEnvironmentTrackKind('env:fog')).toBe('environment');
    expect(getEnvironmentTrackKind('char:1')).toBe('character');
  });
});
