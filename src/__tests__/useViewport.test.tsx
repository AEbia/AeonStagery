/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useViewport } from '../ui/hooks/useViewport';

afterEach(cleanup);

function Stage({ enabled = true }: { enabled?: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { viewport } = useViewport(stageRef, enabled);
  return <div data-testid="stage" ref={stageRef}>{viewport.zoom}</div>;
}

describe('useViewport wheel handling', () => {
  it('cancels native scrolling while zooming the stage', () => {
    const { getByTestId } = render(<StrictMode><Stage /></StrictMode>);
    const stage = getByTestId('stage');
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });

    fireEvent(stage, event);

    expect(stage.textContent).toBe('1.1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('allows scrolling on the project home and resumes stage zooming when enabled', () => {
    const { getByTestId, rerender } = render(<Stage enabled={false} />);
    const stage = getByTestId('stage');
    const wheel = () => new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });

    const homeEvent = wheel();
    fireEvent(stage, homeEvent);
    expect(homeEvent.defaultPrevented).toBe(false);
    expect(stage.textContent).toBe('1');

    rerender(<Stage />);
    const stageEvent = wheel();
    fireEvent(stage, stageEvent);
    expect(stageEvent.defaultPrevented).toBe(true);
    expect(stage.textContent).toBe('1.1');

    rerender(<Stage enabled={false} />);
    const disabledEvent = wheel();
    fireEvent(stage, disabledEvent);
    expect(disabledEvent.defaultPrevented).toBe(false);
    expect(stage.textContent).toBe('1.1');
  });

  it('removes the wheel listener when unmounted', () => {
    const { getByTestId, unmount } = render(<Stage />);
    const stage = getByTestId('stage');
    unmount();

    const event = new WheelEvent('wheel', { cancelable: true, deltaY: -100 });
    fireEvent(stage, event);
    expect(event.defaultPrevented).toBe(false);
  });
});
