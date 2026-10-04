/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const delayedCalls: Array<{
  duration: number;
  callback: () => void;
  killed: boolean;
}> = [];

vi.mock('gsap', () => {
  return {
    default: {
      to: vi.fn(),
      killTweensOf: vi.fn(),
      delayedCall: (duration: number, callback: () => void) => {
        const handle = {
          duration,
          callback,
          killed: false,
          kill() {
            handle.killed = true;
          },
        };
        delayedCalls.push(handle);
        return handle;
      },
    },
  };
});

vi.mock('pixi.js', () => {
  class Container {
    children: any[] = [];
    sortableChildren = false;
    zIndex = 0;
    visible = true;
    parent: Container | null = null;
    name?: string;
    pivot = { set: vi.fn() };

    addChild(child: any) {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    removeChild(child: any) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parent = null;
      return child;
    }

    removeChildren() {
      const removed = [...this.children];
      this.children.forEach((child) => {
        child.parent = null;
      });
      this.children = [];
      return removed;
    }

    destroy() {}
  }

  class Sprite {
    texture: any;
    anchor = { set: vi.fn() };
    scale = { set: vi.fn() };
    pivot = { set: vi.fn() };
    x = 0;
    y = 0;
    angle = 0;
    alpha = 1;
    parent: Container | null = null;

    constructor(texture: any) {
      this.texture = texture;
    }

    destroy() {}
  }

  class TilingSprite extends Sprite {
    width = 0;
    height = 0;
    tileScale = { set: vi.fn() };
    tilePosition = { set: vi.fn() };

    constructor(texture: any, width: number, height: number) {
      super(texture);
      this.width = width;
      this.height = height;
    }
  }

  class Graphics {
    beginFill() {
      return this;
    }
    lineStyle() {
      return this;
    }
    drawRect() {
      return this;
    }
    endFill() {
      return this;
    }
  }

  class Application {
    stage = new Container();
    canvas = { style: {} } as any;
    renderer = { background: { color: 0, alpha: 1 } } as any;
    ticker = { start: vi.fn(), stop: vi.fn() };

    async init() {}

    destroy() {}
  }

  return {
    Application,
    Container,
    Sprite,
    TilingSprite,
    Graphics,
    Assets: {
      load: vi.fn(async () => ({ width: 1920, height: 1080 })),
    },
  };
});

