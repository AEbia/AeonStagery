import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleDialogue } from '../engine/actions/dialogue';

const state = vi.hoisted(() => ({
  showDialogue: vi.fn(),
}));

vi.mock('../engine/SubtitleRenderer', () => ({
  subtitleRenderer: {
    showDialogue: state.showDialogue,
  },
}));

vi.mock('../engine/LipSyncEngine', () => ({
  lipSyncEngine: {
    startTextDrivenLipSync: vi.fn(),
  },
}));

describe('scheduleDialogue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.showDialogue.mockReturnValue({});
  });

  it('uses the current character name and color for a bound speaker', () => {
    const add = vi.fn();
    const ctx = {
      tl: { add },
      getCharacterMeta: vi.fn(() => ({ name: '主角', color: '#12ab34' })),
    } as any;

    scheduleDialogue(ctx, {
      time: 1,
      params: {
        speakerId: 'hero',
        speaker: '旧显示名',
        speakerColor: '#111111',
        text: '你好',
        duration: 1,
        lipSync: 'none',
      },
    });

    expect(state.showDialogue).toHaveBeenCalledWith(expect.objectContaining({
      speaker: '主角',
      speakerId: 'hero',
      speakerColor: '#12ab34',
    }));
    expect(add).toHaveBeenCalledWith({}, 1);
  });
});
