import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  formatLineTag,
  parseLineTag,
  projectCinematicLineView,
  projectCompactLineView,
  projectFormalSceneStoryText,
  projectPerformanceLineView,
  projectSpeakerTextUnits,
} from '../services/ai-authoring/SceneLineProjection';

function document(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'proj',
    meta: {
      title: 'Projection',
      durationSeconds: 20,
      characters: [
        { id: 'tomori', name: 'Tomori' },
        { id: 'anon', name: 'Anon' },
      ],
    },
    statements: [
      {
        id: 'cam_1',
        time: 0,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.2 },
      },
      {
        id: 'dlg_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'First line\ncontinues here',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'perf_1',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: '$speaker', motion: '' },
          },
        ],
      },
      {
        id: 'dlg_2',
        time: 4,
        type: 'dialogue',
        params: {
          speakerId: 'anon',
          text: 'Second',
          durationSeconds: 1,
        },
      },
    ],
  };
}

describe('Scene line projection', () => {
  it('formats and parses fixed [Line:n] tags', () => {
    expect(formatLineTag(12)).toBe('[Line:12]');
    expect(parseLineTag('[Line:12]')).toBe(12);
    expect(parseLineTag('[Line:0]')).toBeUndefined();
    expect(parseLineTag('Line:12')).toBeUndefined();
  });

  it('projects speaker/text units with line numbers matching the line view', () => {
    const units = projectSpeakerTextUnits(document());
    expect(units.map((u) => u.line)).toEqual([2, 4]);
    expect(units[0]?.text).toContain('continues here');
  });

  it('builds formal scene story text with Line tags and multi-line blocks', () => {
    const story = projectFormalSceneStoryText(document());
    expect(story).toContain('[Line:2]\nTomori: First line\ncontinues here');
    expect(story).toContain('[Line:4]\nAnon: Second');
    expect(story).not.toContain('characterPerformance');
    expect(story).not.toContain('perf_1');
  });

  it('omits dialogue text in compact performance line view when requested', () => {
    const view = projectPerformanceLineView(document(), {
      omitDialogueText: true,
      writableLines: [2, 3],
    });
    const dialogue = view.lines.find((line) => line.line === 2);
    expect(dialogue?.params.text).toBeUndefined();
    expect(dialogue?.params.speakerId).toBe('tomori');
    expect(dialogue?.access).toBe('writable');
    const camera = view.lines.find((line) => line.line === 1);
    expect(camera?.access).toBe('read-only');
    const companion = view.lines.find((line) => line.line === 3);
    expect(companion?.parentLine).toBe(2);
    expect(companion?.type).toBe('characterPerformance');
  });

  it('filters cinematic line view families while keeping performance context', () => {
    const view = projectCinematicLineView(document());
    expect(view.lines.some((line) => line.type === 'camera')).toBe(true);
    expect(view.lines.some((line) => line.type === 'characterPerformance')).toBe(true);
    expect(view.lines.every((line) => line.type !== 'audio')).toBe(true);
  });

  it('never includes statement UUIDs in projected lines', () => {
    const view = projectCompactLineView(document());
    for (const line of view.lines) {
      expect(JSON.stringify(line)).not.toContain('dlg_1');
      expect(JSON.stringify(line)).not.toContain('perf_1');
      expect(JSON.stringify(line)).not.toContain('cam_1');
    }
  });

  it('drops presentation-only fields from compact model line views', () => {
    const view = projectCompactLineView(document());
    expect(view.lines.length).toBeGreaterThan(0);
    for (const line of view.lines) {
      expect(line.label).toBeUndefined();
      expect(line.iconKey).toBeUndefined();
      expect(line.category).toBeUndefined();
      expect(line.durationSeconds).toBeUndefined();
      expect(line.line).toBeGreaterThan(0);
      expect(line.type).toBeTruthy();
      expect(line.params).toBeDefined();
    }
  });
});
