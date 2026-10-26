// src/__tests__/Projection.test.ts
import { describe, it, expect } from 'vitest';
import { projectToScreen, DEFAULT_FOCAL_LENGTH, MAX_Z_TEXT } from '../engine/Projection';
import type { CameraState } from '../api/types/camera';
import { getLogicalStageSize } from '../api/types/video-format';

describe('projectToScreen', () => {
  const defaultProxy = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1, z: 0 };
  const defaultCamera: CameraState = { position: { x: 0.5, y: 0.5 }, zoom: 1, rotation: 0 };
  const vp = { w: 1920, h: 1080 };

  it('returns identity projection at z=0 with centered camera', () => {
    const r = projectToScreen(defaultProxy, defaultCamera, vp);
    expect(r.screenX).toBeCloseTo(960);
    expect(r.screenY).toBeCloseTo(540);
    expect(r.screenScale).toBeCloseTo(1);
  });

  it('applies camera zoom to scale and spreads positions from center', () => {
    const cam: CameraState = { position: { x: 0.5, y: 0.5 }, zoom: 2, rotation: 0 };
    // Object at center stays at center
    const rCenter = projectToScreen(defaultProxy, cam, vp);
    expect(rCenter.screenX).toBeCloseTo(960);
    expect(rCenter.screenScale).toBeCloseTo(2);

    // Object off-center spreads away from center
    const offCenter = { ...defaultProxy, x: 480 };
    const rOff = projectToScreen(offCenter, cam, vp);
    // screenX = 960 + (480 - 960) * 2 = 960 - 960 = 0
    expect(rOff.screenX).toBeCloseTo(0);
  });

  it('offsets by camera position', () => {
    // camera looking at left edge (x=0.0)
    const cam: CameraState = { position: { x: 0.0, y: 0.5 }, zoom: 1, rotation: 0 };
    const r = projectToScreen(defaultProxy, cam, vp);
    // camOffsetX = (0.5 - 0.0) * 1920 = 960
    // worldX = 960 + 960 = 1920
    // screenX = 960 + (1920 - 960) * 1 = 1920
    expect(r.screenX).toBeCloseTo(1920);
  });

  it('z > 0 produces stronger parallax (foreground displacement is larger)', () => {
    const proxy = { ...defaultProxy, z: 500 };
    const cam: CameraState = { position: { x: 0.75, y: 0.5 }, zoom: 1, rotation: 0 };
    const r = projectToScreen(proxy, cam, vp);
    const r0 = projectToScreen({ ...defaultProxy, z: 0 }, cam, vp);
    // Foreground (z=500) has larger displacement from center than midground (z=0)
    expect(Math.abs(r.screenX - 960)).toBeGreaterThan(Math.abs(r0.screenX - 960));
  });

  it('z < 0 produces weaker parallax (background displacement is smaller)', () => {
    const proxy = { ...defaultProxy, z: -300 };
    const cam: CameraState = { position: { x: 0.75, y: 0.5 }, zoom: 1, rotation: 0 };
    const r = projectToScreen(proxy, cam, vp);
    const r0 = projectToScreen({ ...defaultProxy, z: 0 }, cam, vp);
    // Background (z=-300) has smaller displacement from center than midground (z=0)
    expect(Math.abs(r.screenX - 960)).toBeLessThan(Math.abs(r0.screenX - 960));
  });

  it('parallax = 1 (identity) when z = 0 — matches old pivot-based formula', () => {
    const cam: CameraState = { position: { x: 0.2, y: 0.8 }, zoom: 1, rotation: 0 };
    const r = projectToScreen(defaultProxy, cam, vp);
    // Manual: camOffsetX = (0.5 - 0.2) * 1920 = 576
    // worldX = 960 + 576 = 1536, screenX = 960 + (1536-960)*1 = 1536
    expect(r.screenX).toBeCloseTo(1536);
  });

  it('z=0 + zoom matches old pivot-based system exactly', () => {
    // Old system: screenX = (proxy.x - cam.x*W) * zoom + W/2
    const cam: CameraState = { position: { x: 0.3, y: 0.5 }, zoom: 1.5, rotation: 0 };
    const proxy = { ...defaultProxy, x: 700 };
    const r = projectToScreen(proxy, cam, vp);
    // Old: (700 - 0.3*1920) * 1.5 + 960 = (700 - 576) * 1.5 + 960 = 186 + 960 = 1146
    expect(r.screenX).toBeCloseTo(1146);
  });

  it('defensively handles undefined z by treating it as z=0', () => {
    const proxyWithoutZ = { x: 960, y: 540, scale: 1, rotation: 0, opacity: 1 };
    const r = projectToScreen(proxyWithoutZ as any, defaultCamera, vp);
    expect(r.screenX).toBeCloseTo(960);
    expect(r.screenY).toBeCloseTo(540);
  });

  it('applies shake in screen pixels uniformly across depth and zoom', () => {
    for (const zoom of [0.5, 1, 2]) {
      for (const z of [-300, 0, 500]) {
        const proxy = { ...defaultProxy, z };
        const camera = { ...defaultCamera, zoom };
        const baseline = projectToScreen(proxy, camera, vp);
        const shaken = projectToScreen(proxy, { ...camera, shakeOffset: { x: 12, y: -8 } }, vp);
        expect(shaken.screenX).toBeCloseTo(baseline.screenX + 12);
        expect(shaken.screenY).toBeCloseTo(baseline.screenY - 8);
        expect(shaken.screenScale).toBe(baseline.screenScale);
      }
    }
  });

  it('rotates projected positions around the logical frame center and cancels visible orientation', () => {
    const proxy = { ...defaultProxy, x: 1200, y: 540, rotation: 30 };
    const camera = { ...defaultCamera, rotation: 90 };
    const projected = projectToScreen(proxy, camera, vp);

    // A positive camera angle rotates world points counter-clockwise on screen.
    expect(projected.screenX).toBeCloseTo(960);
    expect(projected.screenY).toBeCloseTo(300);
    expect(projected.screenRotation).toBeCloseTo(-60);
  });

  it('adds logical-unit shake after camera rotation independent of zoom and depth', () => {
    for (const zoom of [0.5, 1, 2]) {
      for (const z of [-300, 0, 500]) {
        const proxy = { ...defaultProxy, x: 1200, z };
        const camera = { ...defaultCamera, zoom, rotation: 90 };
        const baseline = projectToScreen(proxy, camera, vp);
        const shaken = projectToScreen(proxy, { ...camera, shakeOffset: { x: 12, y: -8 } }, vp);
        expect(shaken.screenX).toBeCloseTo(baseline.screenX + 12);
        expect(shaken.screenY).toBeCloseTo(baseline.screenY - 8);
      }
    }
  });

  it('rotates normalized points around landscape, portrait, and square logical frames', () => {
    for (const frame of [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, { w: 1080, h: 1080 }]) {
      const projected = projectToScreen(
        { x: frame.w * 0.625, y: frame.h * 0.5, scale: 1 },
        { position: { x: 0.5, y: 0.5 }, zoom: 1, rotation: 90 },
        frame,
      );
      expect(projected.screenX).toBeCloseTo(frame.w * 0.5);
      expect(projected.screenY).toBeCloseTo(frame.h * 0.5 - frame.w * 0.125);
    }
  });

  it('uses the same logical projection for 1080p and 4K output formats', () => {
    const logical1080 = getLogicalStageSize({ width: 1920, height: 1080 });
    const logical4k = getLogicalStageSize({ width: 3840, height: 2160 });
    const project = (frame: { width: number; height: number }) => projectToScreen(
      { x: 1200, y: 540, scale: 1 },
      { position: { x: 0.5, y: 0.5 }, zoom: 1, rotation: 90 },
      { w: frame.width, h: frame.height },
    );
    expect(logical4k).toEqual(logical1080);
    expect(project(logical4k)).toEqual(project(logical1080));
  });

  it('DEFAULT_FOCAL_LENGTH is 500', () => {
    expect(DEFAULT_FOCAL_LENGTH).toBe(500);
  });

  it('MAX_Z_TEXT is 9999 (for zIndex only)', () => {
    expect(MAX_Z_TEXT).toBe(9999);
  });
});
