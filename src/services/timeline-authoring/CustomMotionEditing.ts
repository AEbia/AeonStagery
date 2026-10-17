import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import type { CollaborationLeaseTargetV3 } from '../../api/types/collaboration';
import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { SemanticAuthoringApplicationService } from './SemanticAuthoringApplicationService';
import type { CustomMotionEditAuthority, HeldCustomMotionLease } from './CustomMotionEditAuthority';
import {
  applyCustomMotionKeyframeEdits, assertValidCustomMotionEdit, customMotionFingerprint,
  type CustomMotionKeyframeEdit,
} from './customMotionKeyframeEdits';
import { buildCurvePresetSegment } from './customMotionCurvePresets';
import type {
  CustomMotion, CustomMotionCloseReason, CustomMotionCommitOutcome, CustomMotionEditIntent,
  CustomMotionEditingModule, CustomMotionEditSession, CustomMotionEditSessionSnapshot,
  CustomMotionEditTarget, CustomMotionKeyframeIdentity, CustomMotionOpenOutcome, CustomMotionPreviewOutcome,
} from './CustomMotionEditingTypes';

export type { CustomMotionEditingModule } from './CustomMotionEditingTypes';

export interface CustomMotionPreviewProjection {
  apply(input: { characterId: string; motion: CustomMotion; blockTime: number }): void;
  clear(): Promise<void>;
}

interface ResolvedTarget {
  target: NonNullable<CustomMotionEditSessionSnapshot['target']>;
  motion: CustomMotion;
  fps: number;
  path: string | null;
}

interface SessionRecord extends ResolvedTarget {
  readonly id: number;
  readonly controller: AbortController;
  readonly handle: CustomMotionEditSession;
  readonly readyResolve: (result: CustomMotionOpenOutcome) => void;
  readonly authority: CustomMotionEditAuthority;
  state: CustomMotionEditSessionSnapshot['state'];
  reason?: string;
  candidate: CustomMotion | null;
  refs: Map<CustomMotionKeyframeIdentity, { parameterId: string; time: number }>;
  revision: number;
  stageApplied: boolean;
  stageClear?: Promise<void>;
  stageClearing?: boolean;
  transitionReady: boolean;
  closing: boolean;
  entered: boolean;
  lease?: HeldCustomMotionLease;
  unsubscribeLoss?: () => void;
  opening?: Promise<void>;
  committing?: Promise<CustomMotionCommitOutcome>;
  closingPromise?: Promise<void>;
  releasing?: Promise<void>;
}

const CLOSED_SNAPSHOT: CustomMotionEditSessionSnapshot = Object.freeze({
  state: 'closed', session: null, target: null, fps: 60, canonicalMotion: null,
  motion: null, keyframes: Object.freeze([]), committing: false,
});

/** Owns the single application-scoped edit session, candidate and authority. */
export class CustomMotionEditing implements CustomMotionEditingModule {
  private active: SessionRecord | null = null;
  private snapshot = CLOSED_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeDocument: () => void;
  private transition: Promise<void> = Promise.resolve();
  private authorityTransition: Promise<void> = Promise.resolve();
  private authority: CustomMotionEditAuthority;
  private generation = 0;
  private disposed = false;
  private disposal?: Promise<void>;
  private conversion: { cancel: () => void; complete: () => void } | null = null;

  constructor(private readonly options: {
    store: DocumentStore;
    authoring: SemanticAuthoringApplicationService;
    authority: CustomMotionEditAuthority;
    preview?: CustomMotionPreviewProjection;
  }) {
    this.authority = options.authority;
    this.unsubscribeDocument = options.store.subscribe(() => this.refresh());
  }

  open(target: CustomMotionEditTarget): CustomMotionEditSession {
    return this.start(target);
  }

  getSnapshot = (): CustomMotionEditSessionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Composition-root lifecycle; absent from the UI's editing interface. */
  async replaceAuthority(authority: CustomMotionEditAuthority): Promise<void> {
    const previous = this.authority;
    // Invalidate synchronously, then finish entered writes before releasing.
    const closing = this.closeActive('authority-changed');
    this.authority = authority;
    const transition = this.authorityTransition.then(async () => {
      try { await closing; }
      finally {
        previous.dispose();
        if (this.disposed) authority.dispose();
      }
    });
    this.authorityTransition = transition.catch(() => {});
    return transition;
  }

