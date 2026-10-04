export interface TextLayerConfig {
  id: string;
  text: string;
  position?: [number, number];
  scale?: number;
  rotation?: number;
  opacity?: number;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  stroke?: string;
  strokeThickness?: number;
  dropShadow?: boolean;
  dropShadowColor?: string;
  dropShadowAlpha?: number;
  dropShadowBlur?: number;
  dropShadowDistance?: number;
  style?: 'typewriter' | 'fadeIn' | 'cinematic' | 'instant';
  duration?: number;
  wordWrapWidth?: number;
}

export interface TextLayerTransformConfig {
  id: string;
  position?: [number, number];
  scale?: number;
  rotation?: number;
  opacity?: number;
  duration: number;
  ease?: string;
}
