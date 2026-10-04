import { beforeEach, describe, expect, it, vi } from 'vitest';

const live2DMocks = vi.hoisted(() => ({
  getModel: vi.fn(),
  getContainer: vi.fn(),
  removeCharacter: vi.fn(),
}));

vi.mock('../engine/Live2DManager', () => ({ live2DManager: live2DMocks }));

describe('Task 2 AnimationDirector exit lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live2DMocks.getModel.mockReturnValue(undefined);
  });

  it('keeps a non-linear exit ease on the child and removes after the child completes', async () => {
    const { default: AnimationDirector } = await import('../engine/AnimationDirector');
    const director = new AnimationDirector();
    const proxy = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 };

    const exit = director.characterExit('tomori', 'fadeOut', 1, 'power2.in', proxy);
    const master = director.getMasterTimeline();
    master.add(exit, 2);

    expect(master.getChildren(false, false, true)).toContain(exit);
    master.seek(2.5, false);
    expect(proxy.opacity).toBeCloseTo(0.875, 5);
    expect(live2DMocks.removeCharacter).not.toHaveBeenCalled();

    master.seek(3, false);
    expect(proxy.opacity).toBeCloseTo(0, 5);
    expect(live2DMocks.removeCharacter).toHaveBeenCalledTimes(1);
  });

  it('does not require a loaded model to create a timed exit boundary', async () => {
    const { default: AnimationDirector } = await import('../engine/AnimationDirector');
    const director = new AnimationDirector();
    live2DMocks.getContainer.mockReturnValue(undefined);

    const exit = director.characterExit('missing', 'fadeOut', 0.8, 'power3.out');
    director.getMasterTimeline().add(exit, 1);

    expect(director.getMasterTimeline().duration()).toBeCloseTo(1.8, 6);
    director.getMasterTimeline().seek(1.79, false);
    expect(live2DMocks.removeCharacter).not.toHaveBeenCalled();
    director.getMasterTimeline().seek(1.8, false);
    expect(live2DMocks.removeCharacter).toHaveBeenCalledWith('missing');
  });

  it('keeps an entrance timing boundary while model/container creation is pending', async () => {
    const { default: AnimationDirector } = await import('../engine/AnimationDirector');
    const director = new AnimationDirector();
    live2DMocks.getContainer.mockReturnValue(undefined);

    const entrance = director.characterEnter('missing', 'fadeIn', 0.7, 'power2.out');
    director.getMasterTimeline().add(entrance, 1);

    expect(director.getMasterTimeline().duration()).toBeCloseTo(1.7, 6);
    expect(() => director.getMasterTimeline().seek(1.7, false)).not.toThrow();
  });

  it('keeps legacy fade spelling on the same exit path', async () => {
    const { default: AnimationDirector } = await import('../engine/AnimationDirector');
    const director = new AnimationDirector();
    const proxy = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 };

    const exit = director.characterExit('tomori', 'fade' as any, 0.5, 'linear', proxy);
    director.getMasterTimeline().add(exit, 0);
    director.getMasterTimeline().seek(0.25, false);
    expect(proxy.opacity).toBeCloseTo(0.5, 5);
  });
});
