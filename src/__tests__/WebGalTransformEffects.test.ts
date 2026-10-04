import { describe, expect, it } from 'vitest';
import {
  hasFilterEffects,
  parseWebGalTransform,
  resolveWebGalEase,
} from '../services/import/webgal/WebGalTransformEffects';

describe('parseWebGalTransform', () => {
  it('parses position, rotation and scale', () => {
    const effects = parseWebGalTransform('{"position":{"x":-400,"y":50},"rotation":0.3,"scale":{"x":0.8,"y":0.8}}');
    expect(effects).toMatchObject({
      position: { x: -400, y: 50 },
      rotation: 0.3,
      scale: { x: 0.8, y: 0.8 },
    });
    expect(effects?.unknown).toEqual([]);
  });

  it('parses every documented filter field', () => {
    const effects = parseWebGalTransform(
      '{"alpha":0.9,"blur":10,"brightness":0.5,"contrast":1.2,"saturation":0.8,'
      + '"gamma":1.1,"colorRed":227,"colorGreen":213,"colorBlue":193,'
      + '"bloom":1,"bloomBrightness":0.5,"bloomBlur":20,"bloomThreshold":0.8,'
      + '"bevel":1,"bevelThickness":8,"bevelRed":255,"bevelGreen":183,"bevelBlue":0,'
      + '"bevelRotation":30,"bevelSoftness":0.8,'
      + '"oldFilm":1,"dotFilm":1,"rgbFilm":1,"glitchFilm":1,"godrayFilm":1,"reflectionFilm":1,'
      + '"shockwave":1,"radiusAlpha":0.5}',
    );
    expect(effects?.blur).toBe(10);
    expect(effects?.brightness).toBe(0.5);
    expect(effects?.colorRed).toBe(227);
    expect(effects?.bevel).toBe(1);
    expect(effects?.bevelThickness).toBe(8);
    expect(effects?.bevelRotation).toBe(30);
    expect(effects?.shockwave).toBe(1);
    expect(effects?.radiusAlpha).toBe(0.5);
    expect(effects?.unknown).toEqual([]);
  });

  it('collects unrecognized fields', () => {
    const effects = parseWebGalTransform('{"position":{"x":100},"totallyNew":5}');
    expect(effects?.position?.x).toBe(100);
    expect(effects?.unknown).toEqual(['totallyNew']);
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseWebGalTransform('not-json')).toBeUndefined();
    expect(parseWebGalTransform(undefined)).toBeUndefined();
  });

  it('detects filter-carrying transforms', () => {
    expect(hasFilterEffects(parseWebGalTransform('{"position":{"x":100}}')!)).toBe(false);
    expect(hasFilterEffects(parseWebGalTransform('{"blur":10}')!)).toBe(true);
    expect(hasFilterEffects(parseWebGalTransform('{"bevel":1,"bevelThickness":8}')!)).toBe(true);
    expect(hasFilterEffects(parseWebGalTransform('{"colorRed":227}')!)).toBe(true);
  });

  it('maps every documented WebGAL easing name', () => {
    const cases: Array<[string, string]> = [
      ['linear', 'linear'],
      ['easeIn', 'easein'],
      ['easeOut', 'easeout'],
      ['easeInOut', 'easeinout'],
      ['circIn', 'circ.in'],
      ['circOut', 'circ.out'],
      ['circInOut', 'circ.inOut'],
      ['backIn', 'back.in(1.7)'],
      ['backOut', 'back.out(1.7)'],
      ['backInOut', 'back.inOut(1.7)'],
      ['bounceIn', 'bounce.in'],
      ['bounceOut', 'bounce.out'],
      ['bounceInOut', 'bounce.inOut'],
      ['anticipate', 'anticipate'],
    ];
    for (const [webgal, gsap] of cases) {
      expect(resolveWebGalEase(webgal)).toBe(gsap);
    }
    expect(resolveWebGalEase('unknown-curve')).toBeUndefined();
    expect(resolveWebGalEase(undefined)).toBeUndefined();
  });
});
