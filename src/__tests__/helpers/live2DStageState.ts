import type * as PIXI from 'pixi.js';
import type { CharacterEntry } from '../../engine/Live2DConfig';
import type { MotionRequest } from '../../engine/Live2DMotionController';
import type { Live2DStageIntent } from '../../engine/Live2DStageRuntime';

type CharacterFixtures = Omit<Map<string, CharacterEntry>, 'set'> & {
  set(id: string, entry: unknown): void;
};

/** Legacy frame/geometry fixtures seed private state without widening the stage interface. */
export function live2DStageState(target: object) {
  const runtime: object = Reflect.get(target, 'stageRuntime') ?? target;
  const characters = Reflect.get(runtime, 'characters') as Map<string, CharacterEntry>;
  const containers = Reflect.get(runtime, 'containers') as Map<string, PIXI.Container>;
  return {
    get characters(): CharacterFixtures { return characters; },
    set characters(entries: ReadonlyMap<string, unknown>) {
      characters.clear();
      for (const [id, entry] of entries) characters.set(id, entry as CharacterEntry);
    },
    get containers(): Map<string, PIXI.Container> { return containers; },
    set containers(entries: ReadonlyMap<string, unknown>) {
      containers.clear();
      for (const [id, container] of entries) containers.set(id, container as PIXI.Container);
    },
    pendingMotions: Reflect.get(runtime, 'pendingMotions') as Map<string, MotionRequest[]>,
    motionMutex: Reflect.get(runtime, 'motionMutex') as Map<string, Promise<void>>,
    pendingIntents: Reflect.get(runtime, 'pendingIntents') as Map<string, Map<Live2DStageIntent['kind'], Live2DStageIntent>>,
  };
}
