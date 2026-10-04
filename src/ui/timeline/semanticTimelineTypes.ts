import type { SceneMeta } from '../../api/types/scene-common';
import type { StatementCategory, StatementFamily } from '../../api/types/semantic-scene';
import type { SceneVisualBlock } from '../../api/types/visual';

/** Runtime projection used only for timeline presentation and selection. */
export interface TimelineAction {
  _id?: string;
  _seq?: number;
  time?: number;
  action: string;
  params: Record<string, any>;
  semanticType?: StatementFamily;
  semanticCategory?: StatementCategory;
  semanticLabel?: string;
  semanticIconKey?: string;
  /** Source statement/companion params carried for the semantic inspector cutover. */
  sourceParams?: Record<string, any>;
  /**
   * ADR-0022 placeholder presentation only: for uncompiled characterPerformance
   * companions whose target is the literal `$speaker` token, the parent
   * dialogue speakerId resolved by the read model. Never written into source.
   */
  resolvedSpeakerId?: string;
  /** Semantic statement ID owning this action */
  statementId?: string;
  /** Dialogue companion ID owning this action if applicable */
  companionId?: string;
}

export interface TimelineScene {
  sceneId: string;
  meta: SceneMeta;
  visual?: SceneVisualBlock;
  timeline: TimelineAction[];
}