  /** Internal conversion seam: the issuer and opaque lease never reach UI. */
  async adoptLease(target: CustomMotionEditTarget, authority: CustomMotionEditAuthority, lease: HeldCustomMotionLease): Promise<boolean> {
    if (this.disposed || authority !== this.authority) return false;
    const session = this.start(target, { authority, lease });
    return (await session.ready).status === 'held';
  }

  getAuthority(): CustomMotionEditAuthority { return this.authority; }

  /** Internal short-transaction reservation shares the editor acquisition barrier. */
  reserveConversion(cancel: () => void): { ready: Promise<void>; complete: () => void } {
    const ready = this.closeActive('conversion');
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const reservation = {
      cancel,
      complete: () => {
        if (this.conversion === reservation) this.conversion = null;
        finish();
      },
    };
    this.conversion = reservation;
    this.transition = Promise.all([this.transition, ready, done]).then(() => {}).catch(() => {});
    return { ready, complete: reservation.complete };
  }

  closeActive(reason: CustomMotionCloseReason): Promise<void> {
    this.conversion?.cancel();
    const record = this.active;
    if (!record) return this.transition;
    this.active = null;
    this.publish();
    const closing = this.closeRecord(record, reason);
    this.transition = Promise.all([this.transition, closing]).then(() => {}).catch(() => {});
    return closing;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.unsubscribeDocument();
    const closing = this.closeActive('disposed');
    this.disposal = (async () => {
      try {
        await closing;
        await this.authorityTransition;
      } finally {
        this.authority.dispose();
        this.listeners.clear();
      }
    })();
    return this.disposal;
  }

  private start(target: CustomMotionEditTarget, adopted?: { authority: CustomMotionEditAuthority; lease: HeldCustomMotionLease }): CustomMotionEditSession {
    this.conversion?.cancel();
    const previous = this.active;
    const resolved = !this.disposed ? resolveCustomMotionEditTarget(this.options.store, target) : null;
    if (!resolved) {
      void this.closeActive('switch-target');
      if (adopted) void adopted.authority.release(adopted.lease);
      return Object.freeze({
        ready: Promise.resolve({ status: 'invalid-target' as const }),
        preview: () => ({ status: 'rejected' as const, reason: 'invalid-target' }),
        commit: async () => ({ status: 'dropped' as const, reason: 'invalid-target' }),
        close: async () => {},
      });
    }
    let readyResolve!: SessionRecord['readyResolve'];
    const ready = new Promise<CustomMotionOpenOutcome>((resolve) => { readyResolve = resolve; });
    const record: SessionRecord = {
      ...resolved, id: ++this.generation, controller: new AbortController(), readyResolve,
      authority: adopted?.authority ?? this.authority, state: 'pending', candidate: null,
      refs: new Map(), revision: 0, stageApplied: false, transitionReady: false, closing: false, entered: false,
      handle: Object.freeze({
        ready,
        preview: (intent: CustomMotionEditIntent | null) => this.preview(record, intent),
        commit: () => this.commit(record),
        close: (reason: CustomMotionCloseReason = 'closed') => {
          if (this.active === record) return this.closeActive(reason);
          return this.closeRecord(record, reason);
        },
      }),
    };
    this.rebuildRefs(record);
    this.active = record;
    this.publish();
    const closing = previous ? this.closeRecord(previous, 'switch-target').catch(() => {}) : this.transition;
    record.opening = this.transition = Promise.all([closing, this.authorityTransition]).then(async () => {
      record.transitionReady = true;
      if (!this.isCurrent(record)) {
        if (adopted) await adopted.authority.release(adopted.lease);
        readyResolve({ status: 'closed' });
        return;
      }
      this.applyPreview(record);
      const decision = adopted
        ? { status: 'granted' as const, lease: adopted.lease }
        : await record.authority.acquire(leaseTarget(record), record.controller.signal);
      if (!this.isCurrent(record) || record.state !== 'pending') {
        if (decision.status === 'granted') await record.authority.release(decision.lease);
        readyResolve({ status: record.state === 'readonly' ? 'readonly' : 'closed', ...(record.reason ? { reason: record.reason } : {}) });
        return;
      }
      if (decision.status === 'denied') {
        this.readonly(record, decision.reason);
        readyResolve({ status: 'readonly', reason: decision.reason });
        return;
      }
      record.lease = decision.lease;
      record.state = 'held';
      record.unsubscribeLoss = record.authority.onLoss(decision.lease, (reason) => this.readonly(record, reason));
      if (record.state === 'held') this.applyPreview(record);
      this.publish();
      readyResolve(record.state === 'held' ? { status: 'held' } : { status: 'readonly', reason: record.reason });
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'lease-denied';
      if (this.isCurrent(record)) this.readonly(record, reason);
      readyResolve({ status: record.closing ? 'closed' : 'readonly', reason });
    });
    return record.handle;
  }

