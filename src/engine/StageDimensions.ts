import { DEFAULT_VIDEO_FORMAT, getLogicalStageSize, type ProjectVideoFormat } from '../api/types/video-format';

// Live bindings shared by the single mounted editor stage. Headless scene
// compilation remains independent of this runtime state.
export let STAGE_WIDTH = 1920;
export let STAGE_HEIGHT = 1080;
export let STAGE_FPS = 60;

export function setStageDimensions(format: ProjectVideoFormat = DEFAULT_VIDEO_FORMAT): void {
  const size = getLogicalStageSize(format);
  STAGE_WIDTH = size.width;
  STAGE_HEIGHT = size.height;
  STAGE_FPS = format.fps;
}
