import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POST_PROCESSING_SNAPSHOT,
  deriveLightingSnapshotAtTime,
  normalizeLightingSnapshot,
} from '../engine/LightingSnapshot';

describe('target-scoped post-processing snapshots', () => {
  it('keeps panorama and object targets in independent state channels', () => {
    const timeline = [
      {
        _id: 'panorama',
        action: 'setPostProcessing',
        time: 0,
        params: {
          target: 'panorama',
          bloomBloomScale: 0.4,
          overlayColor: '#112233',
          overlayBlendMode: 'screen',
          overlayIntensity: 0.25,
          duration: 0,
        },
      },
      {
        _id: 'hero',
        action: 'setPostProcessing',
        time: 1,
        params: {
          target: 'hero',
          adjContrast: 1.3,
          rgbSplitX: 0.2,
          overlayColor: '#abcdef',
          overlayIntensity: 0.5,
          duration: 0,
        },
      },
    ] as any;

    const snapshot = deriveLightingSnapshotAtTime(1, timeline);

    expect(snapshot.postProcessing).toMatchObject({
      bloomBloomScale: 0.4,
      overlayColor: '#112233',
      overlayBlendMode: 'screen',
      overlayIntensity: 0.25,
    });
    expect(snapshot.postProcessingTargets.hero).toMatchObject({
      adjContrast: 1.3,
      rgbSplitX: 0.2,
      overlayColor: '#abcdef',
      overlayIntensity: 0.5,
    });
  });

  it('retains a missing target state and resets only that target', () => {
    const timeline = [
      {
        _id: 'hero-set',
        action: 'setPostProcessing',
        time: 0,
        params: { target: 'hero', bloomBloomScale: 0.8, overlayIntensity: 0.6, duration: 0 },
      },
      {
        _id: 'panorama-set',
        action: 'setPostProcessing',
        time: 0,
        params: { target: 'panorama', bloomBloomScale: 0.2, duration: 0 },
      },
      {
        _id: 'hero-reset',
        action: 'resetPostProcessing',
        time: 1,
        params: { target: 'hero', duration: 0 },
      },
    ] as any;

    const snapshot = deriveLightingSnapshotAtTime(2, timeline);
    expect(snapshot.postProcessing.bloomBloomScale).toBe(0.2);
    expect(snapshot.postProcessingTargets.hero).toEqual(DEFAULT_POST_PROCESSING_SNAPSHOT);
  });

  it('normalizes integrated overlay fields while preserving legacy partial snapshots', () => {
    const snapshot = normalizeLightingSnapshot({
      preset: { name: 'normal', intensity: 0 },
      blur: { global: 0, background: 0, characters: 0 },
      postProcessing: { bloomBloomScale: 0.3 } as any,
      colorOverlays: [],
      pointLights: [],
      visualOverlay: null,
    } as any);

    expect(snapshot.postProcessing).toMatchObject({
      bloomThreshold: 0.5,
      bloomBloomScale: 0.3,
      overlayColor: '#ffffff',
      overlayBlendMode: 'multiply',
      overlayIntensity: 0,
    });
    expect(snapshot.postProcessingTargets).toEqual({});
  });
});