  private preview(record: SessionRecord, intent: CustomMotionEditIntent | null): CustomMotionPreviewOutcome {
    // Playhead updates cancel selection on every seek tick. With no candidate,
    // cancellation must not clone/fingerprint the scene or republish all refs.
    // Document changes are already validated by the store subscription.
    if (!intent && !record.candidate && this.isCurrent(record)
      && record.state !== 'readonly' && !record.committing) {
      return { status: 'cleared' };
    }
    this.refresh();
    if (!this.isCurrent(record) || record.state === 'readonly' || record.committing) {
      return { status: 'rejected', reason: record.reason ?? 'session-closed' };
    }
    if (!intent) {
      this.clearCandidate(record);
      this.publish();
      return { status: 'cleared' };
    }
    try {
      const candidate = applyCustomMotionKeyframeEdits(record.motion, lowerIntent(record, intent));
      assertValidCustomMotionEdit(candidate);
      record.candidate = freezeMotion(candidate);
      this.applyPreview(record);
      this.publish();
      return { status: 'previewed', motion: record.candidate };
    } catch (error) {
      return { status: 'rejected', reason: error instanceof Error ? error.message : 'invalid-edit' };
    }
  }

  private commit(record: SessionRecord): Promise<CustomMotionCommitOutcome> {
    if (record.committing) return record.committing;
    if (!this.isCurrent(record) || record.state === 'readonly' || !record.candidate) {
      return Promise.resolve({ status: 'dropped', reason: record.reason ?? 'no-preview' });
    }
    const candidate = record.candidate;
    const fingerprint = customMotionFingerprint(record.motion);
    const fps = record.fps;
    const task = (async (): Promise<CustomMotionCommitOutcome> => {
      await record.handle.ready;
      if (!this.isCurrent(record) || record.state !== 'held' || !record.lease) return { status: 'dropped', reason: record.reason ?? 'session-closed' };
      if (customMotionFingerprint(candidate) === fingerprint) {
        this.clearCandidate(record);
        return { status: 'no_change' };
      }
      try {
        await this.options.authoring.authorTransaction((document) => {
          // Check again after all preceding local writes in the authoring queue.
          const current = resolveCustomMotionInDocument(document, record.target);
          const binding = resolveCharacterId(document, record.target);
          if (!this.isCurrent(record) || record.state !== 'held' || !record.lease
            || !current || document.sceneId !== record.target.sceneId || (document.meta.fps ?? 60) !== fps
            || binding !== record.target.characterId
            || customMotionFingerprint(current) !== fingerprint) {
            throw new DroppedMotionCommit();
          }
          record.entered = true;
          return [{
            version: AUTHORING_SCHEMA_VERSION, correlationId: `custom-motion-session-${record.id}`,
            origin: 'timeline-editor', kind: 'update-custom-motion-keyframes',
            locator: { statementId: record.target.statementId, ...(record.target.companionId ? { companionId: record.target.companionId } : {}) },
            motion: candidate,
          }];
        });
        if (this.isCurrent(record)) {
          record.motion = candidate;
          record.candidate = null;
          this.rebuildRefs(record);
        }
        await this.clearStage(record);
        return { status: 'committed' };
      } catch (error) {
        this.clearCandidate(record);
        if (error instanceof DroppedMotionCommit) {
          if (this.isCurrent(record)) this.refresh();
          return { status: 'dropped', reason: record.reason ?? 'entity-changed' };
        }
        throw error;
      } finally { record.entered = false; }
    })();
    record.committing = task;
    this.publish();
    void task.finally(() => { record.committing = undefined; if (this.active === record) this.publish(); }).catch(() => {});
    return task;
  }

