/** Project output pixels are independent of the logical authoring coordinates. */
export interface ProjectVideoFormat {
  width: number;
  height: number;
  fps: number;
}

export type OutputFit = 'contain' | 'cover';

export const DEFAULT_VIDEO_FORMAT: Readonly<ProjectVideoFormat> = Object.freeze({
  width: 1920, height: 1080, fps: 60,
});

export function validateVideoFormat(value: ProjectVideoFormat): string | null {
  if (![value.width, value.height].every(size => Number.isInteger(size) && size >= 16 && size <= 8192 && size % 2 === 0)) {
    return '宽和高须为 16–8192 之间的偶数像素。';
  }
  if (!Number.isFinite(value.fps) || value.fps < 1 || value.fps > 240) {
    return '帧率须为 1–240 fps，可填写小数。';
  }
  return null;
}

export function getLogicalStageSize(format: Pick<ProjectVideoFormat, 'width' | 'height'>) {
  // Keep the short edge at 1080 authoring units. A 4K upgrade must not
  // change font sizes, camera coordinates, or the character's composition.
  const scale = 1080 / Math.min(format.width, format.height);
  return { width: format.width * scale, height: format.height * scale };
}

export function getOutputViewport(
  stage: { width: number; height: number },
  output: { width: number; height: number },
  fit: OutputFit = 'contain',
) {
  const scale = (fit === 'cover' ? Math.max : Math.min)(output.width / stage.width, output.height / stage.height);
  const width = output.width / scale;
  const height = output.height / scale;
  return { width, height, scale, x: (width - stage.width) / 2, y: (height - stage.height) / 2 };
}
