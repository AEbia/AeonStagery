if (typeof window === 'undefined') {
  (global as any).window = {};
}
if (typeof document === 'undefined') {
  (global as any).document = {
    documentElement: {
      style: {
        setProperty: () => {},
        getPropertyValue: () => '',
      },
    },
  };
}
if (typeof localStorage === 'undefined') {
  (global as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
}
if (typeof Audio === 'undefined') {
  (global as any).Audio = class {
    play = async () => {};
    pause = () => {};
    src = '';
  };
}

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DialogueCoordinator } from '../engine/coordinators/DialogueCoordinator';

vi.mock('../ui/SettingsStore', () => ({
  settingsManager: { get: vi.fn().mockReturnValue(1000), set: vi.fn(), load: vi.fn(), save: vi.fn() },
}));

function createMockSubtitle() {
  const mockTimeline = {
    seek: vi.fn(),
  };
  return {
    ensureDialogueOnStage: vi.fn(),
    getCurrentTimeline: vi.fn().mockReturnValue(mockTimeline),
    forceUpdate: vi.fn(),
    hideDialogue: vi.fn(),
    _mockTimeline: mockTimeline,
  };
}

function createMockLipSync() {
  return {
    setTextMouthAt: vi.fn(),
    startAudioDrivenLipSync: vi.fn(),
    stop: vi.fn(),
  };
}

