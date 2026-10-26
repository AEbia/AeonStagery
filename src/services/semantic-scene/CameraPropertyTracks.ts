import type { CameraParams } from '../../api/types/semantic-scene';

export type CameraProperty = 'position' | 'zoom' | 'rotation';

/** Authored camera properties that lower into independently evaluated tracks. */
export function lowerCameraPropertyTracks(params: CameraParams): readonly CameraProperty[] {
  switch (params.mode) {
    case 'focus':
      return [
        ...(params.target !== undefined || params.position !== undefined ? ['position' as const] : []),
        ...(params.zoom !== undefined ? ['zoom' as const] : []),
        ...(params.rotation !== undefined ? ['rotation' as const] : []),
      ];
    case 'move':
      return [
        ...(params.position !== undefined || params.to !== undefined ? ['position' as const] : []),
        ...(params.zoom !== undefined ? ['zoom' as const] : []),
        ...(params.rotation !== undefined ? ['rotation' as const] : []),
      ];
    case 'path': {
      const properties = new Set<CameraProperty>();
      for (const keyframe of params.keyframes) {
        if (keyframe.position !== undefined) properties.add('position');
        if (keyframe.zoom !== undefined) properties.add('zoom');
        if (keyframe.rotation !== undefined) properties.add('rotation');
      }
      return [...properties];
    }
    case 'reset':
      return ['position', 'zoom', 'rotation'];
    case 'hitchcock':
      return ['position', 'zoom'];
    case 'follow':
    case 'shake':
      return [];
  }
}
