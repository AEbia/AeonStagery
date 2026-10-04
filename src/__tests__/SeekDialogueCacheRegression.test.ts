/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import SubtitleRenderer from '../engine/SubtitleRenderer';
import { computeSceneStateAtTime } from '../engine/RuntimeSceneState';

const stageState = vi.hoisted(() => ({
  subtitleLayer: null as any,
  executeHook: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getLayer: vi.fn((name: string) => {
      if (name !== 'subtitle') throw new Error(`Unexpected layer ${name}`);
      return stageState.subtitleLayer;
    }),
  },
}));

vi.mock('../api/hooks', () => ({
  hookSystem: {
    execute: stageState.executeHook,
  },
}));

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: {
    get: stageState.getSetting,
  },
}));

describe('Seek dialogue cache regression', () => {
  beforeEach(() => {
    stageState.subtitleLayer = new PIXI.Container();
    stageState.executeHook.mockClear();
    stageState.getSetting.mockImplementation((key: string) => {
      if (key === 'dialogueTextSpeed') return 0.01;
      return '';
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type: any) => {
      if (type !== '2d') return null;
      const context = new Proxy({
        canvas: document.createElement('canvas'),
        fillStyle: '',
        font: '',
        measureText: vi.fn(() => ({ width: 100 })),
      } as Record<string, any>, {
        get(target, prop) {
          if (prop in target) return target[prop as string];
          return vi.fn();
        },
        set(target, prop, value) {
          target[prop as string] = value;
          return true;
        },
      });
      return context as any;
    });
    vi.spyOn(PIXI.CanvasTextMetrics, 'measureText').mockReturnValue({
      lines: ['Hello'],
      lineWidths: [100],
      lineHeight: 60,
      maxLineWidth: 100,
      width: 100,
      height: 60,
      fontProperties: {
        ascent: 40,
        descent: 20,
        fontSize: 60,
      },
    } as any);
  });

  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.restoreAllMocks();
    stageState.subtitleLayer.destroy({ children: true });
    stageState.subtitleLayer = null;
  });

  it('reattaches cached dialogue when seek config lacks resolved speaker fields', () => {
    const renderer = new SubtitleRenderer();
    const scene = {
      sceneId: 'seek-dialogue',
      meta: {
        title: 'Seek dialogue',
        characters: [{ id: 'char-1', name: 'Alice', color: '#FFD700' }],
      },
      timeline: [{
        _id: 'statement-3',
        action: 'dialogue',
        time: 1,
        params: {
          speakerId: 'char-1',
          text: 'Hello',
          style: 'instant',
          position: 'bottom',
          duration: 2,
        },
      }],
    } as any;

    // What scheduleDialogue actually puts in the cache: it resolves the
    // character name and color before calling showDialogue.
    renderer.showDialogue({
      _id: 'statement-3',
      speakerId: 'char-1',
      speaker: 'Alice',
      speakerColor: '#FFD700',
      text: 'Hello',
      style: 'instant',
      position: 'bottom',
      duration: 2,
    });

    // What computeSceneStateAtTime/DialogueCoordinator passes during seek.
    // It must carry the same resolved speaker fields so the cache key matches.
    const state = computeSceneStateAtTime(scene, 2);
    expect(state.dialogue.speaker).toBe('Alice');
    expect(state.dialogue.speakerColor).toBe('#FFD700');
    renderer.ensureDialogueOnStage(state.dialogue, 1);

    expect(stageState.subtitleLayer.children).toHaveLength(1);
    expect(renderer.getCurrentTimeline()).not.toBeNull();
  });

  it('reattaches cached dialogue when dialogue text speed changed after scheduling', () => {
    const renderer = new SubtitleRenderer();
    const config = {
      _id: 'statement-4',
      speakerId: 'char-1',
      speaker: 'Alice',
      speakerColor: '#FFD700',
      text: 'Hello',
      style: 'instant' as const,
      position: 'bottom' as const,
      duration: 2,
    };

    // Schedule at the original text speed.
    renderer.showDialogue(config);

    // User changes the text speed setting, which changes the cache key that
    // seek restoration computes. Same-id fallback must still restore the stage.
    stageState.getSetting.mockImplementation((key: string) => {
      if (key === 'dialogueTextSpeed') return 0.05;
      return '';
    });
    renderer.ensureDialogueOnStage(config, 1);

    expect(stageState.subtitleLayer.children).toHaveLength(1);
    expect(renderer.getCurrentTimeline()).not.toBeNull();
  });
});
