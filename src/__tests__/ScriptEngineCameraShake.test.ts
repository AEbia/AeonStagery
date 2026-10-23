// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

vi.mock('../engine/Live2DManager', () => ({ live2DManager: { setScriptEngine: vi.fn() } }));

import ScriptEngine from '../engine/ScriptEngine';
import { cameraController } from '../engine/CameraController';
import { CameraCoordinator } from '../engine/coordinators/CameraCoordinator';
import { scheduleCameraShake, scheduleCameraReset } from '../engine/actions/cameraActions';
import type { SchedulerContext } from '../engine/actions/types';
import type { RuntimeTimelineAction, RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';
import { projectToScreen } from '../engine/Projection';

describe('scene camera shake playback and seek', () => {
  afterEach(() => {
    gsap.globalTimeline.clear();
    cameraController.init();
  });

  it('renders repeatable shake frames across reset, backward seek and multiple scheduled effects', () => {
    const engine = new ScriptEngine();
    const actions: RuntimeTimelineAction[] = [
      { _id: 'first', action: 'cameraShake', time: 1, params: { intensity: 1, frequency: 8, duration: 2 } },
      { _id: 'reset', action: 'cameraReset', time: 2, params: { duration: 0 } },
      { _id: 'second', action: 'cameraShake', time: 3, params: { intensity: 1, frequency: 8, duration: 1 } },
    ];
    const scene: RuntimeTimelineScene = { sceneId: 'shake', meta: { title: 'Shake', characters: [] }, timeline: actions };
    const master = gsap.timeline({ paused: true });
    const context = { tl: master, cameraStateDriven: true } as SchedulerContext;
    for (const action of actions) {
      if (action.action === 'cameraShake') scheduleCameraShake(context, action);
      else scheduleCameraReset(context, action);
    }
    Reflect.set(engine, 'currentScene', scene);
    Reflect.set(engine, 'masterTimeline', master);
    const project = () => projectToScreen({ x: 960, y: 540, scale: 1 }, engine.getCurrentCamera(), { w: 1920, h: 1080 });
    const coordinator = new CameraCoordinator(cameraController);
    // Like the engine, synchronize scene-owned effects on timeline updates;
    // rendering reads only consume the resulting camera state.
    master.eventCallback('onUpdate', () => { coordinator.sync(master.time(), actions); });

    master.seek(1.2, false);
    const playback = project();
    expect(playback.screenX).not.toBe(960);
    expect(master.duration()).toBe(4);
    master.seek(2.2, false);
    expect(project().screenX).toBe(960);
    master.seek(3.2, false);
    expect(project().screenX).not.toBe(960);
    master.seek(0, true);
    coordinator.sync(0, actions);
    expect(project().screenX).toBe(960);
    master.seek(1.2, true);
    coordinator.sync(1.2, actions);
    expect(project()).toEqual(playback);
    master.seek(4, true);
    coordinator.sync(4, actions);
    expect(project().screenX).toBe(960);
  });
});
