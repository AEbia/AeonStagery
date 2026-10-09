import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Keep closing details mounted until exit completes; virtual remounts do not animate. */
export function InlineStatementDetails({ expanded, children }: { expanded: boolean; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(expanded);
  const wasExpanded = useRef(expanded);
  const activeAnimation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const changed = expanded !== wasExpanded.current;
    wasExpanded.current = expanded;
    if (!changed) return;
    const element = container.current;
    if (!element?.animate || element.closest('[data-perf="low"]')
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setPresent(expanded);
      return;
    }

    setPresent(true);
    const style = window.getComputedStyle(element);
    const openFrame = {
      height: `${element.getBoundingClientRect().height}px`, opacity: 1,
      paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderBottomWidth: style.borderBottomWidth,
    };
    const closedFrame = { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px' };
    element.style.overflow = 'hidden';
    const animation = element.animate(
      expanded ? [closedFrame, openFrame] : [openFrame, closedFrame],
      { duration: expanded ? 150 : 120, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' },
    );
    activeAnimation.current = animation;
    animation.onfinish = () => {
      if (!expanded) {
        // React batches this removal. Preserve the filled final frame until commit.
        setPresent(false);
        return;
      }
      element.style.overflow = '';
      animation.cancel();
      activeAnimation.current = null;
    };
    return () => {
      animation.onfinish = null;
      animation.cancel();
      activeAnimation.current = null;
      element.style.overflow = '';
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (expanded || present) return;
    // The detail DOM has been removed, so cancelling cannot expose its natural height.
    activeAnimation.current?.cancel();
    activeAnimation.current = null;
  }, [expanded, present]);

  return expanded || present ? (
    <div ref={container} className="inspector-workspace__detail" aria-hidden={!expanded}
      {...{ inert: !expanded ? '' : undefined }} onClick={(event) => event.stopPropagation()}>
      <div className="timeline-item__detail-content">{children}</div>
    </div>
  ) : null;
}
