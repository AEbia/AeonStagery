import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { CubismPixiLive2DAdapter } from '../engine/runtime/CubismPixiLive2DAdapter';
import { Live2DCharacterGeometry } from '../engine/Live2DCharacterGeometry';
import { resolveCubismModelAnchor } from '../engine/runtime/CubismModelAnchors';
import type { CharacterEntry } from '../engine/Live2DConfig';
import type { Live2DAnchorName } from '../engine/Live2DAnchorGeometry';

function createFixture(moc = 'live2d_anon_002_live_01.moc3') {
  const parts = ['Part153', 'Part25', 'Part29', 'Part38', 'Part62', 'Part2'];
  const meshes = [
    { x: 30, y: 5, width: 20, height: 15 }, // face
    { x: 22, y: 22, width: 36, height: 14 }, // jacket
    { x: 20, y: 20, width: 40, height: 30 }, // torso
    { x: 42, y: 45, width: 18, height: 55 }, // left leg
    { x: 20, y: 45, width: 18, height: 55 }, // right leg
    { x: 0, y: 20, width: 180, height: 45 }, // guitar extends to the right
  ];
  const drawables = { count: meshes.length, parentPartIndices: parts.map((_, index) => index), opacities: parts.map(() => 1) };
  const model = Object.assign(new PIXI.Container(), {
    updateDrawableBounds: vi.fn(),
    internalModel: {
      settings: { moc },
      localTransform: new PIXI.Matrix(),
      getDrawableBounds: (index: number) => meshes[index],
      coreModel: { getModel: () => ({ parts: { ids: parts }, drawables }) },
    },
  });
  model.boundsArea = new PIXI.Rectangle(0, 0, 180, 100);
  const runtimeHandle = new CubismPixiLive2DAdapter().createModelHandle('actor', model);
  const entry = { id: 'actor', model, runtimeHandle, baseHeight: 100, config: {} } as CharacterEntry;
  const container = new PIXI.Container();
  container.addChild(model);
  const geometry = new Live2DCharacterGeometry(new Map([['actor', entry]]), new Map(), () => container, () => null, () => null);
  return { model, meshes, drawables, entry, container, geometry };
}

const anchors: readonly Live2DAnchorName[] = ['head', 'chest', 'center', 'feet'];

describe('Cubism stage anatomy through the runtime handle and stage geometry', () => {
  it('keeps all anchors on the body when a guitar extends beyond it', () => {
    const { geometry } = createFixture();
    for (const anchor of anchors) {
      const point = geometry.getPoint('actor', anchor)!;
      expect(point.x * 1920).toBeCloseTo(40);
    }
    expect(geometry.getPoint('actor', 'head')!.y * 1080).toBeCloseTo(12.5);
    const chestY = geometry.getPoint('actor', 'chest')!.y * 1080;
    expect(chestY).toBeGreaterThan(22);
    expect(chestY).toBeLessThan(36);
    expect(geometry.getPoint('actor', 'feet')!.y * 1080).toBeGreaterThan(95);
  });

  it('follows posed anatomy while ignoring changes in accessory bounds', () => {
    const { geometry, model, meshes } = createFixture();
    const before = geometry.getPoint('actor', 'head')!;
    meshes[0].x += 10;
    meshes[0].y += 5;
    expect(geometry.getPoint('actor', 'head')!.x * 1920).toBeCloseTo(before.x * 1920 + 10);
    expect(geometry.getPoint('actor', 'head')!.y * 1080).toBeCloseTo(before.y * 1080 + 5);
    const posed = anchors.map(anchor => geometry.getPoint('actor', anchor));
    meshes[5].width = 360;
    model.boundsArea = new PIXI.Rectangle(-30, -10, 390, 120);
    anchors.forEach((anchor, index) => {
      const actual = geometry.getPoint('actor', anchor)!;
      expect(actual.x).toBeCloseTo(posed[index]!.x);
      expect(actual.y).toBeCloseTo(posed[index]!.y);
    });
  });

  it.each([false, true])('composes posed anchors with authored scale, rotation and flip (%s)', flipX => {
    const { entry, container, model, meshes } = createFixture();
    entry.config.flipX = flipX;
    meshes[0].x += 7;
    meshes[1].x -= 3;
    model.pivot.set(40, 90);
    const proxy = { x: 960, y: 972, scale: 1.3, rotation: 30, opacity: 1, z: 0 };
    const geometry = new Live2DCharacterGeometry(new Map([['actor', entry]]), new Map(), () => container,
      () => ({ transformationProxies: new Map([['actor', proxy]]) }), () => null);
    for (const anchor of anchors) {
      const fraction = entry.runtimeHandle!.character.getAnchor(anchor)!;
      const localX = (fraction.x * 180 - 40) * 10.8 * 1.3 * (flipX ? -1 : 1);
      const localY = (fraction.y * 100 - 90) * 10.8 * 1.3;
      const point = geometry.getPoint('actor', anchor)!;
      expect(point.x * 1920).toBeCloseTo(960 + localX * Math.cos(Math.PI / 6) - localY * 0.5);
      expect(point.y * 1080).toBeCloseTo(972 + localX * 0.5 + localY * Math.cos(Math.PI / 6));
    }
  });

  it('maps Cubism layout transforms into local bounds before stage transforms', () => {
    const { model } = createFixture();
    model.internalModel.localTransform.set(0, 2, -2, 0, 200, 10);
    model.boundsArea = new PIXI.Rectangle(0, 10, 200, 360);
    const head = resolveCubismModelAnchor(model, 'head')!;
    expect(head.x * 200).toBeCloseTo(175);
    expect(10 + head.y * 360).toBeCloseTo(90);
  });

  it('falls back safely for missing, invisible or invalid anatomy', () => {
    const { model, meshes, drawables, geometry } = createFixture();
    drawables.opacities[0] = 0;
    expect(resolveCubismModelAnchor(model, 'head')).toBeNull();
    expect(geometry.getPoint('actor', 'head')!.x * 1920).toBeCloseTo(90);
    drawables.opacities[0] = 1;
    meshes[0].width = Number.NaN;
    expect(resolveCubismModelAnchor(model, 'head')).toBeNull();
    model.internalModel.settings.moc = 'other.moc3';
    expect(resolveCubismModelAnchor(model, 'chest')).toBeNull();
  });

  it('preserves bounds estimates and authored head hit areas for other models with the same part IDs', () => {
    const { geometry, model } = createFixture('other.moc3');
    const fractions = { head: 0.12, chest: 0.28, center: 0.5, feet: 0.95 };
    for (const anchor of anchors) {
      expect(geometry.getPoint('actor', anchor)!.x * 1920).toBeCloseTo(90);
      expect(geometry.getPoint('actor', anchor)!.y * 1080).toBeCloseTo(100 * fractions[anchor]);
    }
    Object.assign(model.internalModel.settings, {
      layout: { width: 2, center_x: 0, center_y: 0 },
      hit_areas_custom: { head_x: [-0.6, -0.2], head_y: [0.4, 0.8] },
    });
    expect(geometry.getPoint('actor', 'head')!.x * 1920).toBeCloseTo(54);
    expect(geometry.getPoint('actor', 'head')!.y * 1080).toBeCloseTo(20);
    expect(geometry.getPoint('actor', 'chest')!.x * 1920).toBeCloseTo(90);
  });
});
