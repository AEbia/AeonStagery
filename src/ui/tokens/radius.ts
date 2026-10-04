/**
 * AeonStagery Design System - Corner Radius Tokens
 *
 * Single source of truth for R-angle (corner radius) hierarchy across the application.
 * Follows the design philosophy:
 * 1. "The Radius Follows Scale Rule": Micro/indicators (2px) -> Compact items/track blocks (4px)
 *    -> Standard controls/buttons/inputs (8px) -> Surfaces/cards/panels (12px) -> Modals/dialogs (16px)
 *    -> Hero containers (24px) -> Pills/switches (9999px) -> Circular affordances (50%).
 * 2. "The Concentric Radius Rule": Inner radius = max(Outer radius - Padding, 0).
 */

/** Primitive scale token definitions */
export const RADIUS_SCALE = {
  none: '0px',
  xs: '2px',       // Micro: indicators, hairbars, seek tracks
  sm: '4px',       // Compact: track blocks, chips, tooltips, sub-controls
  md: '8px',       // Standard: buttons, inputs, menu items, tabs
  lg: '12px',      // Surface: cards, inspector panels, popovers, media tiles
  xl: '16px',      // Dialog: modals, settings dialogs, primary overlays
  '2xl': '24px',   // Hero: setup wizard, major onboarding dialogs
  full: '9999px',  // Pill: status pills, toggle switches, round badges
  circle: '50%',   // Circular: avatars, play/record buttons, status dots
} as const;

export type RadiusScaleKey = keyof typeof RADIUS_SCALE;

/** CSS Variable references for styling in CSS or inline styles */
export const RADIUS_VARS = {
  none: 'var(--radius-none)',
  xs: 'var(--radius-xs)',
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  xl: 'var(--radius-xl)',
  '2xl': 'var(--radius-2xl)',
  full: 'var(--radius-full)',
  circle: 'var(--radius-circle)',
} as const;

/** Numeric pixel values for calculations, canvas, and Pixi rendering */
export const RADIUS_NUMBERS = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  full: 9999,
} as const;

/**
 * Semantic / Hierarchical Token mappings:
 * Defines purpose-driven radius tokens across interface layers.
 */
export const RADIUS_SEMANTIC = {
  // Level 1: Micro & Indicators (2px)
  indicator: RADIUS_VARS.xs,
  hairline: RADIUS_VARS.xs,

  // Level 2: Compact & Timeline items (4px)
  trackBlock: RADIUS_VARS.sm,
  controlSm: RADIUS_VARS.sm,
  badge: RADIUS_VARS.sm,
  tag: RADIUS_VARS.sm,
  tooltip: RADIUS_VARS.sm,

  // Level 3: Standard Interactive Controls (8px)
  control: RADIUS_VARS.md,
  button: RADIUS_VARS.md,
  input: RADIUS_VARS.md,
  menu: RADIUS_VARS.md,
  dropdown: RADIUS_VARS.md,
  tab: RADIUS_VARS.md,

  // Level 4: Surface & Containers (12px)
  surface: RADIUS_VARS.lg,
  card: RADIUS_VARS.lg,
  panel: RADIUS_VARS.lg,
  popover: RADIUS_VARS.lg,

  // Level 5: Modals & Dialog Windows (16px)
  dialog: RADIUS_VARS.xl,
  modal: RADIUS_VARS.xl,
  window: RADIUS_VARS.xl,

  // Level 6: Hero & Wizard (24px)
  hero: RADIUS_VARS['2xl'],

  // Level 7: Pill & Circular
  pill: RADIUS_VARS.full,
  switch: RADIUS_VARS.full,
  circle: RADIUS_VARS.circle,
} as const;

/**
 * Default RADIUS export providing both direct access to CSS variables and helper namespaces.
 * Usage:
 *   style={{ borderRadius: RADIUS.md }}
 *   style={{ borderRadius: RADIUS.semantic.button }}
 *   style={{ borderRadius: RADIUS.pill }}
 */
export const RADIUS = {
  none: RADIUS_VARS.none,
  xs: RADIUS_VARS.xs,
  sm: RADIUS_VARS.sm,
  md: RADIUS_VARS.md,
  lg: RADIUS_VARS.lg,
  xl: RADIUS_VARS.xl,
  '2xl': RADIUS_VARS['2xl'],
  full: RADIUS_VARS.full,
  circle: RADIUS_VARS.circle,
  pill: RADIUS_VARS.full,
  semantic: RADIUS_SEMANTIC,
  vars: RADIUS_VARS,
  scale: RADIUS_SCALE,
  numbers: RADIUS_NUMBERS,
} as const;

/**
 * The Concentric Radius Rule:
 * Calculates the mathematically harmonious inner corner radius given the outer radius and padding.
 * Formula: R_inner = max(R_outer - padding, 0)
 *
 * Example:
 *   A card with 12px radius and 8px padding should have inner items with radius <= 4px.
 */
export function getNestedRadius(outerRadiusPx: number, paddingPx: number): number {
  return Math.max(0, outerRadiusPx - paddingPx);
}
