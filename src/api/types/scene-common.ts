export interface SceneMeta {
  title: string;
  author?: string;
  resolution?: [number, number];
  fps?: number;
  /** Character ID to Metadata (Alias, etc) mapping */
  characters?: Array<{
    id: string;
    name: string;
    model?: string;
    color?: string;
    voiceProfileId?: string;
    variants?: Array<{ name: string; model: string }>;
  }>;
  /** Timeline markers */
  markers?: SceneMarker[];
}

export interface SceneMarker {
  markerId: string;
  time: number;
  label: string;
  color?: string;
  role?: MarkerRole;
}

export type MarkerRole = 'note' | 'beat' | 'lens-boundary';

export interface SceneAudio {
  bgm?: {
    file: string;
    volume?: number;
    fadeIn?: number;
    loop?: boolean;
  };
}
