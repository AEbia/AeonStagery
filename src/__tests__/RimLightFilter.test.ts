// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { mockDeep } from 'vitest-mock-extended';
import { PIXI_V8_FILTER_VERTEX } from '../engine/PixiV8Filter';
import { RimLightFilter, RIM_LIGHT_FRAGMENT } from '../engine/RimLightFilter';

describe('RimLightFilter shader contract', () => {
  it('uses PixiJS 8 global filter uniform names', () => {
    expect(PIXI_V8_FILTER_VERTEX).toMatch(/uniform vec4 uInputSize/);
    expect(RIM_LIGHT_FRAGMENT).toMatch(/uniform highp vec4 uInputSize/);
    expect(RIM_LIGHT_FRAGMENT).not.toMatch(/uniform vec4 inputSize/);
  });

  it('invalidates Pixi shader state before applying after a Cubism draw', () => {
    const calls: string[] = [];
    const filter = new RimLightFilter({ distance: 10, alpha: 1 });

    const filterManager = mockDeep<PIXI.FilterSystem>();
    const renderer = mockDeep<PIXI.WebGLRenderer>();
    renderer.shader.resetState.mockImplementation(() => { calls.push('resetState'); });
    Object.defineProperty(filterManager, 'renderer', { value: renderer });
    filterManager.applyFilter.mockImplementation(() => { calls.push('apply'); });

    filter.apply(filterManager, PIXI.Texture.EMPTY, PIXI.Texture.EMPTY, false);

    expect(calls).toEqual(['resetState', 'apply']);
  });

  it('starts neutral and reserves transparent padding for the complete mask footprint', () => {
    const filter = new RimLightFilter();
    expect(filter.alpha).toBe(0);
    expect(filter.distance).toBe(0);
    expect(filter.rotation).toBe(0);
    expect(filter.blur).toBe(0);
    expect(filter.padding).toBe(1);
    filter.distance = 20;
    filter.blur = 1;
    expect(filter.padding).toBe(22);
    filter.distance = 6;
    expect(filter.padding).toBe(8);
  });

  it('keeps softness in pixels while scaling the shader kernel by thickness', () => {
    const filter = new RimLightFilter({ distance: 8, blur: 2 });
    expect(filter.blur).toBe(2);
    expect(filter.uniforms.rimSoftness).toBe(0.25);
    filter.distance = 16;
    expect(filter.uniforms.rimThickness).toBe(16);
    expect(filter.uniforms.rimSoftness).toBe(0.125);
    filter.blur = 3;
    expect(filter.blur).toBe(3);
    expect(filter.uniforms.rimSoftness).toBeCloseTo(3 / 16);
    filter.blur = -1;
    expect(filter.blur).toBe(0);
    filter.blur = Number.NaN;
    expect(filter.uniforms.rimSoftness).toBe(0);
  });

  it.each([0, 90, 180, 270])('sets the sampling direction for %d degrees', (angle) => {
    const filter = new RimLightFilter({ rotation: angle });
    expect(filter.uniforms.rimDirection[0]).toBeCloseTo(Math.cos(angle * Math.PI / 180));
    expect(filter.uniforms.rimDirection[1]).toBeCloseTo(Math.sin(angle * Math.PI / 180));
  });
});