describe('DialogueCoordinator', () => {
  let coordinator: DialogueCoordinator;
  let subtitle: ReturnType<typeof createMockSubtitle>;
  let lipSync: ReturnType<typeof createMockLipSync>;

  beforeEach(() => {
    subtitle = createMockSubtitle();
    lipSync = createMockLipSync();
    coordinator = new DialogueCoordinator(subtitle as any, lipSync as any);
  });

  it('sync with no dialogue hides active dialogue if one was showing', () => {
    const d1 = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1' };
    coordinator.sync(1.5, d1, false, () => new Audio(), (p) => p, vi.fn());
    
    // Clear
    coordinator.sync(3.0, null, false, () => new Audio(), (p) => p, vi.fn());
    expect(subtitle.hideDialogue).toHaveBeenCalledWith(false);
  });

  it('sync with new dialogue calls ensureDialogueOnStage', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1' };
    coordinator.sync(1.5, d, false, () => new Audio(), (p) => p, vi.fn());
    expect(subtitle.ensureDialogueOnStage).toHaveBeenCalledWith(d, 0.5);
  });

  it('sync with same dialogue seeks subtitle timeline and drives text mouth', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1' };
    coordinator.sync(1.5, d, false, () => new Audio(), (p) => p, vi.fn());
    
    // Second seek
    coordinator.sync(1.8, d, false, () => new Audio(), (p) => p, vi.fn());
    expect(subtitle._mockTimeline.seek).toHaveBeenCalledWith(0.8);
    expect(lipSync.setTextMouthAt).toHaveBeenCalledWith('char1', 'Hello', 2, 0.8);
  });

  it('sync seeks dialogue and drives text lipSync while scrubbing', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1' };
    coordinator.sync(1.5, d, true, () => new Audio(), (p) => p, vi.fn());
    expect(subtitle.ensureDialogueOnStage).toHaveBeenCalledWith(d, 0.5);
    expect(lipSync.setTextMouthAt).toHaveBeenCalledWith('char1', 'Hello', 2, 0.5);
  });

  it('sync avoids audio setup while scrubbing voice dialogue', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', voice: 'v.mp3', lipSync: 'audio' as const };
    const createAudioSpy = vi.fn(() => new Audio());
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(1.5, d, true, createAudioSpy, (p) => p, scheduleVoiceSpy);

    expect(subtitle.ensureDialogueOnStage).toHaveBeenCalledWith(d, 0.5);
    expect(createAudioSpy).not.toHaveBeenCalled();
    expect(lipSync.startAudioDrivenLipSync).not.toHaveBeenCalled();
    expect(scheduleVoiceSpy).not.toHaveBeenCalled();
  });

  it('sync starts text-driven lipSync when no voice audio', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1' };
    coordinator.sync(1.5, d, false, () => new Audio(), (p) => p, vi.fn());
    expect(lipSync.setTextMouthAt).toHaveBeenCalledWith('char1', 'Hello', 2, 0.5);
  });

  it('sync schedules voice audio and triggers audio-driven lipSync', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', voice: 'v.mp3', lipSync: 'audio' as const };
    const mockAudio = new Audio();
    const createAudioSpy = vi.fn().mockReturnValue(mockAudio);
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(1.5, d, false, createAudioSpy, (p) => p, scheduleVoiceSpy);

    expect(lipSync.startAudioDrivenLipSync).toHaveBeenCalledWith('char1', mockAudio);
    expect(scheduleVoiceSpy).toHaveBeenCalledWith('voice-d1', mockAudio, 1, 2);
  });

  it('sync schedules voice audio even without speaker lipSync target', () => {
    const d = { _id: 'd1', text: 'Narration', startTime: 1, duration: 2, voice: 'narration.wav' };
    const mockAudio = new Audio();
    const createAudioSpy = vi.fn().mockReturnValue(mockAudio);
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(1.5, d, false, createAudioSpy, (p) => p, scheduleVoiceSpy);

    expect(lipSync.startAudioDrivenLipSync).not.toHaveBeenCalled();
    expect(scheduleVoiceSpy).toHaveBeenCalledWith('voice-d1', mockAudio, 1, 2);
  });

  it('sync supports async runtime voice path resolution', async () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', voice: 'vocal/line.mp3' };
    const mockAudio = new Audio();
    const createAudioSpy = vi.fn().mockReturnValue(mockAudio);
    const scheduleVoiceSpy = vi.fn();
    const resolvePathSpy = vi.fn().mockResolvedValue('asset://localhost/D:/project/vocal/line.mp3');

    coordinator.sync(1.5, d, false, createAudioSpy, resolvePathSpy, scheduleVoiceSpy);
    await Promise.resolve();

    expect(resolvePathSpy).toHaveBeenCalledWith('vocal/line.mp3');
    expect(createAudioSpy).toHaveBeenCalledWith('asset://localhost/D:/project/vocal/line.mp3');
    expect(lipSync.startAudioDrivenLipSync).toHaveBeenCalledWith('char1', mockAudio);
    expect(scheduleVoiceSpy).toHaveBeenCalledWith('voice-d1', mockAudio, 1, 2);
  });

  it('sync schedules voice after a scrubbed dialogue becomes active playback', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', voice: 'v.wav' };
    const mockAudio = new Audio();
    const createAudioSpy = vi.fn().mockReturnValue(mockAudio);
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(1.5, d, true, createAudioSpy, (p) => p, scheduleVoiceSpy);
    coordinator.sync(1.6, d, false, createAudioSpy, (p) => p, scheduleVoiceSpy);

    expect(createAudioSpy).toHaveBeenCalledTimes(1);
    expect(lipSync.startAudioDrivenLipSync).toHaveBeenCalledWith('char1', mockAudio);
    expect(scheduleVoiceSpy).toHaveBeenCalledWith('voice-d1', mockAudio, 1, 2);
  });

  it('sync keeps voice playback when lipSync is explicitly none', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', voice: 'v.wav', lipSync: 'none' as const };
    const mockAudio = new Audio();
    const createAudioSpy = vi.fn().mockReturnValue(mockAudio);
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(1.5, d, false, createAudioSpy, (p) => p, scheduleVoiceSpy);

    expect(lipSync.setTextMouthAt).not.toHaveBeenCalled();
    expect(lipSync.startAudioDrivenLipSync).not.toHaveBeenCalled();
    expect(scheduleVoiceSpy).toHaveBeenCalledWith('voice-d1', mockAudio, 1, 2);
  });

  it('infers audio-driven lipSync from voice without an explicit lipSync mode', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', voice: 'v.mp3' };
    const mockAudio = new Audio();
    const createAudioSpy = vi.fn().mockReturnValue(mockAudio);
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(1.5, d, false, createAudioSpy, (p) => p, scheduleVoiceSpy);

    expect(lipSync.setTextMouthAt).not.toHaveBeenCalled();
    expect(lipSync.startAudioDrivenLipSync).toHaveBeenCalledWith('char1', mockAudio);
    expect(scheduleVoiceSpy).toHaveBeenCalledWith('voice-d1', mockAudio, 1, 2);
  });

  it('uses per-dialogue voice keys so same-speaker lines do not overwrite each other', () => {
    const createAudioSpy = vi
      .fn()
      .mockReturnValueOnce(new Audio())
      .mockReturnValueOnce(new Audio());
    const scheduleVoiceSpy = vi.fn();

    coordinator.sync(
      1.1,
      { _id: 'line-1', text: 'First', startTime: 1, duration: 1, speakerId: 'char1', voice: 'same.wav', lipSync: 'audio' as const },
      false,
      createAudioSpy,
      (p) => p,
      scheduleVoiceSpy,
    );
    coordinator.sync(
      2.1,
      { _id: 'line-2', text: 'Second', startTime: 2, duration: 1, speakerId: 'char1', voice: 'same.wav', lipSync: 'audio' as const },
      false,
      createAudioSpy,
      (p) => p,
      scheduleVoiceSpy,
    );

    expect(scheduleVoiceSpy.mock.calls.map((call) => call[0])).toEqual(['voice-line-1', 'voice-line-2']);
  });

  it('does not start lipSync when lipSync is explicitly none', () => {
    const d = { _id: 'd1', text: 'Hello', startTime: 1, duration: 2, speakerId: 'char1', lipSync: 'none' as const };

    coordinator.sync(1.5, d, false, () => new Audio(), (p) => p, vi.fn());

    expect(lipSync.setTextMouthAt).not.toHaveBeenCalled();
    expect(lipSync.startAudioDrivenLipSync).not.toHaveBeenCalled();
  });
});
