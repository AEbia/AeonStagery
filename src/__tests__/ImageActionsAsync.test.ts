import gsap from 'gsap';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const imageActionMocks = vi.hoisted(() => ({
  registerImageAction: vi.fn(),
  beginImageRequest: vi.fn(() => 7),
  addImage: vi.fn(),
  cancelImageRequest: vi.fn(),
  reportImageError: vi.fn(),
  transformImage: vi.fn(() => gsap.timeline().to({}, { duration: 0.8 })),
  removeImage: vi.fn(() => gsap.timeline().to({}, { duration: 0.4 })),
}));

vi.mock('../engine/StageManager', () => ({ stageManager: imageActionMocks }));

import {
  scheduleAddImage,
  scheduleRemoveImage,
  scheduleTransformImage,
} from '../engine/actions/imageActions';

describe('image action scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves project or mounted references before handing the URL to StageManager', async () => {
    const resolvePathAsync = vi.fn(async (file: string) => `asset://runtime/${file}`);
    const tl = gsap.timeline({ paused: true });

    scheduleAddImage({
      tl,
      resolvePath: vi.fn(),
      resolvePathAsync,
    } as any, {
      time: 0,
      params: { id: 'poster', file: '@mount/game/poster.png', position: [0.5, 0.5] },
    });

    tl.progress(1);
    await vi.waitFor(() => expect(imageActionMocks.addImage).toHaveBeenCalled());

    expect(resolvePathAsync).toHaveBeenCalledWith('@mount/game/poster.png');
    expect(imageActionMocks.addImage).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'asset://runtime/@mount/game/poster.png', id: 'poster' }),
      7,
    );
  });

  it('keeps an empty file editable without reporting during playback', () => {
    const tl = gsap.timeline({ paused: true });

    expect(() => scheduleAddImage({
      tl,
      resolvePath: vi.fn(),
    } as any, {
      time: 0,
      params: { id: 'poster', file: '' },
    })).not.toThrow();
    expect(imageActionMocks.cancelImageRequest).not.toHaveBeenCalled();
    expect(imageActionMocks.reportImageError).not.toHaveBeenCalled();
    expect(imageActionMocks.addImage).not.toHaveBeenCalled();

    const playbackTimeline = gsap.timeline({ paused: true });
    scheduleAddImage({
      tl: playbackTimeline,
      resolvePath: vi.fn(),
      isPlaying: () => true,
    } as any, {
      time: 0,
      params: { id: 'poster', file: '' },
    });
    playbackTimeline.progress(1);

    expect(imageActionMocks.cancelImageRequest).toHaveBeenCalledWith('poster');
    expect(imageActionMocks.reportImageError).not.toHaveBeenCalled();
  });

  it('schedules image transforms with the authored stage properties', () => {
    const tl = gsap.timeline({ paused: true });
    const params = {
      id: 'poster',
      position: [0.25, 0.75],
      scale: 1.2,
      rotation: 8,
      opacity: 0.7,
      zIndex: 22,
      z: 3,
      duration: 0.8,
      ease: 'power2.inOut',
    };

    scheduleTransformImage({
      tl,
    } as any, {
      time: 1.5,
      params,
    } as any);

    expect(imageActionMocks.transformImage).toHaveBeenCalledWith(params);
    expect(tl.duration()).toBeCloseTo(2.3, 6);
  });

  it('ignores an image transform without an id', () => {
    const tl = gsap.timeline({ paused: true });

    scheduleTransformImage({
      tl,
    } as any, {
      time: 1,
      params: { position: [0.5, 0.5], scale: 1.5 },
    } as any);

    expect(imageActionMocks.transformImage).not.toHaveBeenCalled();
    expect(tl.duration()).toBe(0);
  });

  it('schedules image removal with its transition configuration', () => {
    const tl = gsap.timeline({ paused: true });

    scheduleRemoveImage({
      tl,
    } as any, {
      time: 2,
      params: { id: 'poster', duration: 0.4, ease: 'power2.in' },
    } as any);

    expect(imageActionMocks.removeImage).toHaveBeenCalledWith('poster', 0.4, 'power2.in');
    expect(tl.duration()).toBeCloseTo(2.4, 6);
  });
});
