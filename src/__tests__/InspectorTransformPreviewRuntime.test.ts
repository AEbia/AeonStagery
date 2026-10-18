/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import ScriptEngine from '../engine/ScriptEngine';
import { stageManager } from '../engine/StageManager';
import { live2DManager } from '../engine/Live2DManager';
import { cameraController } from '../engine/CameraController';
import { PlaybackAdapter } from '../api/adapters/PlaybackAdapter';
import { PlaybackStore } from '../ui/store/PlaybackStore';
import type { TransformationProxy } from '../engine/actions/types';
import { inspectorTransformPreview } from '../ui/timeline/useInspectorTransformPreview';

afterEach(() => vi.restoreAllMocks());

describe('inspector runtime transform projection', () => {
  it('forwards typed character and environment previews through PlaybackAdapter', () => {
    const engine = mockDeep<ConstructorParameters<typeof PlaybackAdapter>[1]>();
    engine.isPlaying.mockReturnValue(false);
    engine.onPlayingChange.mockReturnValue(() => {});
    const adapter = new PlaybackAdapter(new PlaybackStore(), engine);
    adapter.previewTransform('alice', { x: 1200, opacity: 0 });
    adapter.previewEnvironmentLayerTransform('background', { x: 0.3, opacity: 0 });
    expect(engine.previewTransform).toHaveBeenCalledWith('alice', { x: 1200, opacity: 0 });
    expect(engine.previewEnvironmentLayerTransform).toHaveBeenCalledWith('background', { x: 0.3, opacity: 0 });
    adapter.dispose();
  });

  it('projects all character geometry fields immediately, including zero opacity', () => {
    const engine = new ScriptEngine();
    const proxy = { x: 960, y: 540, z: 0, scale: 1, rotation: 0, opacity: 1 };
    engine.transformationProxies.set('alice', proxy);
    vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(true);
    const apply = vi.spyOn(live2DManager, 'applyProxyTransform').mockImplementation(() => {});
    const updates = { x: 1300, y: 820, z: 10, scale: 1.5, rotation: 20, opacity: 0 };
    engine.previewTransform('alice', updates);
    expect(engine.transformationProxies.get('alice')).toEqual(updates);
    expect(apply).toHaveBeenCalledWith('alice', engine.transformationProxies.get('alice'), undefined, cameraController.getState());
  });

  it('updates environment proxies and the stage while keeping character addresses separate', () => {
    const engine = new ScriptEngine();
    // Seed the private environment fixture without widening production state.
    const proxies = Reflect.get(engine, 'environmentLayerProxies') as Map<string, TransformationProxy>;
    const proxy = { x: 0.5, y: 0.5, z: 0, scale: 1, rotation: 0, opacity: 1 };
    proxies.set('background', proxy);
    const character = { ...proxy, x: 960, y: 540 };
    engine.transformationProxies.set('background', character);
    const apply = vi.spyOn(stageManager, 'applyEnvironmentLayerTransform').mockImplementation(() => {});
    const updates = { x: 0.3, y: 0.8, z: 5, scale: 1.5, rotation: 30, opacity: 0 };
    engine.previewEnvironmentLayerTransform('background', updates);
    expect(proxy).toEqual(updates);
    expect(character.opacity).toBe(1);
    expect(apply).toHaveBeenCalledWith('background', proxy, cameraController.getState());
    engine.previewEnvironmentLayerTransform('missing', { opacity: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('filters non-transform fields and converts normalized character positions exactly once', () => {
    const action = { _id: 'move', action: 'transformCharacter', params: { id: 'alice' } };
    expect(inspectorTransformPreview(action, { position: [0.25, 0.75], opacity: 0, duration: 10, scale: NaN }))
      .toEqual({ id: 'alice', environment: false, updates: { x: 480, y: 810, opacity: 0 } });
    expect(inspectorTransformPreview({ ...action, action: 'cameraMotion' }, { position: [0.25, 0.75] })).toBeNull();
  });
});
