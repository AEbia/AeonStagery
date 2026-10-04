import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconRefresh, IconX } from '../icons';

type SpotlightStatusTone = 'neutral' | 'checking' | 'success' | 'warning';

interface SpotlightStatus {
  label: string;
  tone?: SpotlightStatusTone;
}

interface SpotlightAction {
  label: string;
  onClick: () => void;
}

export interface SpotlightOverlayProps {
  targetSelector: string;
  title: string;
  description: string;
  stepLabel: string;
  onClose: () => void;
  padding?: number;
  targetRadius?: number;
  allowTargetInteraction?: boolean;
  allowWorkspaceInteraction?: boolean;
  showSpotlight?: boolean;
  status?: SpotlightStatus;
  action?: SpotlightAction;
}

interface ViewportRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_WIDTH = 340;
const CARD_ESTIMATED_HEIGHT = 176;
const VIEWPORT_GAP = 12;
const TARGET_GAP = 14;

const isSameRect = (left: ViewportRect | null, right: ViewportRect | null) => {
  if (!left || !right) return left === right;
  return Math.abs(left.top - right.top) < 0.5
    && Math.abs(left.left - right.left) < 0.5
    && Math.abs(left.width - right.width) < 0.5
    && Math.abs(left.height - right.height) < 0.5;
};

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
);

const measureTarget = (selector: string, padding: number): ViewportRect | null => {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return null;
  const style = window.getComputedStyle(target);
  const raw = target.getBoundingClientRect();
  if (style.display === 'none' || style.visibility === 'hidden' || raw.width <= 0 || raw.height <= 0) {
    return null;
  }

  const left = clamp(raw.left - padding, 0, window.innerWidth);
  const top = clamp(raw.top - padding, 0, window.innerHeight);
  const right = clamp(raw.right + padding, 0, window.innerWidth);
  const bottom = clamp(raw.bottom + padding, 0, window.innerHeight);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
};

const getCardPosition = (target: ViewportRect, cardHeight: number) => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const cardWidth = Math.min(CARD_WIDTH, viewportWidth - VIEWPORT_GAP * 2);
  const targetRight = target.left + target.width;
  const targetBottom = target.top + target.height;
  const centeredLeft = clamp(
    target.left + target.width / 2 - cardWidth / 2,
    VIEWPORT_GAP,
    viewportWidth - cardWidth - VIEWPORT_GAP,
  );

  if (viewportHeight - targetBottom >= cardHeight + TARGET_GAP + VIEWPORT_GAP) {
    return { left: centeredLeft, top: targetBottom + TARGET_GAP, width: cardWidth, placement: 'bottom' };
  }
  if (target.top >= cardHeight + TARGET_GAP + VIEWPORT_GAP) {
    return { left: centeredLeft, top: target.top - cardHeight - TARGET_GAP, width: cardWidth, placement: 'top' };
  }
  if (viewportWidth - targetRight >= cardWidth + TARGET_GAP + VIEWPORT_GAP) {
    return {
      left: targetRight + TARGET_GAP,
      top: clamp(target.top, VIEWPORT_GAP, viewportHeight - cardHeight - VIEWPORT_GAP),
      width: cardWidth,
      placement: 'right',
    };
  }
  if (target.left >= cardWidth + TARGET_GAP + VIEWPORT_GAP) {
    return {
      left: target.left - cardWidth - TARGET_GAP,
      top: clamp(target.top, VIEWPORT_GAP, viewportHeight - cardHeight - VIEWPORT_GAP),
      width: cardWidth,
      placement: 'left',
    };
  }

  return {
    left: centeredLeft,
    top: clamp(targetBottom + TARGET_GAP, VIEWPORT_GAP, viewportHeight - cardHeight - VIEWPORT_GAP),
    width: cardWidth,
    placement: 'overlap',
  };
};

