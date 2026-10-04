import type { SceneStatement } from '../../api/types/semantic-scene';
import {
  sceneStatementDefinitionRegistry,
  type SceneStatementDefinitionRegistry,
} from '../../services/semantic-scene';

/** Minimum shell width for zero/short transitions (screen px). */
export const LIFECYCLE_BOUNDARY_MIN_SHELL_PX = 24;

/** Fixed presentation pad beyond semantic transition edge (screen px). Not semantic. */
export const LIFECYCLE_BOUNDARY_PAD_PX = 8;

export interface LifecycleBoundaryPresentationMetrics {
  readonly isLifecycleBoundary: boolean;
  readonly boundary?: 'start' | 'end';
  readonly typeKey?: string;
  readonly transitionDurationSeconds: number;
  readonly transitionDurationField?: string;
  /** Semantic transition width in px (no pad). */
  readonly transitionWidthPx: number;
  /** Visible block width including shell + pad. */
  readonly visualWidthPx: number;
  /** Semantic duration used for resize (source transition). */
  readonly semanticDurationSeconds: number;
  readonly canResizeTransition: boolean;
}

/**
 * Presentation metrics for a lifecycle boundary statement.
 * Footprint is layout/hit only — never use visualWidth for semantic overlap / scene-end.
 */
export function getLifecycleBoundaryPresentationMetrics(
  statement: Pick<SceneStatement, 'type' | 'params'>,
  pixelsPerSecond: number,
  registry: SceneStatementDefinitionRegistry = sceneStatementDefinitionRegistry,
): LifecycleBoundaryPresentationMetrics {
  const lifecycle = registry.timelineLifecyclePresentation(statement);
  if (!lifecycle) {
    const extent = registry.temporalExtent(statement as SceneStatement);
    return {
      isLifecycleBoundary: false,
      transitionDurationSeconds: extent,
      transitionWidthPx: Math.max(0, extent * pixelsPerSecond),
      visualWidthPx: Math.max(4, extent * pixelsPerSecond),
      semanticDurationSeconds: extent,
      canResizeTransition: false,
    };
  }

  const transitionDurationSeconds = Math.max(0, lifecycle.transitionDurationSeconds);
  const transitionWidthPx = transitionDurationSeconds * Math.max(0, pixelsPerSecond);
  const shellPx = Math.max(LIFECYCLE_BOUNDARY_MIN_SHELL_PX, transitionWidthPx);
  const visualWidthPx = shellPx + LIFECYCLE_BOUNDARY_PAD_PX;
  const transitionField = lifecycle.definition.transitionDurationFields?.[lifecycle.boundary];

  return {
    isLifecycleBoundary: true,
    boundary: lifecycle.boundary,
    typeKey: lifecycle.definition.presentationTypeKey,
    transitionDurationSeconds,
    ...(transitionField ? { transitionDurationField: transitionField } : {}),
    transitionWidthPx,
    visualWidthPx,
    semanticDurationSeconds: transitionDurationSeconds,
    canResizeTransition: !!transitionField && transitionDurationSeconds > 0,
  };
}

/**
 * Lane packing / hit ranges in timeline seconds coordinates.
 * Pad is converted from screen px so it shrinks at low zoom correctly as a presentation-only extension.
 */
export function getLifecycleBoundaryFootprintRange(
  timeSeconds: number,
  metrics: LifecycleBoundaryPresentationMetrics,
  pixelsPerSecond: number,
): { start: number; end: number } {
  if (!metrics.isLifecycleBoundary) {
    return {
      start: timeSeconds,
      end: timeSeconds + Math.max(0, metrics.semanticDurationSeconds),
    };
  }
  const pps = Math.max(1e-6, pixelsPerSecond);
  const visualSeconds = metrics.visualWidthPx / pps;
  return {
    start: timeSeconds,
    end: timeSeconds + visualSeconds,
  };
}
