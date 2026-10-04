import React, { useRef, memo } from 'react';
import { usePlayhead } from './usePlayhead';

interface PlayheadProps {
  pps: number;
  areaRef: React.RefObject<HTMLDivElement | null>;
  onSeek: (time: number, isFinal: boolean) => void;
}

export const Playhead = memo(({ pps, areaRef, onSeek }: PlayheadProps) => {
  const playheadRef = useRef<HTMLDivElement>(null);
  const { handlePointerDown } = usePlayhead(playheadRef, pps, areaRef, onSeek);

  return (
    <div
      className="playhead-line"
      ref={playheadRef}
      style={{
        position: 'absolute',
        left: '100px',
        top: 0,
        bottom: 0,
        width: '2px',
        background: 'var(--error)',
        zIndex: 150,
        boxShadow: '0 0 6px rgba(239, 68, 68, 0.35)',
        borderRadius: 'var(--radius-xs)',
        pointerEvents: 'none',
        willChange: 'transform',
      }}
    >
      <div
        className="playhead-handle"
        onPointerDown={handlePointerDown}
        style={{
          position: 'absolute',
          top: '-2px',
          left: '-6px',
          width: '14px',
          height: '9px',
          background: 'var(--error)',
          borderRadius: 'var(--radius-xs)',
          cursor: 'ew-resize',
          pointerEvents: 'auto',
          zIndex: 160,
          clipPath: 'polygon(0% 0%, 100% 0%, 50% 100%)',
          willChange: 'transform',
        }}
      />
    </div>
  );
});

Playhead.displayName = 'Playhead';