  private isCurrent(record: SessionRecord): boolean {
    return this.active === record && !record.closing && !this.disposed;
  }

  private readonly(record: SessionRecord, reason: string): void {
    if (!this.isCurrent(record)) return;
    record.state = 'readonly';
    record.reason = reason;
    record.controller.abort();
    this.clearCandidate(record);
    this.publish();
    // Keep ownership until an already-entered transaction has settled.
    void (record.committing ?? Promise.resolve()).catch(() => {}).then(() => this.release(record));
  }

  private closeRecord(record: SessionRecord, reason: CustomMotionCloseReason): Promise<void> {
    if (record.closingPromise) return record.closingPromise;
    record.closing = true;
    record.state = 'closed';
    record.reason = reason;
    record.controller.abort();
    record.readyResolve({ status: 'closed', reason });
    record.closingPromise = (async () => {
      await record.committing?.catch(() => {});
      await record.opening;
      record.candidate = null;
      try { await this.clearStage(record); }
      finally { await this.release(record); }
    })();
    return record.closingPromise;
  }

  private async release(record: SessionRecord): Promise<void> {
    record.unsubscribeLoss?.();
    record.unsubscribeLoss = undefined;
    const lease = record.lease;
    record.lease = undefined;
    if (lease) record.releasing = record.authority.release(lease);
    await record.releasing;
  }

  private applyPreview(record: SessionRecord): void {
    if (!record.candidate || !record.transitionReady || record.stageClearing || !this.isCurrent(record) || record.state === 'readonly') return;
    this.options.preview?.apply({ characterId: record.target.characterId, motion: record.candidate, blockTime: record.target.blockTime });
    record.stageApplied = true;
  }

  private async clearStage(record: SessionRecord): Promise<void> {
    if (!record.stageApplied) return record.stageClear;
    record.stageApplied = false;
    record.stageClearing = true;
    record.stageClear = Promise.resolve(this.options.preview?.clear()).finally(() => {
      record.stageClearing = false;
      this.applyPreview(record);
    });
    await record.stageClear;
  }

  private clearCandidate(record: SessionRecord): void {
    record.candidate = null;
    void this.clearStage(record).catch(() => {});
  }

  private refresh(): void {
    const record = this.active;
    if (!record || record.closing) return;
    const document = this.options.store.getCurrentSceneDocumentView();
    const current = document && resolveCustomMotionInDocument(document, record.target);
    if (!document || document.sceneId !== record.target.sceneId || this.options.store.filePath !== record.path || !current) {
      void this.closeActive('scene-changed');
      return;
    }
    const fps = document.meta.fps ?? 60;
    const characterId = resolveCharacterId(document, record.target);
    if (characterId !== record.target.characterId) {
      record.target = { ...record.target, characterId };
      this.readonly(record, 'target-changed');
    }
    if (current !== record.motion && customMotionFingerprint(current) !== customMotionFingerprint(record.motion)) {
      const fingerprint = customMotionFingerprint(current);
      const ownWrite = record.entered && record.candidate && fingerprint === customMotionFingerprint(record.candidate);
      if (!ownWrite) {
        record.motion = current;
        this.rebuildRefs(record);
        this.readonly(record, 'motion-changed');
      }
    }
    if (fps !== record.fps) {
      record.fps = fps;
      this.clearCandidate(record);
      this.rebuildRefs(record);
      this.publish();
    }
    const compiled = this.options.store.getCompiledSceneSnapshot()?.actions.find((action) => action.id === record.target.actionId);
    if (compiled && compiled.time !== record.target.blockTime) {
      record.target = { ...record.target, blockTime: compiled.time };
      this.applyPreview(record);
      this.publish();
    }
  }

