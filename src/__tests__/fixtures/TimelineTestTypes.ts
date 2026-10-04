import type { SceneAudio, SceneMeta } from '../../api/types/scene-common';
import type { SceneVisualBlock } from '../../api/types/visual';

export interface LooseTimelineAction {
  _id?: string;
  _seq?: number;
  time?: number;
  action: string;
  params: Record<string, any>;
  _explicit?: string[];
}

export interface LooseTimelineScene {
  sceneId: string;
  meta: SceneMeta;
  audio?: SceneAudio;
  visual?: SceneVisualBlock;
  timeline: LooseTimelineAction[];
}
