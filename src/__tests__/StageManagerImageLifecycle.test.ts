/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const imageAssetMocks = vi.hoisted(() => ({
  load: vi.fn(async (file: string) => ({ width: 1920, height: 1080, file })),
}));

vi.mock('pixi.js', () => {
  class Container {
    children: any[] = [];
    sortableChildren = false;
    parent: Container | null = null;

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
  }

  class Sprite {
    texture: any;
    anchor = { set: vi.fn() };
    scale = { x: 1, y: 1, set: vi.fn((value: number) => { this.scale.x = value; this.scale.y = value; }) };
    x = 0;
    y = 0;
    angle = 0;
    alpha = 1;
    zIndex = 0;
    parent: Container | null = null;
    destroyed = false;

    constructor(texture: any) {
      this.texture = texture;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  return {
    Application: class {},
    Container,
    Sprite,
    TilingSprite: Sprite,
    Graphics: class {},
    Texture: {
      from: vi.fn(() => ({ valid: false })),
    },
    Assets: imageAssetMocks,
  };
});

describe('StageManager image lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    imageAssetMocks.load.mockReset().mockImplementation(async (file: string) => ({ width: 1920, height: 1080, file }));
  });

  async function createImageStage() {
    const { stageManager } = await import('../engine/StageManager');
    const { Container } = await import('pixi.js');
    const effectsLayer = new Container();
    (stageManager as any).app = {};
    (stageManager as any).layers = new Map([['effects', effectsLayer]]);
    (stageManager as any).imageSprites.clear();
    return { stageManager, effectsLayer };
  }

  it('replaces an existing image sprite with the same stable id', async () => {
    const { stageManager, effectsLayer } = await createImageStage();

    const first = stageManager.addImage({ id: 'poster', file: 'images/first.png' });
    const second = stageManager.addImage({ id: 'poster', file: 'images/second.png' });

    expect(first).not.toBe(second);
    expect((first as any).destroyed).toBe(true);
    expect(first?.parent).toBeNull();
    expect(effectsLayer.children).toEqual([second]);
    expect(stageManager.getImageSprite('poster')).toBe(second);
  });

  it('removes an existing same-id image without reporting an empty replacement file', async () => {
    const pending: Array<{ file: string; resolve: (texture: any) => void }> = [];
    imageAssetMocks.load.mockImplementation((file: string) => new Promise((resolve) => {
      pending.push({ file, resolve });
    }));
    const { stageManager, effectsLayer } = await createImageStage();

    const first = stageManager.addImage({ id: 'poster', file: 'first.png' }) as any;
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    expect(stageManager.addImage({ id: 'poster', file: '   ' })).toBeNull();

    expect(first.destroyed).toBe(true);
    expect(first.parent).toBeNull();
    expect(effectsLayer.children).toEqual([]);
    expect(stageManager.getImageSprite('poster')).toBeNull();
    expect(stageManager.getImageLoadError('poster')).toBeNull();

    pending[0].resolve({ width: 1, height: 1, file: 'first.png' });
    await Promise.resolve();
    expect(stageManager.getImageSprite('poster')).toBeNull();
  });

  it('clears tracked and anonymous image sprites from the effects layer', async () => {
    const { stageManager, effectsLayer } = await createImageStage();

    const tracked = stageManager.addImage({ id: 'poster', file: 'images/poster.png' });
    const anonymous = stageManager.addImage({ file: 'images/anonymous.png' });

    expect(effectsLayer.children).toHaveLength(2);

    stageManager.clearImages();

    expect(effectsLayer.children).toHaveLength(0);
    expect((tracked as any).destroyed).toBe(true);
    expect((anonymous as any).destroyed).toBe(true);
    expect(stageManager.getImageSprite('poster')).toBeNull();
  });

  it('animates depth-aware image origins instead of snapping projected coordinates', async () => {
    const { stageManager } = await createImageStage();
    const sprite = stageManager.addImage({
      id: 'poster',
      file: 'images/poster.png',
      position: [0.2, 0.3],
      scale: 1,
      z: 40,
    }) as any;

    const timeline = stageManager.transformImage({
      id: 'poster',
      position: [0.8, 0.7],
      scale: 1.4,
      duration: 0.5,
    });

    expect(sprite.x_orig).toBe(0.2);
    expect(sprite.y_orig).toBe(0.3);
    expect(sprite.scale_orig).toBe(1);
    timeline.progress(1);
    expect(sprite.x_orig).toBeCloseTo(0.8);
    expect(sprite.y_orig).toBeCloseTo(0.7);
    expect(sprite.scale_orig).toBeCloseTo(1.4);
  });

  it('loads the resolved asset asynchronously without using Texture.from validity', async () => {
    const { stageManager } = await createImageStage();

    const sprite = stageManager.addImage({ id: 'poster', file: 'asset://localhost/project/poster.png' });
    await vi.waitFor(() => expect(imageAssetMocks.load).toHaveBeenCalled());

    expect(sprite).toBeDefined();
    expect(imageAssetMocks.load).toHaveBeenCalledWith('asset://localhost/project/poster.png');
    expect((await imageAssetMocks.load.mock.results[0]?.value)).toEqual(expect.objectContaining({
      file: 'asset://localhost/project/poster.png',
    }));
    const { Texture } = await import('pixi.js');
    expect(Texture.from).not.toHaveBeenCalled();
    expect((sprite as any).texture.file).toBe('asset://localhost/project/poster.png');
  });

  it('ignores a stale async load after duplicate-id replacement', async () => {
    const pending: Array<{ file: string; resolve: (texture: any) => void }> = [];
    imageAssetMocks.load.mockImplementation((file: string) => new Promise((resolve) => {
      pending.push({ file, resolve });
    }));
    const { stageManager } = await createImageStage();

    const first = stageManager.addImage({ id: 'poster', file: 'first.png' });
    const second = stageManager.addImage({ id: 'poster', file: 'second.png' });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending.find((entry) => entry.file === 'second.png')?.resolve({ width: 2, height: 2, file: 'second.png' });
    await vi.waitFor(() => expect((second as any).texture.file).toBe('second.png'));
    pending.find((entry) => entry.file === 'first.png')?.resolve({ width: 1, height: 1, file: 'first.png' });
    await Promise.resolve();

    expect(first).not.toBe(second);
    expect((first as any).destroyed).toBe(true);
    expect((second as any).texture.file).toBe('second.png');
    expect(stageManager.getImageSprite('poster')).toBe(second);
  });

  it('keeps transform and remove timelines pending until an image is created', async () => {
    const { stageManager } = await createImageStage();
    stageManager.registerImageAction({ id: 'poster', file: 'poster.png', position: [0.2, 0.3] });
    const transform = stageManager.transformImage({
      id: 'poster',
      position: [0.8, 0.7],
      scale: 1.5,
      opacity: 0.6,
      duration: 0.5,
    });
    const sprite = stageManager.addImage({ id: 'poster', file: 'poster.png', position: [0.2, 0.3] }) as any;

    transform.progress(1);

    expect(sprite.x).toBeCloseTo(0.8 * 1920);
    expect(sprite.y).toBeCloseTo(0.7 * 1080);
    expect(sprite.scale.x).toBeCloseTo(1.5);
    expect(sprite.alpha).toBeCloseTo(0.6);

    const remove = stageManager.removeImage('poster');
    remove.progress(1);
    expect(stageManager.getImageSprite('poster')).toBeNull();
    expect(sprite.destroyed).toBe(true);
  });

  it('keeps an empty scheduled image editable without reporting a runtime error', async () => {
    const { stageManager } = await createImageStage();

    stageManager.registerImageAction({ id: 'empty-poster', file: '' });

    expect(stageManager.getImageLoadError('empty-poster')).toBeNull();
    expect(stageManager.getImageSprite('empty-poster')).toBeNull();
  });

  it('silently skips empty image materialization', async () => {
    const { stageManager } = await createImageStage();

    await expect(stageManager.materializeImage({ id: 'empty-poster', file: '' })).resolves.toBeNull();

    expect(stageManager.getImageLoadError('empty-poster')).toBeNull();
  });

  it('preserves pending transform and fade-remove state when a late load completes', async () => {
    const pending: Array<{ file: string; resolve: (texture: any) => void }> = [];
    imageAssetMocks.load.mockImplementation((file: string) => new Promise((resolve) => {
      pending.push({ file, resolve });
    }));
    const { stageManager } = await createImageStage();

    const requestVersion = stageManager.beginImageRequest('poster', {
      file: 'poster.png',
      position: [0.2, 0.3],
      scale: 1,
      opacity: 1,
    });
    const sprite = stageManager.addImage({
      id: 'poster',
      file: 'poster.png',
      position: [0.2, 0.3],
      scale: 1,
      opacity: 1,
    }, requestVersion) as any;
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const transform = stageManager.transformImage({
      id: 'poster',
      position: [0.8, 0.7],
      scale: 1.5,
      opacity: 0.6,
      duration: 0.5,
    });
    transform.progress(1);
    const remove = stageManager.removeImage('poster', 1);
    remove.progress(0.5);
    remove.pause();
    const expected = { x: sprite.x, y: sprite.y, scale: sprite.scale.x, alpha: sprite.alpha };

    pending[0].resolve({ width: 1920, height: 1080, file: 'poster.png' });
    await vi.waitFor(() => expect(sprite.texture.file).toBe('poster.png'));

    expect(sprite.x).toBeCloseTo(expected.x);
    expect(sprite.y).toBeCloseTo(expected.y);
    expect(sprite.scale.x).toBeCloseTo(expected.scale);
    expect(sprite.alpha).toBeCloseTo(expected.alpha);

    remove.progress(1);
    expect(stageManager.getImageSprite('poster')).toBeNull();
  });

  it('exposes failed image loads and removes the placeholder instead of succeeding', async () => {
    imageAssetMocks.load.mockRejectedValue(new Error('file not found'));
    const { stageManager } = await createImageStage();

    const sprite = stageManager.addImage({ id: 'poster', file: 'missing.png' }) as any;
    await vi.waitFor(() => expect(sprite.destroyed).toBe(true));

    expect(stageManager.getImageSprite('poster')).toBeNull();
    expect(stageManager.getImageLoadError('poster')).toMatch(/file not found/);
    expect(stageManager.getImageLoadError('poster')).toMatch(/Choose an available image resource/);
  });

  it('rejects failed environment loads instead of generating a successful placeholder', async () => {
    imageAssetMocks.load.mockRejectedValue(new Error('background missing'));
    const { stageManager } = await createImageStage();

    await expect((stageManager as any).loadEnvironmentTexture('missing-background.png'))
      .rejects.toThrow(/background missing/);
  });

  it('invalidates a failed seek epoch so a slower image cannot attach afterward', async () => {
    const pending: Array<{ file: string; resolve: (texture: any) => void }> = [];
    imageAssetMocks.load.mockImplementation((file: string) => new Promise((resolve) => {
      pending.push({ file, resolve });
    }));
    const { stageManager } = await createImageStage();
    const epoch = stageManager.beginImageReconciliation(new Set(['poster']));
    const materialization = stageManager.materializeImage({
      id: 'poster',
      file: 'poster.png',
    }, epoch);

    await vi.waitFor(() => expect(pending).toHaveLength(1));
    stageManager.invalidateImageReconciliation();
    pending[0].resolve({ width: 2, height: 2, file: 'poster.png' });

    await expect(materialization).resolves.toBeNull();
    expect(stageManager.getImageSprite('poster')).toBeNull();
  });
});
