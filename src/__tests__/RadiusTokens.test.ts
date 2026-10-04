import { describe, expect, it } from 'vitest';
import {
  RADIUS,
  RADIUS_NUMBERS,
  RADIUS_SCALE,
  RADIUS_SEMANTIC,
  RADIUS_VARS,
  getNestedRadius,
} from '../ui/tokens';

describe('RadiusTokens', () => {
  it('defines primitive scale values correctly', () => {
    expect(RADIUS_SCALE.none).toBe('0px');
    expect(RADIUS_SCALE.xs).toBe('2px');
    expect(RADIUS_SCALE.sm).toBe('4px');
    expect(RADIUS_SCALE.md).toBe('8px');
    expect(RADIUS_SCALE.lg).toBe('12px');
    expect(RADIUS_SCALE.xl).toBe('16px');
    expect(RADIUS_SCALE['2xl']).toBe('24px');
    expect(RADIUS_SCALE.full).toBe('9999px');
    expect(RADIUS_SCALE.circle).toBe('50%');
  });

  it('defines CSS variable references correctly', () => {
    expect(RADIUS_VARS.none).toBe('var(--radius-none)');
    expect(RADIUS_VARS.xs).toBe('var(--radius-xs)');
    expect(RADIUS_VARS.sm).toBe('var(--radius-sm)');
    expect(RADIUS_VARS.md).toBe('var(--radius-md)');
    expect(RADIUS_VARS.lg).toBe('var(--radius-lg)');
    expect(RADIUS_VARS.xl).toBe('var(--radius-xl)');
    expect(RADIUS_VARS['2xl']).toBe('var(--radius-2xl)');
    expect(RADIUS_VARS.full).toBe('var(--radius-full)');
    expect(RADIUS_VARS.circle).toBe('var(--radius-circle)');
  });

  it('defines numeric values for calculation', () => {
    expect(RADIUS_NUMBERS.xs).toBe(2);
    expect(RADIUS_NUMBERS.sm).toBe(4);
    expect(RADIUS_NUMBERS.md).toBe(8);
    expect(RADIUS_NUMBERS.lg).toBe(12);
    expect(RADIUS_NUMBERS.xl).toBe(16);
    expect(RADIUS_NUMBERS['2xl']).toBe(24);
  });

  it('provides semantic hierarchy tokens for all UI layers', () => {
    // Micro
    expect(RADIUS_SEMANTIC.indicator).toBe('var(--radius-xs)');
    expect(RADIUS_SEMANTIC.hairline).toBe('var(--radius-xs)');

    // Compact
    expect(RADIUS_SEMANTIC.trackBlock).toBe('var(--radius-sm)');
    expect(RADIUS_SEMANTIC.controlSm).toBe('var(--radius-sm)');
    expect(RADIUS_SEMANTIC.badge).toBe('var(--radius-sm)');
    expect(RADIUS_SEMANTIC.tooltip).toBe('var(--radius-sm)');

    // Standard Controls
    expect(RADIUS_SEMANTIC.button).toBe('var(--radius-md)');
    expect(RADIUS_SEMANTIC.input).toBe('var(--radius-md)');
    expect(RADIUS_SEMANTIC.menu).toBe('var(--radius-md)');
    expect(RADIUS_SEMANTIC.tab).toBe('var(--radius-md)');

    // Surfaces
    expect(RADIUS_SEMANTIC.card).toBe('var(--radius-lg)');
    expect(RADIUS_SEMANTIC.surface).toBe('var(--radius-lg)');
    expect(RADIUS_SEMANTIC.panel).toBe('var(--radius-lg)');
    expect(RADIUS_SEMANTIC.popover).toBe('var(--radius-lg)');

    // Modals & Dialogs
    expect(RADIUS_SEMANTIC.dialog).toBe('var(--radius-xl)');
    expect(RADIUS_SEMANTIC.modal).toBe('var(--radius-xl)');

    // Hero
    expect(RADIUS_SEMANTIC.hero).toBe('var(--radius-2xl)');

    // Pill & Circle
    expect(RADIUS_SEMANTIC.pill).toBe('var(--radius-full)');
    expect(RADIUS_SEMANTIC.switch).toBe('var(--radius-full)');
    expect(RADIUS_SEMANTIC.circle).toBe('var(--radius-circle)');
  });

  it('exposes RADIUS shorthand helper', () => {
    expect(RADIUS.sm).toBe('var(--radius-sm)');
    expect(RADIUS.md).toBe('var(--radius-md)');
    expect(RADIUS.lg).toBe('var(--radius-lg)');
    expect(RADIUS.xl).toBe('var(--radius-xl)');
    expect(RADIUS.pill).toBe('var(--radius-full)');
    expect(RADIUS.semantic.button).toBe('var(--radius-md)');
  });

  it('computes concentric nested radius properly', () => {
    // R_inner = max(R_outer - padding, 0)
    expect(getNestedRadius(16, 12)).toBe(4);
    expect(getNestedRadius(12, 8)).toBe(4);
    expect(getNestedRadius(16, 8)).toBe(8);
    expect(getNestedRadius(8, 10)).toBe(0);
  });
});
