import { describe, expect, it } from 'vitest';
import { FilterSystem, RenderTexture } from 'pixi.js';
import { installPixiFilterResolutionGuard } from '../engine/PixiFilterResolutionGuard';

describe('Pixi filter resolution after pooled textures are destroyed', () => {
  it('falls back to the current root resolution for a destroyed stack texture', () => {
    const filter = new FilterSystem(null as any) as any;
    const texture = RenderTexture.create({ width: 32, height: 32, resolution: 2 });
    filter._pushFilterData();
    filter._pushFilterData().inputTexture = texture;
    texture.destroy(true);

    installPixiFilterResolutionGuard({ filter });
    expect(filter._findFilterResolution(0.5)).toBe(0.5);
    filter.destroy();
  });

  it('keeps the original live resolution lookup, including skipped filters', () => {
    const filter = new FilterSystem(null as any) as any;
    const parent = RenderTexture.create({ width: 32, height: 32, resolution: 2 });
    const skipped = RenderTexture.create({ width: 32, height: 32, resolution: 0.5 });
    filter._pushFilterData();
    filter._pushFilterData().inputTexture = parent;
    const entry = filter._pushFilterData();
    entry.inputTexture = skipped;
    entry.skip = true;
    skipped.destroy(true);

    installPixiFilterResolutionGuard({ filter });
    expect(filter._findFilterResolution(1)).toBe(2);
    parent.destroy(true);
    expect(filter._findFilterResolution(1)).toBe(1);
    filter.destroy();
  });

  it('installs once per filter system and accepts renderers without that system', () => {
    const filter = new FilterSystem(null as any);
    installPixiFilterResolutionGuard({ filter });
    const lookup = (filter as any)._findFilterResolution;
    installPixiFilterResolutionGuard({ filter });
    expect((filter as any)._findFilterResolution).toBe(lookup);
    expect(lookup.call(filter, 2)).toBe(2);
    expect(() => installPixiFilterResolutionGuard({})).not.toThrow();
    filter.destroy();
  });
});
