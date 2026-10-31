/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { useState } from 'react';
import { useHomeNavigation } from '../useHomeNavigation';
import { useWorkspaceTransition } from '../useWorkspaceTransition';

const animations: Animation[] = [];
const restoredFrames: string[] = [];
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

beforeEach(() => {
  animations.length = 0;
  restoredFrames.length = 0;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => mock<MediaQueryList>({ matches: false, media: query }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(function (this: HTMLElement, keyframes: Keyframe[]) {
    let settle: (animation: Animation) => void = () => {};
    const finished = new Promise<Animation>((resolve) => { settle = resolve; });
    const animation = mock<Animation>();
    Object.defineProperty(animation, 'finished', { value: finished });
    let ended = false;
    animation.finish.mockImplementation(() => { ended = true; settle(animation); });
    animation.cancel.mockImplementation(() => {
      // Cancelling a filled exit restores the underlying DOM immediately, before React's next paint.
      const coveredEditor = this.matches('.main-content, .bottom-panel') && document.querySelector('.ph-overlay');
      if (ended && keyframes.at(-1)?.opacity === 0 && this.isConnected && !coveredEditor) restoredFrames.push(this.textContent ?? '');
      settle(animation);
    });
    animations.push(animation);
    return animation;
  }) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  document.documentElement.removeAttribute('data-perf');
});

async function finishMotion() {
  await act(async () => { [...animations].forEach((animation) => animation.finish()); });
}

function NavigationHarness() {
  const { view, stageRef, navigateTo } = useHomeNavigation();
  return <div className="ph-overlay">
    <button onClick={() => navigateTo('start')}>home</button>
    <button onClick={() => navigateTo('create-form')}>create</button>
    <button onClick={() => navigateTo('collab-menu')}>collaborate</button>
    <div ref={stageRef}><h1>{view}</h1></div>
  </div>;
}

function WorkspaceHarness({ showHome, editorReady = true, close = async () => true }: { showHome: boolean; editorReady?: boolean; close?: () => Promise<boolean> }) {
  const transition = useWorkspaceTransition(showHome, editorReady);
  return <div ref={(element) => {
    transition.rootRef.current = element;
    element?.toggleAttribute('inert', transition.busy);
  }} aria-busy={transition.busy}>
    <button className="top-bar__brand-control--return" onClick={() => { void transition.returnHome(close); }}>return</button>
    <div className="main-content">editor</div>
    <div className="bottom-panel">timeline</div>
    {transition.homeMounted && <div className="ph-overlay"><div className="ph-shell"><h1>project home</h1></div></div>}
  </div>;
}

function ReturnHarness() {
  const [showHome, setShowHome] = useState(false);
  return <WorkspaceHarness showHome={showHome} close={async () => { setShowHome(true); return true; }} />;
}

describe('home navigation lifetime', () => {
  it('never restores the outgoing page between its completed exit and the replacement commit', async () => {
    render(<NavigationHarness />);
    fireEvent.click(screen.getByText('create'));
    await finishMotion();
    expect(restoredFrames).not.toContain('start');
    expect(screen.getByRole('heading').textContent).toBe('create-form');
  });
  it('keeps the outgoing view inert until exit, uses the latest request, and applies the same lifetime on return', async () => {
    render(<NavigationHarness />);
    fireEvent.click(screen.getByText('create'));
    expect(screen.getByRole('heading').textContent).toBe('start');
    expect(screen.getByRole('heading').parentElement?.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByText('collaborate'));
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('collab-menu');
    expect(document.activeElement).toBe(screen.getByRole('heading'));
    fireEvent.click(screen.getByText('home'));
    expect(screen.getByRole('heading').textContent).toBe('collab-menu');
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('start');
    await finishMotion();
    expect(screen.getByRole('heading').parentElement?.hasAttribute('inert')).toBe(false);
  });

  it('can reverse a pending navigation back to the current view without leaving it hidden or inert', async () => {
    render(<NavigationHarness />);
    fireEvent.click(screen.getByText('create'));
    fireEvent.click(screen.getByText('home'));
    await finishMotion();
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('start');
    expect(screen.getByRole('heading').parentElement?.hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByText('create'));
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('create-form');
  });

  it('switches immediately in low performance mode without an animation timer', () => {
    document.documentElement.dataset.perf = 'low';
    render(<NavigationHarness />);
    fireEvent.click(screen.getByText('create'));
    expect(screen.getByRole('heading').textContent).toBe('create-form');
    expect(animations).toHaveLength(0);
  });

  it('respects reduced motion without delaying navigation', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(mock<MediaQueryList>({ matches: true }));
    render(<NavigationHarness />);
    fireEvent.click(screen.getByText('collaborate'));
    expect(screen.getByRole('heading').textContent).toBe('collab-menu');
    expect(animations).toHaveLength(0);
  });
});

