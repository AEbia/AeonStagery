import { memo } from 'react';

interface MarqueeOverlayProps {
  marqueeRef: React.RefObject<any>;
}

export const MarqueeOverlay = memo(({ marqueeRef }: MarqueeOverlayProps) => {
  return (
    <div 
      ref={marqueeRef}
      style={{
        position: 'absolute',
        display: 'none',
        background: 'var(--accent-glow)',
        border: '1px solid var(--accent-primary)',
        zIndex: 1000, // Explicit z-index layer for marquee bounds overlay
        pointerEvents: 'none',
        borderRadius: 'var(--radius-xs)',
        willChange: 'left, top, width, height',
        contain: 'strict',
      }} 
    />
  );
});

MarqueeOverlay.displayName = 'MarqueeOverlay';
