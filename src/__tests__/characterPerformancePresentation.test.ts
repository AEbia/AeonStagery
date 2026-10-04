import { describe, expect, it } from 'vitest';
import {
  buildCharacterPerformanceTargetSelect,
  resolveCharacterPerformanceTargetCharId,
} from '../ui/timeline/characterPerformancePresentation';

const CHARACTERS = [
  { id: 'alice', name: 'Alice' },
  { id: 'taki', name: 'Taki' },
] as const;

describe('characterPerformance target select', () => {
  it('reflects the auto-bound speaker for an unbound $speaker placeholder', () => {
    const model = buildCharacterPerformanceTargetSelect({
      rawTarget: '$speaker',
      resolvedSpeakerId: 'alice',
      characters: CHARACTERS,
    });

    expect(model.value).toBe('$speaker');
    expect(model.options[0]).toEqual({
      value: '$speaker',
      label: '当前说话人（Alice）',
    });
    expect(model.options.map((option) => option.value)).toEqual([
      '$speaker',
      'alice',
      'taki',
    ]);
  });

  it('never offers the empty 旁白 option that would destroy the placeholder binding', () => {
    const model = buildCharacterPerformanceTargetSelect({
      rawTarget: '$speaker',
      resolvedSpeakerId: 'alice',
      characters: CHARACTERS,
    });

    expect(model.options.some((option) => option.value === '')).toBe(false);
  });

  it('shows the bound character as the selected value once the user binds a real id', () => {
    const model = buildCharacterPerformanceTargetSelect({
      rawTarget: 'taki',
      resolvedSpeakerId: 'alice',
      characters: CHARACTERS,
    });

    expect(model.value).toBe('taki');
    // The speaker token stays available so the auto-binding can be restored.
    expect(model.options.map((option) => option.value)).toContain('$speaker');
  });

  it('reuses the $speaker option to repair a placeholder whose target was emptied', () => {
    const model = buildCharacterPerformanceTargetSelect({
      rawTarget: '',
      resolvedSpeakerId: 'alice',
      characters: CHARACTERS,
    });

    expect(model.value).toBe('$speaker');
    expect(model.options[0].value).toBe('$speaker');
  });

  it('does not offer $speaker for root statements without a resolvable parent speaker', () => {
    const model = buildCharacterPerformanceTargetSelect({
      rawTarget: '',
      resolvedSpeakerId: undefined,
      characters: CHARACTERS,
    });

    expect(model.value).toBe('');
    expect(model.options.map((option) => option.value)).toEqual(['alice', 'taki']);
  });
});

describe('resolveCharacterPerformanceTargetCharId', () => {
  it('resolves the bound target for a manually bound placeholder', () => {
    expect(resolveCharacterPerformanceTargetCharId({
      action: 'characterPerformance',
      params: { target: 'taki', motion: '' },
      sourceParams: { target: 'taki', motion: '' },
    }, 'alice')).toBe('taki');
  });

  it('falls back to the resolved speaker for an unbound $speaker placeholder', () => {
    expect(resolveCharacterPerformanceTargetCharId({
      action: 'characterPerformance',
      params: { target: '$speaker', motion: '' },
      sourceParams: { target: '$speaker', motion: '' },
    }, 'alice')).toBe('alice');
  });

  it('prefers the compiled runtime id for a compiled playMotion display action', () => {
    expect(resolveCharacterPerformanceTargetCharId({
      action: 'playMotion',
      params: { id: 'alice', motion: { kind: 'resource', key: 'wave' } },
      sourceParams: { target: '$speaker', motion: { kind: 'resource', key: 'wave' } },
    }, 'alice')).toBe('alice');
  });
});
