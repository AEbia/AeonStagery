import React, { useState, useRef, useCallback } from 'react';
import gsap from 'gsap';
import { CAMERA_EASING_MAP } from '../../engine/utils/cameraEasing';

const EASING_LABELS: Record<string, string> = {
  smooth: '平滑',
  accelerate: '急出',
  overshoot: '回弹',
  linear: '匀速',
  decelerate: '缓入',
  bounce: '弹跳',
  anticipate: '预备',
  hesitate: '犹豫',
};

/** Resolve any easing reference to a GSAP-compatible string. Returns null if unrecognized. */
function resolveEaseString(raw: string): string | null {
  if (!raw) return null;
  const mapped = (CAMERA_EASING_MAP as Record<string, string>)[raw];
  if (mapped) return mapped;
  if (/^(power|expo|circ|sine|quad|cubic|quart|quint|strong|back|elastic|bounce|none|linear|steps)\b/.test(raw) || raw.includes('.')) {
    return raw;
  }
  return null;
}

const easingPathCache = new Map<string, string | null>();

/** Caches and computes a normalized 100x100 SVG path for a GSAP easing string. */
function getNormalizedEasingPath(gsapEaseStr: string): string | null {
  if (easingPathCache.has(gsapEaseStr)) return easingPathCache.get(gsapEaseStr)!;
  
  let fn: (t: number) => number;
  try {
    const parsed = gsap.parseEase(gsapEaseStr);
    if (typeof parsed === 'function') {
      fn = parsed as (t: number) => number;
    } else if (parsed && typeof (parsed as any).getRatio === 'function') {
      fn = (t: number) => (parsed as any).getRatio(t);
    } else {
      easingPathCache.set(gsapEaseStr, null);
      return null;
    }
  } catch {
    easingPathCache.set(gsapEaseStr, null);
    return null;
  }

  const n = 40;
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const val = fn(t);
    const cx = 4 + t * 92;
    const cy = 4 + (1 - Math.max(-0.05, Math.min(1.05, val))) * 92;
    d += `${i === 0 ? 'M' : 'L'}${cx.toFixed(1)},${cy.toFixed(1)} `;
  }
  
  easingPathCache.set(gsapEaseStr, d);
  return d;
}

/**
 * AE-style easing curve drawn as a full-width semi-transparent SVG overlay.
 */
const EasingCurveOverlay = React.memo(
  ({ easing }: { easing: string }) => {
    const resolved = resolveEaseString(easing);
    if (!resolved) return null;

    const pathD = getNormalizedEasingPath(resolved);
    if (!pathD) return null;

    return (
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          opacity: 0.35,
        }}
        aria-hidden
      >
        <path
          d={pathD}
          stroke="white"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  },
  (prev, next) => prev.easing === next.easing
);

/**
 * Enlarged easing tooltip shown on hover. Renders a bigger curve (120×36)
 * + the easing label. Appears above the block.
 */
const EasingTooltip = React.memo(
  ({ easing, blockWidth }: { easing: string; blockWidth: number }) => {
    const resolved = resolveEaseString(easing);
    if (!resolved) return null;

    const tipW = 120, tipH = 36;
    const pathD = getNormalizedEasingPath(resolved);
    if (!pathD) return null;

    const displayName = (EASING_LABELS as Record<string, string>)[easing] || easing;

    return (
      <div
        style={{
          position: 'absolute',
          bottom: '100%',
          left: Math.max(-10, Math.min(blockWidth - tipW, (blockWidth - tipW) / 2)),
          marginBottom: 4,
          width: tipW,
          background: 'rgba(20,20,30,0.92)',
          border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: 'var(--radius-md)',
          padding: '4px 6px 2px',
          zIndex: 100,
          pointerEvents: 'none',
          boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.7)', marginBottom: 1, textAlign: 'center' }}>
          {displayName}
        </div>
        <svg
          width={tipW - 12}
          height={tipH - 14}
          style={{ display: 'block', margin: '0 auto' }}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path
            d={pathD}
            stroke="rgba(255,255,255,0.85)"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div
          style={{
            fontSize: 7,
            color: 'rgba(255,255,255,0.4)',
            display: 'flex',
            justifyContent: 'space-between',
            padding: '0 2px',
          }}
        >
          <span>0s</span>
          <span>t</span>
        </div>
      </div>
    );
  }
);

interface EasingOverlayProps {
  action: any;
  width: number;
}

export const EasingOverlay = React.memo(({ action, width }: EasingOverlayProps) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const hoverTimer = useRef<any>(null);
  const sourceParams = action.sourceParams ?? {};

  const easingParam: string | undefined =
    action.semanticType === 'camera' ? sourceParams.ease :
    action.action === 'cameraMotion' ? action.params.easing :
    action.action === 'cameraPath' ? action.params.ease :
    undefined;

  const hasCurve = !!resolveEaseString(easingParam || '');

  const onMouseEnter = useCallback(() => {
    if (!hasCurve) return;
    hoverTimer.current = setTimeout(() => setShowTooltip(true), 300);
  }, [hasCurve]);

  const onMouseLeave = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setShowTooltip(false);
  }, []);

  if (!easingParam) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <EasingCurveOverlay easing={easingParam} />
      {showTooltip && (
        <EasingTooltip easing={easingParam} blockWidth={width} />
      )}
    </div>
  );
});
