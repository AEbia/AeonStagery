// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
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

    filter.apply({
      // Pixi v8 shape: the shader system exposes resetState(), not v7's
      // reset(). A v7-shaped mock would let a stale call pass silently.
      renderer: { shader: { resetState: () => calls.push('resetState') } },
      applyFilter: () => calls.push('apply'),
    } as any, {} as any, {} as any, 0 as any);

    expect(calls).toEqual(['resetState', 'apply']);
  });
});