  private rebuildRefs(record: SessionRecord): void {
    record.refs.clear();
    const prefix = `${record.id}:${++record.revision}:`;
    let index = 0;
    for (const track of record.motion.tracks) for (const point of track.keyframes) {
      record.refs.set(`${prefix}${index++}` as CustomMotionKeyframeIdentity, { parameterId: track.parameterId, time: point.time });
    }
  }

  private publish(): void {
    const record = this.active;
    this.snapshot = record ? Object.freeze({
      state: record.state, session: record.handle, target: Object.freeze({ ...record.target }), fps: record.fps,
      canonicalMotion: record.motion, motion: record.candidate ?? record.motion, committing: !!record.committing,
      keyframes: Object.freeze([...record.refs].map(([ref, point]) => Object.freeze({ ref, ...point, frame: point.time * record.fps }))),
      ...(record.reason ? { reason: record.reason } : {}),
    }) : CLOSED_SNAPSHOT;
    for (const listener of this.listeners) listener();
  }
}

class DroppedMotionCommit extends Error {}

function leaseTarget(record: SessionRecord): CollaborationLeaseTargetV3 {
  return record.target.companionId
    ? { kind: 'companion', statementId: record.target.statementId, companionId: record.target.companionId }
    : { kind: 'statement', statementId: record.target.statementId };
}

export function resolveCustomMotionEditTarget(store: DocumentStore, target: CustomMotionEditTarget): ResolvedTarget | null {
  const document = store.getCurrentSceneDocumentView();
  if (!document) return null;
  const compiled = store.getCompiledSceneSnapshot()?.actions.find((action) => 'actionId' in target
    ? action.id === target.actionId
    : action.action === 'playMotion' && action.source.statementId === target.statementId && action.source.companionId === target.companionId);
  if ('actionId' in target && compiled?.action !== 'playMotion') return null;
  const locator = 'actionId' in target ? compiled?.source : target;
  if (!locator) return null;
  const entity = resolvePerformance(document, locator);
  const motion = entity?.params.motion;
  if (!entity || !motion || typeof motion !== 'object' || (motion as { kind?: string }).kind !== 'custom') return null;
  const characterId = resolveCharacterId(document, locator);
  return {
    target: { actionId: compiled?.id ?? '', sceneId: document.sceneId, statementId: locator.statementId,
      ...(locator.companionId ? { companionId: locator.companionId } : {}), characterId, blockTime: compiled?.time ?? entity.time ?? 0 },
    motion: motion as CustomMotion, fps: document.meta.fps ?? 60, path: store.filePath,
  };
}

export function resolvePerformance(document: CurrentSceneDocument, target: { statementId: string; companionId?: string }): Extract<SceneStatement, { type: 'characterPerformance' }> | null {
  const parent = document.statements.find((statement) => statement.id === target.statementId);
  const entity = target.companionId ? parent?.companions?.find((companion) => companion.id === target.companionId) : parent;
  return entity?.type === 'characterPerformance' ? entity as Extract<SceneStatement, { type: 'characterPerformance' }> : null;
}

function resolveCustomMotionInDocument(document: CurrentSceneDocument, target: { statementId: string; companionId?: string }): CustomMotion | null {
  const motion = resolvePerformance(document, target)?.params.motion;
  return motion && typeof motion === 'object' && (motion as { kind?: string }).kind === 'custom' ? motion as CustomMotion : null;
}

function resolveCharacterId(document: CurrentSceneDocument, target: { statementId: string; companionId?: string }): string {
  const entity = resolvePerformance(document, target);
  const parent = document.statements.find((statement) => statement.id === target.statementId);
  return entity?.params.target === '$speaker'
    ? String(parent?.type === 'dialogue' ? parent.params.speakerId ?? '' : '')
    : String(entity?.params.target ?? '');
}

