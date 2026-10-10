import type { CharacterMotionOutput, CustomMotionSegment } from '../../api/types/semantic-scene';

export type CustomMotion = Extract<CharacterMotionOutput, { kind: 'custom' }>;
export type CustomMotionEditTarget = { readonly actionId: string } | {
  readonly statementId: string;
  readonly companionId?: string;
};

declare const keyframeIdentity: unique symbol;
/** Valid only for the canonical Motion revision of the owning session. */
export type CustomMotionKeyframeIdentity = string & { readonly [keyframeIdentity]: true };

export type CustomMotionEditIntent =
  | { readonly type: 'batch'; readonly intents: readonly CustomMotionEditIntent[] }
  | { readonly type: 'insert-keyframe'; readonly parameterId: string; readonly frame: number; readonly value: number }
  | { readonly type: 'update-keyframe'; readonly keyframe: CustomMotionKeyframeIdentity; readonly value: number; readonly frame?: number }
  | { readonly type: 'remove-keyframe'; readonly keyframe: CustomMotionKeyframeIdentity }
  | { readonly type: 'move-keyframes'; readonly keyframes: readonly CustomMotionKeyframeIdentity[]; readonly deltaFrames: number; readonly deltaValue?: number }
  | { readonly type: 'set-curve'; readonly keyframe: CustomMotionKeyframeIdentity; readonly curve: CustomMotionSegment['type'] }
  | { readonly type: 'set-curve-preset'; readonly keyframe: CustomMotionKeyframeIdentity; readonly presetId: string }
  | { readonly type: 'set-control-point'; readonly keyframe: CustomMotionKeyframeIdentity; readonly index: 0 | 1; readonly frame: number; readonly value: number }
  | { readonly type: 'set-duration'; readonly frames: number }
  | { readonly type: 'set-fade-in'; readonly parameterId?: string; readonly frames: number | null };

export type CustomMotionCloseReason = 'closed' | 'switch-target' | 'scene-changed' | 'project-changed'
  | 'authority-changed' | 'disposed' | 'conversion';
export type CustomMotionOpenOutcome = { readonly status: 'held' | 'readonly' | 'closed' | 'invalid-target'; readonly reason?: string };
export type CustomMotionPreviewOutcome = { readonly status: 'previewed'; readonly motion: CustomMotion }
  | { readonly status: 'cleared' | 'rejected'; readonly reason?: string };
export type CustomMotionCommitOutcome = { readonly status: 'committed' | 'no_change' | 'dropped'; readonly reason?: string };

export interface CustomMotionEditSession {
  readonly ready: Promise<CustomMotionOpenOutcome>;
  preview(intent: CustomMotionEditIntent | null): CustomMotionPreviewOutcome;
  commit(): Promise<CustomMotionCommitOutcome>;
  close(reason?: CustomMotionCloseReason): Promise<void>;
}

export interface CustomMotionEditSessionSnapshot {
  readonly state: 'pending' | 'held' | 'readonly' | 'closed';
  readonly session: CustomMotionEditSession | null;
  readonly target: {
    readonly actionId: string;
    readonly sceneId: string;
    readonly statementId: string;
    readonly companionId?: string;
    readonly characterId: string;
    readonly blockTime: number;
  } | null;
  readonly fps: number;
  readonly canonicalMotion: CustomMotion | null;
  readonly motion: CustomMotion | null;
  readonly keyframes: readonly {
    readonly ref: CustomMotionKeyframeIdentity;
    readonly parameterId: string;
    readonly time: number;
    readonly frame: number;
  }[];
  readonly committing: boolean;
  readonly reason?: string;
}

/** The same interface is consumed by the UI and by session contract tests. */
export interface CustomMotionEditingModule {
  open(target: CustomMotionEditTarget): CustomMotionEditSession;
  getSnapshot(): CustomMotionEditSessionSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}