describe('home and editor continuity', () => {
  it.each([false, true])('waits for the scene before exposing the editor (reduced motion: %s)', async (reducedMotion) => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(mock<MediaQueryList>({ matches: reducedMotion }));
    const { rerender } = render(<WorkspaceHarness showHome editorReady={false} />);

    // Project metadata arrives first; loading its default scene can outlast the exit animation.
    rerender(<WorkspaceHarness showHome={false} editorReady={false} />);
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('project home');
    expect(document.querySelector('.ph-overlay')?.hasAttribute('data-departing')).toBe(false);
    expect(animations).toHaveLength(0);

    rerender(<WorkspaceHarness showHome={false} editorReady />);
    await finishMotion();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(document.activeElement).toBe(screen.getByText('return'));
  });

  it('keeps the home intact when scene loading fails and the project rolls back', async () => {
    const { rerender } = render(<WorkspaceHarness showHome editorReady={false} />);
    rerender(<WorkspaceHarness showHome={false} editorReady={false} />);
    await finishMotion();
    rerender(<WorkspaceHarness showHome editorReady={false} />);
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('project home');
    expect(animations).toHaveLength(0);
    expect(screen.getByText('editor').parentElement?.hasAttribute('inert')).toBe(false);
  });

  it('allows an already open editor to have no active scene', () => {
    render(<WorkspaceHarness showHome={false} editorReady={false} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('editor').parentElement?.hasAttribute('inert')).toBe(false);
  });

  it('keeps the departed editor covered until the home commits on a successful return', async () => {
    render(<ReturnHarness />);
    fireEvent.click(screen.getByText('return'));
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('project home');
    expect(restoredFrames).not.toContain('editor');
    await finishMotion();
    expect(screen.getByText('editor').parentElement?.getAttribute('aria-busy')).toBe('false');
  });
  it('retains the home through editor entrance, then transfers focus, and can return', async () => {
    const { rerender } = render(<WorkspaceHarness showHome />);
    rerender(<WorkspaceHarness showHome={false} />);
    expect(screen.getByRole('heading').textContent).toBe('project home');
    expect(screen.getByText('editor').parentElement?.getAttribute('aria-busy')).toBe('true');
    await finishMotion();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(restoredFrames).not.toContain('project home');
    expect(document.activeElement).toBe(screen.getByText('return'));
    rerender(<WorkspaceHarness showHome />);
    await finishMotion();
    expect(document.activeElement).toBe(screen.getByRole('heading'));
  });

  it('cancels an outdated exit when a project load returns to the home', async () => {
    const { rerender } = render(<WorkspaceHarness showHome />);
    rerender(<WorkspaceHarness showHome={false} />);
    rerender(<WorkspaceHarness showHome />);
    await finishMotion();
    expect(screen.getByRole('heading').textContent).toBe('project home');
    expect(screen.getByText('editor').parentElement?.getAttribute('aria-busy')).toBe('false');
  });

  it('finishes the editor exit before closing, prevents duplicate closes, and restores a failed save', async () => {
    const close = vi.fn(async () => false);
    render(<WorkspaceHarness showHome={false} close={close} />);
    fireEvent.click(screen.getByText('return'));
    fireEvent.click(screen.getByText('return'));
    expect(close).not.toHaveBeenCalled();
    await finishMotion();
    expect(close).toHaveBeenCalledOnce();
    await finishMotion();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('editor').parentElement?.getAttribute('aria-busy')).toBe('false');
  });

  it('finishes a running sequence when the window becomes hidden', async () => {
    const { rerender } = render(<WorkspaceHarness showHome />);
    rerender(<WorkspaceHarness showHome={false} />);
    await act(async () => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('editor').parentElement?.getAttribute('aria-busy')).toBe('false');
  });
});
