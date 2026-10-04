// src/__tests__/Projection.test.ts
import { describe, it, expect } from 'vitest';
import { projectToScreen, DEFAULT_FOCAL_LENGTH, MAX_Z_TEXT } from '../engine/Projection';
import type { CameraState } from '../api/types/camera';

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

  it('DEFAULT_FOCAL_LENGTH is 500', () => {
    expect(DEFAULT_FOCAL_LENGTH).toBe(500);
  });

  it('MAX_Z_TEXT is 9999 (for zIndex only)', () => {
    expect(MAX_Z_TEXT).toBe(9999);
  });
});