export const SpotlightOverlay: React.FC<SpotlightOverlayProps> = ({
  targetSelector,
  title,
  description,
  stepLabel,
  onClose,
  padding = 8,
  targetRadius = 8,
  allowTargetInteraction = true,
  allowWorkspaceInteraction = false,
  showSpotlight = true,
  status,
  action,
}) => {
  const [targetRect, setTargetRect] = useState<ViewportRect | null>(null);
  const [cardHeight, setCardHeight] = useState(CARD_ESTIMATED_HEIGHT);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.querySelector<HTMLElement>(targetSelector)?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [targetSelector]);

  useLayoutEffect(() => {
    let frame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let observedTarget: HTMLElement | null = null;

    const update = () => {
      frame = null;
      const nextTarget = document.querySelector<HTMLElement>(targetSelector);
      if (nextTarget !== observedTarget) {
        if (resizeObserver && observedTarget) resizeObserver.unobserve(observedTarget);
        observedTarget = nextTarget;
        if (resizeObserver && observedTarget) resizeObserver.observe(observedTarget);
      }
      const nextRect = measureTarget(targetSelector, padding);
      setTargetRect((current) => isSameRect(current, nextRect) ? current : nextRect);
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(update);
    };

    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'aria-label', 'data-active'],
    });
    window.addEventListener('resize', scheduleUpdate);
    document.addEventListener('scroll', scheduleUpdate, true);
    update();

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [padding, targetSelector]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const update = () => setCardHeight(card.getBoundingClientRect().height || CARD_ESTIMATED_HEIGHT);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(card);
    return () => observer?.disconnect();
  }, [description, status?.label, title]);

  const cardPosition = useMemo(
    () => targetRect ? getCardPosition(targetRect, cardHeight) : null,
    [cardHeight, targetRect],
  );

  const blockPointer = (event: React.PointerEvent | React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div className="fl-spotlight" data-testid="first-lesson-spotlight">
      {targetRect && showSpotlight ? (
        <>
          {!allowWorkspaceInteraction && <div
            className="fl-spotlight__blocker"
            aria-hidden="true"
            style={{ top: 0, left: 0, width: '100vw', height: targetRect.top }}
            onPointerDown={blockPointer}
            onContextMenu={blockPointer}
          />}
          {!allowWorkspaceInteraction && <div
            className="fl-spotlight__blocker"
            aria-hidden="true"
            style={{ top: targetRect.top, left: 0, width: targetRect.left, height: targetRect.height }}
            onPointerDown={blockPointer}
            onContextMenu={blockPointer}
          />}
          {!allowWorkspaceInteraction && <div
            className="fl-spotlight__blocker"
            aria-hidden="true"
            style={{
              top: targetRect.top,
              left: targetRect.left + targetRect.width,
              right: 0,
              height: targetRect.height,
            }}
            onPointerDown={blockPointer}
            onContextMenu={blockPointer}
          />}
          {!allowWorkspaceInteraction && <div
            className="fl-spotlight__blocker"
            aria-hidden="true"
            style={{ top: targetRect.top + targetRect.height, left: 0, right: 0, bottom: 0 }}
            onPointerDown={blockPointer}
            onContextMenu={blockPointer}
          />}
          {!allowTargetInteraction && (
            <div
              className="fl-spotlight__target-blocker"
              aria-hidden="true"
              style={targetRect}
              onPointerDown={blockPointer}
              onContextMenu={blockPointer}
            />
          )}
          <div
            className="fl-spotlight__hole"
            aria-hidden="true"
            style={{ ...targetRect, borderRadius: targetRadius }}
          >
            <span />
          </div>
        </>
      ) : !targetRect && showSpotlight ? (
        <div
          className="fl-spotlight__missing-target"
          aria-hidden="true"
          onPointerDown={blockPointer}
          onContextMenu={blockPointer}
        />
      ) : null}

      <aside
        ref={cardRef}
        className={`fl-spotlight__card${targetRect ? '' : ' fl-spotlight__card--waiting'}`}
        data-placement={cardPosition?.placement ?? 'center'}
        aria-live="polite"
        style={cardPosition ? {
          top: cardPosition.top,
          left: cardPosition.left,
          width: cardPosition.width,
        } : undefined}
      >
        <div className="fl-spotlight__card-header">
          <span className="fl-spotlight__step">{stepLabel}</span>
          <button
            type="button"
            className="btn btn--icon fl-spotlight__close"
            onClick={onClose}
            aria-label="关闭教程"
            title="关闭教程"
          >
            <IconX width={15} height={15} />
          </button>
        </div>
        <h2>{targetRect ? title : '正在定位下一步'}</h2>
        <p>{targetRect ? description : '界面正在准备，目标出现后会自动继续。'}</p>
        {status && (
          <div className="fl-spotlight__status" data-tone={status.tone ?? 'neutral'}>
            {status.tone === 'checking' && <span className="fl-lesson-spinner" aria-hidden="true" />}
            <span>{status.label}</span>
          </div>
        )}
        {action && (
          <button type="button" className="btn fl-spotlight__action" onClick={action.onClick}>
            <IconRefresh width={13} height={13} />
            {action.label}
          </button>
        )}
      </aside>
    </div>,
    document.body,
  );
};

export default SpotlightOverlay;
