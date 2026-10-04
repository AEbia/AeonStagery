

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;
export const BACKGROUND_LAYER_ID = 'background';

export type EnvironmentLayoutMode = 'cover' | 'tile';
export type EnvironmentTransition = 'none' | 'fadeIn' | 'crossFade' | 'fadeOut';

export interface EnvironmentLayerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  z: number;
}

export interface EnvironmentLayerState extends Partial<EnvironmentLayerTransform> {
  layerId: string;
  image?: string;
  label?: string;
  layoutMode?: EnvironmentLayoutMode;
  tileScaleX?: number;
  tileScaleY?: number;
  tileOffsetX?: number;
  tileOffsetY?: number;
}

export interface EnvironmentLayerSnapshot {
  state: EnvironmentLayerState;
  active: boolean;
}

export interface EnvironmentLayerRenderImage {
  image: string;
  weight: number;
  transform?: Omit<EnvironmentLayerState, 'layerId' | 'image' | 'label'>;
}

export interface EnvironmentLayerRenderState extends EnvironmentLayerState {
  images: EnvironmentLayerRenderImage[];
  opacityMultiplier?: number;
}

export function getDefaultEnvironmentTransform(): EnvironmentLayerTransform {
  return {
    x: 0.5,
    y: 0.5,
    scale: 1,
    rotation: 0,
    opacity: 1,
    z: 0,
  };
}

export function isEnvironmentAction(action: { action: string }): boolean {
  return [
    'setEnvironmentLayer',
    'transformEnvironmentLayer',
    'removeEnvironmentLayer',
  ].includes(action.action);
}

export function isEnvironmentMutationAction(action: { action: string }): boolean {
  return [
    'setEnvironmentLayer',
    'transformEnvironmentLayer',
  ].includes(action.action);
}

export function createEnvironmentState(params: Record<string, any>): EnvironmentLayerState {
  const defaults = getDefaultEnvironmentTransform();
  return {
    layerId: String(params.layerId),
    image: params.image,
    label: params.label,
    layoutMode: params.layoutMode ?? 'cover',
    tileScaleX: params.tileScaleX,
    tileScaleY: params.tileScaleY,
    tileOffsetX: params.tileOffsetX,
    tileOffsetY: params.tileOffsetY,
    x: params.x ?? defaults.x,
    y: params.y ?? defaults.y,
    scale: params.scale ?? defaults.scale,
    rotation: params.rotation ?? defaults.rotation,
    opacity: params.opacity ?? defaults.opacity,
    z: params.z ?? defaults.z,
  };
}
