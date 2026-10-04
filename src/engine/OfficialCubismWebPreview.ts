import type { StagePreviewResolution } from '../api/interfaces/IStageAdapter';

export interface OfficialCubismWebPreviewTarget {
  setPreviewResolution(resolution: StagePreviewResolution): void;
}

const PREVIEW_RESOLUTION_VALUES: readonly StagePreviewResolution[] = [1, 0.5, 0.25];
const targets = new Set<OfficialCubismWebPreviewTarget>();
let previewResolution: StagePreviewResolution = 1;

export function getOfficialCubismWebPreviewResolution(): StagePreviewResolution {
  return previewResolution;
}

export function registerOfficialCubismWebPreviewTarget(
  target: OfficialCubismWebPreviewTarget,
): void {
  targets.add(target);
  target.setPreviewResolution(previewResolution);
}

export function unregisterOfficialCubismWebPreviewTarget(
  target: OfficialCubismWebPreviewTarget,
): void {
  targets.delete(target);
}

export function setOfficialCubismWebPreviewResolution(
  resolution: StagePreviewResolution,
): void {
  previewResolution = PREVIEW_RESOLUTION_VALUES.includes(resolution) ? resolution : 1;
  for (const target of targets) {
    target.setPreviewResolution(previewResolution);
  }
}
