/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpotlightOverlay } from '../ui/onboarding/SpotlightOverlay';
import { StatementLibraryMenu } from '../ui/timeline/StatementLibraryMenu';

const RECENT_STORAGE_KEY = 'aeonstagery.statementBlockLibrary.recent';
const TARGET_SELECTOR = '[data-testid="timeline-blank-insert-menu"] [data-block-id="environment.set-background"]';

describe('StatementLibraryMenu selection during delayed insertion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('[data-block-id]')) {
        const section = this.closest('.statement-block-library__section');
        const isRecent = section?.firstElementChild?.textContent === '最近使用';
        const index = Array.from(this.parentElement?.children ?? []).indexOf(this);
        return new DOMRect(40, isRecent ? 100 + index * 32 : 400, 160, 28);
      }
      return new DOMRect(20, 20, 420, 520);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([false, true])('keeps the spotlight in place until insertion finishes (existing history=%s)', async (hasHistory) => {
    if (hasHistory) {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([
        { type: 'statement', id: 'camera.focus' },
        { type: 'statement', id: 'environment.set-background' },
      ]));
    }
    let finishInsertion = () => {};
    const insertion = new Promise<void>((resolve) => { finishInsertion = resolve; });
    const onInsert = vi.fn(() => insertion);
    const Harness = () => {
      const [open, setOpen] = useState(true);
      return <>
        <button onClick={() => setOpen(true)}>重新打开</button>
        <StatementLibraryMenu
          menu={open ? { x: 20, y: 20, time: 1 } : null}
          onSelectAction={async () => {
            await onInsert();
            setOpen(false);
          }}
          dataTestId="timeline-blank-insert-menu"
          ariaLabel="语句库菜单"
        />
        {open && <SpotlightOverlay
          targetSelector={TARGET_SELECTOR}
          title="选择环境画面"
          description="点击加入语句。"
          stepLabel="环境画面"
          onClose={() => undefined}
          padding={0}
        />}
      </>;
    };
    render(<Harness />);
    const target = document.querySelector<HTMLButtonElement>(TARGET_SELECTOR);
    expect(target).toBeTruthy();
    const initialTop = document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.top;
    expect(initialTop).toBe(hasHistory ? '132px' : '400px');

    fireEvent.click(target!);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(onInsert).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: '语句库菜单' })).toBeTruthy();
    expect(document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.top).toBe(initialTop);
    expect(document.querySelector(TARGET_SELECTOR)).toBe(target);
    expect(JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? '[]')[0]).toEqual({
      type: 'statement', id: 'environment.set-background',
    });

    await act(async () => { finishInsertion(); });
    expect(screen.queryByRole('dialog', { name: '语句库菜单' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(document.querySelector(TARGET_SELECTOR)?.closest('.statement-block-library__section')?.firstElementChild?.textContent).toBe('最近使用');
    expect(document.querySelector<HTMLElement>('.fl-spotlight__hole')?.style.top).toBe('100px');
  });
});
