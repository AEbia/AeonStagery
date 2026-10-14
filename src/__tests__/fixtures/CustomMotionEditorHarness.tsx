import { useMemo, useReducer, useEffect } from 'react';
import { vi } from 'vitest';
import { CustomMotionEditor as Editor, type CustomMotionEditorProps as EditorProps } from '../../ui/timeline/CustomMotionEditor';
import { CustomMotionEditing } from '../../services/timeline-authoring/CustomMotionEditing';
import { InMemoryCustomMotionEditAuthority } from '../../services/timeline-authoring/CustomMotionEditAuthority';
import type { CustomMotion, CustomMotionEditIntent, CustomMotionEditSession, CustomMotionKeyframeIdentity } from '../../services/timeline-authoring/CustomMotionEditingTypes';
import type { DocumentStore } from '../../ui/store/DocumentStore';
import type { SemanticAuthoringApplicationService } from '../../services/timeline-authoring/SemanticAuthoringApplicationService';

/** Fixture inputs; the rendered editor consumes only the public session snapshot. */
export type CustomMotionEditorProps = Omit<EditorProps, 'snapshot'> & {
  blockTime: number;
  motion: CustomMotion;
  fps?: number;
  busy?: boolean;
  leaseState?: 'held' | 'pending' | 'readonly';
  onCommit: (...args: any[]) => unknown;
};

export function createEditorFixture(motion: CustomMotion, fps = 60, blockTime = 0, onCommit: (...args: any[]) => unknown = vi.fn()) {
  const source = {
    schemaVersion: 5, sceneId: 'fixture', meta: { title: 'Fixture', fps },
    statements: [{ id: 'performance', type: 'characterPerformance', time: blockTime, params: { target: 'character', motion } }],
  };
  const store = {
    filePath: null,
    getCurrentSceneDocumentSnapshot: () => source,
    getCurrentSceneDocumentView: () => source,
    getCompiledSceneSnapshot: () => ({ actions: [{ id: 'motion', action: 'playMotion', time: blockTime, source: { statementId: 'performance' } }] }),
    subscribe: () => () => {},
  } as unknown as DocumentStore;
  // Real session previews exercise canonical validation without writing a document.
  // The test records commit intents so gesture assertions remain synchronous.
  const editing = new CustomMotionEditing({ store, authoring: {} as SemanticAuthoringApplicationService, authority: new InMemoryCustomMotionEditAuthority() });
  const underlying = editing.open({ statementId: 'performance' });
  const points = editing.getSnapshot().keyframes;
  const stableRef = (parameterId: string, time: number) => `${parameterId}:${time}` as CustomMotionKeyframeIdentity;
  const resolve = (ref: CustomMotionKeyframeIdentity) => points.find((point) => stableRef(point.parameterId, point.time) === ref)!.ref;
  const mapIntent = (intent: CustomMotionEditIntent): CustomMotionEditIntent => {
    if (intent.type === 'batch') return { ...intent, intents: intent.intents.map(mapIntent) };
    if (intent.type === 'move-keyframes') return { ...intent, keyframes: intent.keyframes.map(resolve) };
    if ('keyframe' in intent) return { ...intent, keyframe: resolve(intent.keyframe) };
    return intent;
  };
  const flatten = (intent: CustomMotionEditIntent): CustomMotionEditIntent[] => intent.type === 'batch' ? intent.intents.flatMap(flatten) : [intent];
  let lastIntent: CustomMotionEditIntent | null = null;
  let committing = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const session: CustomMotionEditSession = {
    ready: underlying.ready,
    preview: vi.fn((intent) => {
      lastIntent = intent;
      const result = underlying.preview(intent ? mapIntent(intent) : null);
      notify();
      return result;
    }),
    commit: vi.fn(async () => {
      committing = true;
      try {
        await onCommit(lastIntent ? flatten(lastIntent) : [], motion);
        return { status: 'committed' as const };
      } finally {
        committing = false;
        underlying.preview(null);
        notify();
      }
    }),
    close: vi.fn(async () => { await underlying.close(); notify(); }),
  };
  return {
    session,
    snapshot: () => ({ ...editing.getSnapshot(), state: 'held' as const, session, committing,
      keyframes: points.map((point) => ({ ...point, ref: stableRef(point.parameterId, point.time) })),
    }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: () => editing.dispose(),
  };
}

export function CustomMotionEditor({ motion, fps = 60, busy = false, leaseState = 'held', onCommit, blockTime, ...props }: CustomMotionEditorProps) {
  const fixture = useMemo(() => createEditorFixture(motion, fps, blockTime, onCommit), [motion, fps, blockTime, onCommit]);
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => fixture.subscribe(rerender), [fixture]);
  useEffect(() => () => { void fixture.dispose(); }, [fixture]);
  return <Editor {...props} snapshot={{ ...fixture.snapshot(), state: busy ? 'readonly' : leaseState }} />;
}
