import { describe, expect, it } from 'vitest';
import { computeSceneStateAtTime } from '../engine/RuntimeSceneState';
import { evaluateCharacterEase } from '../engine/CharacterAnimationContract';

describe('RuntimeSceneState graphic layer reconstruction', () => {
  const scene = {
    sceneId: 'graphic-state',
    meta: { title: 'Graphic state', characters: [] },
    timeline: [
      {
        _id: 'image-add',
        action: 'addImage' as const,
        time: 0,
        params: {
          id: 'poster',
          file: 'images/poster.png',
          position: [0.2, 0.3],
          scale: 1,
          opacity: 1,
          z: 20,
        },
      },
      {
        _id: 'image-transform',
        action: 'transformImage' as const,
        time: 1,
        params: {
          id: 'poster',
          position: [0.8, 0.7],
          scale: 2,
          opacity: 0.5,
          duration: 2,
        },
      },
      {
        _id: 'image-remove',
        action: 'removeImage' as const,
        time: 4,
        params: { id: 'poster', duration: 1 },
      },
      {
        _id: 'text-add',
        action: 'addTextLayer' as const,
        time: 0,
        params: {
          id: 'title',
          text: 'Hello',
          position: [0.5, 0.5],
          style: 'fadeIn',
          duration: 1,
          opacity: 1,
        },
      },
      {
        _id: 'text-transform',
        action: 'transformTextLayer' as const,
        time: 1,
        params: {
          id: 'title',
          position: [0.7, 0.5],
          scale: 2,
          duration: 2,
        },
      },
      {
        _id: 'text-remove',
        action: 'removeTextLayer' as const,
        time: 4,
        params: { id: 'title', duration: 1 },
      },
    ],
  };

  it('rebuilds image and text transforms at a middle timestamp', () => {
    const state = computeSceneStateAtTime(scene, 2);
    const image = state.images.get('poster');
    const text = state.textLayers.get('title');

    expect(image).toEqual(expect.objectContaining({
      file: 'images/poster.png',
      position: [0.5, 0.5],
      scale: 1.5,
      opacity: 0.75,
      z: 20,
    }));
    expect(text).toEqual(expect.objectContaining({
      text: 'Hello',
      position: [0.6, 0.5],
      scale: 1.5,
      opacity: 1,
    }));
  });

  it('keeps fade removal visible during the interval and removes it after completion', () => {
    const duringRemoval = computeSceneStateAtTime(scene, 4.5);
    expect(duringRemoval.images.get('poster')?.opacity).toBeCloseTo(0.25);
    expect(duringRemoval.textLayers.get('title')?.opacity).toBeCloseTo(0.5);

    const afterRemoval = computeSceneStateAtTime(scene, 5);
    expect(afterRemoval.images.has('poster')).toBe(false);
    expect(afterRemoval.textLayers.has('title')).toBe(false);
  });

  it('keeps the latest dialogue visible after its reveal duration until another dialogue starts', () => {
    const dialogueScene = {
      sceneId: 'dialogue-state',
      meta: { title: 'Dialogue state', characters: [] },
      timeline: [
        {
          _id: 'line-1',
          action: 'dialogue' as const,
          time: 1,
          params: { speaker: 'Tomori', text: 'First line', duration: 2 },
        },
        {
          _id: 'camera-hold',
          action: 'cameraMove' as const,
          time: 4,
          params: { duration: 1 },
        },
        {
          _id: 'line-2',
          action: 'dialogue' as const,
          time: 6,
          params: { speaker: 'Tomori', text: 'Second line', duration: 2 },
        },
      ],
    } as any;

    expect(computeSceneStateAtTime(dialogueScene, 0.5).dialogue).toBeNull();
    expect(computeSceneStateAtTime(dialogueScene, 3.5).dialogue)
      .toEqual(expect.objectContaining({ _id: 'line-1', text: 'First line', startTime: 1, duration: 2 }));
    expect(computeSceneStateAtTime(dialogueScene, 6).dialogue)
      .toEqual(expect.objectContaining({ _id: 'line-2', text: 'Second line', startTime: 6, duration: 2 }));
  });

  it('materializes character entrance, transform, and exit with the GSAP ease curve', () => {
    const characterScene = {
      sceneId: 'character-state',
      meta: { title: 'Character state', characters: [] },
      timeline: [
        {
          action: 'addCharacter' as const,
          time: 0,
          params: {
            id: 'tomori',
            model: 'figure/tomori/model.json',
            position: [0.2, 0.4],
            scale: 1,
            enter: 'fadeIn',
            duration: 1,
            enterEase: 'power3.in',
          },
        },
        {
          action: 'transformCharacter' as const,
          time: 1,
          params: {
            id: 'tomori',
            position: [0.8, 0.8],
            scale: 2,
            opacity: 0.8,
            duration: 1,
            ease: 'power2.in',
          },
        },
        {
          action: 'removeCharacter' as const,
          time: 2,
          params: {
            id: 'tomori',
            exit: 'fadeOut',
            duration: 1,
            exitEase: 'power2.in',
          },
        },
      ],
    } as any;

    const entranceMid = computeSceneStateAtTime(characterScene, 0.5).characters.get('tomori');
    expect(entranceMid.opacity).toBeCloseTo(0.0625, 6);
    expect(entranceMid.opacity).not.toBeCloseTo(0.5, 3);

    const transformMid = computeSceneStateAtTime(characterScene, 1.5).characters.get('tomori');
    expect(transformMid.position).toEqual([0.275, 0.45]);
    expect(transformMid.scale).toBeCloseTo(1.125, 6);
    expect(transformMid.opacity).toBeCloseTo(0.975, 6);

    const exitMid = computeSceneStateAtTime(characterScene, 2.5).characters.get('tomori');
    expect(exitMid.opacity).toBeCloseTo(0.7, 6);
    expect(computeSceneStateAtTime(characterScene, 3).characters.has('tomori')).toBe(false);
  });

  it('materializes the latest blink state at the target time', () => {
    const characterScene = {
      sceneId: 'character-blink-state',
      meta: { title: 'Character blink state', characters: [] },
      timeline: [
        {
          action: 'addCharacter' as const,
          time: 0,
          params: { id: 'tomori', model: 'figure/tomori/model.json', enter: 'none' },
        },
        {
          action: 'characterBlink' as const,
          time: 1,
          params: { id: 'tomori', enabled: false, interval: 2.5 },
        },
        {
          action: 'characterBlink' as const,
          time: 2,
          params: { id: 'tomori', enabled: true, interval: 1.5 },
        },
      ],
    } as any;

    expect(computeSceneStateAtTime(characterScene, 0.5).characters.get('tomori').blink)
      .toBeNull();
    expect(computeSceneStateAtTime(characterScene, 1.5).characters.get('tomori').blink)
      .toEqual({ enabled: false, intervalMs: 2500, startTime: 1 });
    expect(computeSceneStateAtTime(characterScene, 2.5).characters.get('tomori').blink)
      .toEqual({ enabled: true, intervalMs: 1500, startTime: 2 });
  });

  it('materializes the look-at transition at the target time instead of jumping to final', () => {
    const characterScene = {
      sceneId: 'character-look-at-state',
      meta: { title: 'Character look-at state', characters: [] },
      timeline: [
        {
          action: 'addCharacter' as const,
          time: 0,
          params: { id: 'tomori', model: 'figure/tomori/model.json', enter: 'none' },
        },
        {
          action: 'characterLookAt' as const,
          time: 1,
          params: {
            id: 'tomori',
            point: [1, 0],
            enabled: true,
            duration: 1,
          },
        },
      ],
    } as any;

    const before = computeSceneStateAtTime(characterScene, 0.5).characters.get('tomori');
    expect(before.lookAt).toBeNull();

    const atStart = computeSceneStateAtTime(characterScene, 1).characters.get('tomori').lookAt;
    expect(atStart.startTime).toBe(1);
    expect(atStart.duration).toBe(1);
    expect(atStart.fromFocus).toEqual([0, 0]);
    expect(atStart.toFocus).toEqual([1, 0]);
    expect(atStart.focus[0]).toBeCloseTo(0, 6);

    const mid = computeSceneStateAtTime(characterScene, 1.5).characters.get('tomori').lookAt;
    expect(mid.startTime).toBe(1);
    expect(mid.duration).toBe(1);
    expect(mid.toFocus).toEqual([1, 0]);
    const easedMid = evaluateCharacterEase('power1.out', 0.5);
    expect(mid.focus[0]).toBeCloseTo(easedMid, 6);
    expect(mid.focus[1]).toBeCloseTo(0, 6);

    const after = computeSceneStateAtTime(characterScene, 2.5).characters.get('tomori').lookAt;
    expect(after.focus[0]).toBeCloseTo(1, 6);
  });

  it('resolves target-follow lookAt against the target position at the requested time', () => {
    const followScene = {
      sceneId: 'character-look-at-follow',
      meta: { title: 'Character look-at follow', characters: [] },
      timeline: [
        {
          action: 'addCharacter' as const,
          time: 0,
          params: { id: 'self', model: 'figure/self/model.json', enter: 'none', position: [0.5, 0.5] },
        },
        {
          action: 'addCharacter' as const,
          time: 0,
          params: { id: 'target', model: 'figure/target/model.json', enter: 'none', position: [0.2, 0.5] },
        },
        {
          action: 'characterLookAt' as const,
          time: 0,
          params: { id: 'self', target: 'target', point: [0, 0], enabled: true },
        },
        {
          action: 'transformCharacter' as const,
          time: 1,
          params: {
            id: 'target',
            position: [0.8, 0.5],
            duration: 2,
            ease: 'none',
          },
        },
      ],
    } as any;

    const initial = computeSceneStateAtTime(followScene, 1).characters.get('self').lookAt;
    expect(initial.focus[0]).toBeCloseTo(-0.6, 6);

    // Target is exactly level with self at t=2 → neutral gaze, not initial/final.
    const mid = computeSceneStateAtTime(followScene, 2).characters.get('self').lookAt;
    expect(mid.focus[0]).toBeCloseTo(0, 6);

    const final = computeSceneStateAtTime(followScene, 3).characters.get('self').lookAt;
    expect(final.focus[0]).toBeCloseTo(0.6, 6);
  });
});
