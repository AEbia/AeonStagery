import { describe, it, expect, beforeEach } from 'vitest';
import { PlaybackStore } from '../ui/store/PlaybackStore';

describe('PlaybackStore', () => {
  let store: PlaybackStore;

  beforeEach(() => {
    store = new PlaybackStore();
  });

  it('starts with playing=false, duration=0, engineStatus=\'\'', () => {
    expect(store.playing).toBe(false);
    expect(store.duration).toBe(0);
    expect(store.engineStatus).toBe('');
  });

  it('_setPlaying(true) sets playing to true', () => {
    store._setPlaying(true);
    expect(store.playing).toBe(true);
  });

  it('_setPlaying(false) sets playing to false', () => {
    store._setPlaying(true);
    store._setPlaying(false);
    expect(store.playing).toBe(false);
  });

  it('_setDuration(30.5) sets duration', () => {
    store._setDuration(30.5);
    expect(store.duration).toBe(30.5);
  });

  it('_setDuration(0) is valid (reset to zero)', () => {
    store._setDuration(100);
    store._setDuration(0);
    expect(store.duration).toBe(0);
  });

  it('_setEngineStatus(\'播放中\') sets engine status', () => {
    store._setEngineStatus('播放中');
    expect(store.engineStatus).toBe('播放中');
  });

  it('_setEngineStatus(\'\') clears engine status', () => {
    store._setEngineStatus('ready');
    store._setEngineStatus('');
    expect(store.engineStatus).toBe('');
  });

  it('multiple updates work correctly', () => {
    store._setPlaying(true);
    store._setDuration(42.0);
    store._setEngineStatus('playing');

    expect(store.playing).toBe(true);
    expect(store.duration).toBe(42.0);
    expect(store.engineStatus).toBe('playing');
  });

  it('playing getter returns values set by _setPlaying only', () => {
    // Default
    expect(store.playing).toBe(false);

    store._setPlaying(true);
    expect(store.playing).toBe(true);

    store._setPlaying(false);
    expect(store.playing).toBe(false);
  });

  it('duration getter returns values set by _setDuration only', () => {
    expect(store.duration).toBe(0);

    store._setDuration(10.5);
    expect(store.duration).toBe(10.5);

    store._setDuration(99.9);
    expect(store.duration).toBe(99.9);
  });

  it('engineStatus getter returns values set by _setEngineStatus only', () => {
    expect(store.engineStatus).toBe('');

    store._setEngineStatus('paused');
    expect(store.engineStatus).toBe('paused');

    store._setEngineStatus('error: timeout');
    expect(store.engineStatus).toBe('error: timeout');
  });
});
