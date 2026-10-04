import type { CameraEasing } from '../../api/types/camera';

/** Maps semantic easing names to GSAP easing strings */
export const CAMERA_EASING_MAP: Record<CameraEasing, string> = {
  smooth:      'power2.inOut',
  accelerate:  'power3.in',
  overshoot:   'back.out(1.5)',
  linear:      'none',
  decelerate:  'power3.out',
  bounce:      'bounce.out',
  anticipate:  'back.inOut(1.5)',
  hesitate:    'power4.inOut',
};