vi.mock('../engine/CustomAnimHost', () => ({
  customAnimHost: {
    init: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock('../engine/Live2DEngineBridge', () => ({
  ensureLive2DRenderPipe: vi.fn(async () => {}),
}));

describe('StageManager environment layer clear lifecycle', () => {
  beforeEach(() => {
    delayedCalls.length = 0;
    vi.resetModules();
  });

  it('keeps scene and UI as ordered stage siblings', async () => {
    const { stageManager } = await import('../engine/StageManager');
    const mount = {
      clientWidth: 1920,
      clientHeight: 1080,
      appendChild: vi.fn(),
    };

    await stageManager.init(mount as any);

    const stage = stageManager.getStage();
    const scene = stageManager.getSceneContainer();
    const ui = stageManager.getUIContainer();
    expect(stage.children).toEqual([scene, ui]);
    expect(scene.children.map((child: any) => child.name)).toEqual([
      'background',
      'characters',
      'effects',
      'customAnimation',
    ]);
    expect(ui.children.map((child: any) => child.name)).toEqual(['subtitle', 'overlay']);

    stageManager.destroy();
  });

  it('preserves the outgoing image scale when cross-fading to a differently scaled image', async () => {
    const { stageManager } = await import('../engine/StageManager');
    const backgroundLayer = new (await import('pixi.js')).Container();
    vi.spyOn(stageManager, 'getLayer').mockReturnValue(backgroundLayer as any);

    await stageManager.setEnvironmentLayer('background', 'first.png', {
      transition: 'none', scale: 1.5, opacity: 1,
    });
    const container = backgroundLayer.children[0] as any;
    const outgoing = container.children[0];
    const originalScale = outgoing.scale.set.mock.lastCall;
    await stageManager.setEnvironmentLayer('background', 'second.png', {
      transition: 'crossFade', duration: 1, scale: 1, opacity: 1,
    });

    expect(container.children).toHaveLength(2);
    expect(outgoing.scale.set.mock.lastCall).toEqual(originalScale);
    expect(container.children[1].scale.set.mock.lastCall).not.toEqual(originalScale);
    stageManager.applyEnvironmentLayerTransform('background', { scale: 1.1, opacity: 1 });
    expect(outgoing.scale.set.mock.lastCall).toEqual(originalScale);
  });

  it('preserves outgoing transforms when reconstructing a cross-fade', async () => {
    const { stageManager } = await import('../engine/StageManager');
    const { reconstructEnvironmentAtTime } = await import('../engine/EnvironmentLayerRuntime');
    const backgroundLayer = new (await import('pixi.js')).Container();
    vi.spyOn(stageManager, 'getLayer').mockReturnValue(backgroundLayer as any);
    const snapshot = reconstructEnvironmentAtTime({
      sceneId: 'cross-fade', meta: { title: 'Cross-fade', characters: [] },
      timeline: [
        { _id: 'first', time: 0, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'first.png', scale: 1.5, duration: 0 } },
        { _id: 'second', time: 1, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'second.png', scale: 1, transition: 'crossFade', duration: 2 } },
      ],
    }, 2);
    await stageManager.renderEnvironmentLayer(snapshot.background!);
    const [outgoing, incoming] = (backgroundLayer.children[0] as any).children;
    expect(outgoing.scale.set.mock.lastCall).toEqual([1.5]);
    expect(incoming.scale.set.mock.lastCall).toEqual([1.25]);
    stageManager.applyEnvironmentLayerTransform('background', { scale: 1.25, opacity: 1 });
    expect(outgoing.scale.set.mock.lastCall).toEqual([1.5]);
    stageManager.applyEnvironmentLayerTransform('background', { scale: 1.25, opacity: 1 }, {
      position: { x: 960, y: 540 }, zoom: 2,
    });
    expect(outgoing.scale.set.mock.lastCall).toEqual([3]);
    expect(incoming.scale.set.mock.lastCall).toEqual([2.5]);

    await stageManager.renderEnvironmentLayer({
      layerId: 'background', scale: 2, images: [{ image: 'first.png', weight: 1 }],
    });
    expect((backgroundLayer.children[0] as any).children).toEqual([outgoing]);
    expect(outgoing.scale.set.mock.lastCall).toEqual([2]);
  });

  it('cancels a pending fade-out clear when the same layer is set again', async () => {
    const { stageManager } = await import('../engine/StageManager');

    const backgroundLayer = new (await import('pixi.js')).Container();
    vi.spyOn(stageManager, 'getLayer').mockReturnValue(backgroundLayer as any);

    await stageManager.setEnvironmentLayer('background', 'background/first.png', {
      transition: 'none',
      duration: 0,
      x: 0.5,
      y: 0.5,
      scale: 1,
      opacity: 1,
      z: 0,
    });

    stageManager.removeEnvironmentLayer('background', {
      transition: 'fadeOut',
      duration: 1,
    });

    expect(delayedCalls).toHaveLength(1);
    expect((stageManager as any).environmentLayerEntries.has('background')).toBe(true);

    await stageManager.setEnvironmentLayer('background', 'background/second.png', {
      transition: 'none',
      duration: 0,
      x: 0.5,
      y: 0.5,
      scale: 1,
      opacity: 1,
      z: 0,
    });

    expect(delayedCalls[0].killed).toBe(true);

    delayedCalls[0].callback();

    expect((stageManager as any).environmentLayerEntries.has('background')).toBe(true);
    expect(backgroundLayer.children).toHaveLength(1);
  });
});
