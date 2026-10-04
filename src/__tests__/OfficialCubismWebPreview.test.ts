import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOfficialCubismWebPreviewResolution,
  registerOfficialCubismWebPreviewTarget,
  setOfficialCubismWebPreviewResolution,
  unregisterOfficialCubismWebPreviewTarget,
} from '../engine/OfficialCubismWebPreview';

describe('Official Cubism preview resolution registry', () => {
  afterEach(() => {
    setOfficialCubismWebPreviewResolution(1);
  });

  it('updates current targets and applies the latest quality to late registrations', () => {
    const first = { setPreviewResolution: vi.fn() };
    const late = { setPreviewResolution: vi.fn() };

    registerOfficialCubismWebPreviewTarget(first);
    expect(first.setPreviewResolution).toHaveBeenCalledWith(1);

    setOfficialCubismWebPreviewResolution(0.5);
    expect(first.setPreviewResolution).toHaveBeenLastCalledWith(0.5);
    expect(getOfficialCubismWebPreviewResolution()).toBe(0.5);

    registerOfficialCubismWebPreviewTarget(late);
    expect(late.setPreviewResolution).toHaveBeenCalledWith(0.5);

    unregisterOfficialCubismWebPreviewTarget(first);
    setOfficialCubismWebPreviewResolution(0.25);
    expect(first.setPreviewResolution).toHaveBeenLastCalledWith(0.5);
    expect(late.setPreviewResolution).toHaveBeenLastCalledWith(0.25);
  });
});
