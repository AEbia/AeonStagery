import type { SceneAudio, SceneMeta } from '../api/types/scene-common';
import type { RuntimeActionType } from '../api/types/semantic-scene';
import type { SceneVisualBlock } from '../api/types/visual';

export interface RuntimeTimelineAction {
  /**
   * Stable action identity, always populated by the prepared-scene converter
   * (PreparedRuntimeScene maps the compiled action `id`). MUST be unique within
   * a timeline: ScriptEngine's reload diff keys its per-action signature map on
   * this field, so a missing or duplicate id would under-count changes and
   * could wrongly skip a genuine reload. Uniqueness is a compiler invariant.
   */
  readonly _id: string;
  readonly _seq?: number;
  readonly time?: number;
  readonly action: RuntimeActionType;
  // Runtime actions pass through legacy camera/environment readers outside
  // this scheduler boundary, which still depend on open-ended payload fields.
  // Keep that compatibility shape until those readers can narrow it together.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- compiled payloads are extensible and downstream readers remain dynamic
  readonly params: Record<string, any>;
  readonly _explicit?: readonly string[];
}

export interface RuntimeTimelineScene {
  readonly sceneId: string;
  readonly meta: SceneMeta;
  readonly audio?: SceneAudio;
  readonly visual?: SceneVisualBlock;
  readonly timeline: readonly RuntimeTimelineAction[];
}
