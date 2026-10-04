import { describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const textLayerMocks = vi.hoisted(() => ({
  addLayer: vi.fn(),
  transformLayer: vi.fn(),
  removeLayer: vi.fn(),
}));

vi.mock('../engine/TextLayerManager', () => ({
  textLayerManager: textLayerMocks,
}));

import { actionSchedulers } from '../engine/actions';

describe('text layer action schedulers', () => {
  it('adds a text layer at its authored time with the layer parameters', () => {
    const layerTimeline = gsap.timeline().to({}, { duration: 0.6 });
    textLayerMocks.addLayer.mockReturnValue(layerTimeline);
    const timeline = gsap.timeline({ paused: true });
    const params = {
      id: 'caption',
      text: 'A quiet room',
      position: [0.5, 0.8],
      fontSize: 42,
      opacity: 0.9,
      duration: 0.6,
    };

    actionSchedulers.addTextLayer({
      tl: timeline,
    } as any, {
      time: 1.25,
      action: 'addTextLayer',
      _id: 'text-add-1',
      params,
    });

    expect(textLayerMocks.addLayer).toHaveBeenCalledWith(params);
    expect(timeline.duration()).toBeCloseTo(1.85, 6);
  });

  it('transforms an existing text layer at its authored time', () => {
    const layerTimeline = gsap.timeline().to({}, { duration: 0.5 });
    textLayerMocks.transformLayer.mockReturnValue(layerTimeline);
    const timeline = gsap.timeline({ paused: true });
    const params = {
      id: 'caption',
      position: [0.4, 0.7],
      scale: 1.1,
      opacity: 0.6,
      duration: 0.5,
      ease: 'power2.out',
    };

    actionSchedulers.transformTextLayer({
      tl: timeline,
    } as any, {
      time: 2,
      action: 'transformTextLayer',
      _id: 'text-transform-1',
      params,
    });

    expect(textLayerMocks.transformLayer).toHaveBeenCalledWith(params);
    expect(timeline.duration()).toBeCloseTo(2.5, 6);
  });

  it('removes a text layer with its authored transition duration', () => {
    const layerTimeline = gsap.timeline().to({}, { duration: 0.35 });
    textLayerMocks.removeLayer.mockReturnValue(layerTimeline);
    const timeline = gsap.timeline({ paused: true });

    actionSchedulers.removeTextLayer({
      tl: timeline,
    } as any, {
      time: 0.75,
      action: 'removeTextLayer',
      _id: 'text-remove-1',
      params: { id: 'caption', duration: 0.35 },
    });

    expect(textLayerMocks.removeLayer).toHaveBeenCalledWith('caption', 0.35);
    expect(timeline.duration()).toBeCloseTo(1.1, 6);
  });
});