function lowerIntent(record: SessionRecord, intent: CustomMotionEditIntent): CustomMotionKeyframeEdit[] {
  const seconds = (frame: number) => {
    if (!Number.isSafeInteger(frame)) throw new Error('Motion edits require integer scene frames');
    return frame / record.fps;
  };
  const point = (ref: CustomMotionKeyframeIdentity) => {
    const found = record.refs.get(ref);
    if (!found) throw new Error('Keyframe reference belongs to another Motion revision');
    return found;
  };
  switch (intent.type) {
    case 'batch': return intent.intents.flatMap((item) => lowerIntent(record, item));
    case 'insert-keyframe': return [{ type: intent.type, trackParameterId: intent.parameterId, time: seconds(intent.frame), value: intent.value }];
    case 'update-keyframe': {
      const ref = point(intent.keyframe);
      return [{ type: intent.type, trackParameterId: ref.parameterId, time: ref.time, value: intent.value,
        ...(intent.frame !== undefined ? { newTime: seconds(intent.frame) } : {}) }];
    }
    case 'remove-keyframe': {
      const ref = point(intent.keyframe);
      return [{ type: intent.type, trackParameterId: ref.parameterId, time: ref.time }];
    }
    case 'move-keyframes': {
      seconds(intent.deltaFrames);
      const refs = intent.keyframes.map(point);
      return [{ type: intent.type, keyframes: refs, deltaTime: intent.deltaFrames / record.fps, deltaValue: intent.deltaValue,
        targetTimes: refs.map((ref) => ({ ...ref, targetTime: intent.deltaFrames === 0 ? ref.time : Math.round(ref.time * record.fps + intent.deltaFrames) / record.fps })) }];
    }
    case 'set-duration': return [{ type: intent.type, durationSeconds: seconds(intent.frames) }];
    case 'set-fade-in': return [{ type: intent.type, trackParameterId: intent.parameterId, fadeInSeconds: intent.frames === null ? null : seconds(intent.frames) }];
    case 'set-curve':
    case 'set-curve-preset':
    case 'set-control-point': {
      const ref = point(intent.keyframe);
      const track = record.motion.tracks.find((item) => item.parameterId === ref.parameterId)!;
      const index = track.keyframes.findIndex((item) => item.time === ref.time);
      const current = track.keyframes[index];
      const next = track.keyframes[index + 1];
      if (!next) throw new Error('The final keyframe has no outgoing curve');
      let segment = current.segment!;
      if (intent.type === 'set-curve-preset') {
        const preset = buildCurvePresetSegment(intent.presetId, current, next);
        if (!preset) throw new Error('Unknown curve preset');
        segment = preset;
      } else if (intent.type === 'set-curve') {
        segment = intent.curve === 'bezier'
          ? { type: 'bezier', controlPoints: [
            { time: current.time + (next.time - current.time) / 3, value: current.value },
            { time: current.time + (next.time - current.time) * 2 / 3, value: next.value },
          ] }
          : { type: intent.curve };
      } else {
        if (segment.type !== 'bezier') throw new Error('The selected curve is not Bezier');
        const [left, right] = segment.controlPoints;
        seconds(intent.frame);
        const minFrame = Math.ceil((intent.index === 0 ? current.time : left.time) * record.fps - 1e-9);
        const maxFrame = Math.floor((intent.index === 0 ? right.time : next.time) * record.fps + 1e-9);
        if (minFrame > maxFrame) throw new Error('The control-point bounds contain no scene frame');
        const time = Math.max(minFrame, Math.min(maxFrame, intent.frame)) / record.fps;
        const changed = { time, value: intent.value };
        segment = { type: 'bezier', controlPoints: [intent.index === 0 ? changed : left, intent.index === 1 ? changed : right] };
      }
      return [{ type: 'set-segment', trackParameterId: ref.parameterId, time: ref.time, segment }];
    }
  }
}

function freezeMotion(motion: CustomMotion): CustomMotion {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(motion);
  return motion;
}
