/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDetailsDismissal } from '../ui/hooks/useDetailsDismissal';

afterEach(cleanup);
function Menu() {
  const ref = useDetailsDismissal();
  return <><details ref={ref} open><summary>更多操作</summary><button>切换主题</button></details><button>舞台</button></>;
}

describe('native details menu dismissal', () => {
  it('keeps inside interaction open and dismisses on an outside pointer', () => {
    const { getByText } = render(<Menu />);
    const details = getByText('更多操作').closest('details')!;
    fireEvent.pointerDown(getByText('切换主题'));
    expect(details.open).toBe(true);
    fireEvent.pointerDown(getByText('舞台'));
    expect(details.open).toBe(false);
  });

  it('closes on Escape and returns keyboard focus to its summary', () => {
    const { getByText } = render(<Menu />);
    getByText('切换主题').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(getByText('更多操作').closest('details')!.open).toBe(false);
    expect(document.activeElement).toBe(getByText('更多操作'));
  });

  it('removes document handlers when the menu unmounts', () => {
    const { getByText, unmount } = render(<Menu />);
    const details = getByText('更多操作').closest('details')!;
    unmount();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(details.open).toBe(true);
  });
});
