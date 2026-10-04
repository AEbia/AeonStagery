/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';

const resourceLibraryMocks = vi.hoisted(() => ({
  readMergedDirectory: vi.fn(),
}));

vi.mock('../ui/ResourceLibrary', () => ({
  readMergedDirectory: resourceLibraryMocks.readMergedDirectory,
}));

let TextArea: typeof import('../ui/timeline/FormComponents').TextArea;
let TextInput: typeof import('../ui/timeline/FormComponents').TextInput;
let EnvironmentLayerNameInput: typeof import('../ui/timeline/FormComponents').EnvironmentLayerNameInput;
let FileInput: typeof import('../ui/timeline/FormComponents').FileInput;
let InlineNumericInput: typeof import('../ui/timeline/FormComponents').InlineNumericInput;

beforeAll(async () => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  ({ TextArea, TextInput, EnvironmentLayerNameInput, FileInput, InlineNumericInput } = await import('../ui/timeline/FormComponents'));
});

beforeEach(() => {
  resourceLibraryMocks.readMergedDirectory.mockReset();
  resourceLibraryMocks.readMergedDirectory.mockResolvedValue([]);
  (window as any).aeonStageryAPI = undefined;
});

function renderWithSceneAssets(ui: React.ReactElement, sceneAssets: any) {
  return render(
    <AppProvider
      adapters={{ document: {}, playback: {}, camera: {}, character: {}, stage: {}, timeline: {}, export: {} } as any}
      stores={{ document: {}, playback: {}, editor: {}, validation: {} } as any}
      services={{ sceneFile: {}, sceneAssets } as any}
    >
      {ui}
    </AppProvider>,
  );
}

describe('collaborative text draft inputs', () => {
  it('emits transient numeric scrub updates before the final value', () => {
    Object.defineProperty(document.body, 'requestPointerLock', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(document, 'exitPointerLock', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => null,
    });

    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="时间" value={1} step="0.1" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseDown(scrubber, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.mouseMove(document, { clientX: 20, clientY: 10, movementX: 10 });
    fireEvent.mouseUp(document, { clientX: 20, clientY: 10 });

    expect(onChange).toHaveBeenNthCalledWith(1, 2, true);
    expect(onChange).toHaveBeenNthCalledWith(2, 2, false);
  });

  it('adjusts a numeric scrubber from the keyboard', () => {
    const onChange = vi.fn();
    render(<InlineNumericInput ariaLabel="时间" value={1} step="0.1" onChange={onChange} />);

    const spinbutton = screen.getByRole('spinbutton', { name: '时间' });
    fireEvent.keyDown(spinbutton, { key: 'ArrowUp' });
    fireEvent.keyDown(spinbutton, { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenNthCalledWith(1, 1.1, false);
    expect(onChange).toHaveBeenNthCalledWith(2, 1, false);
  });

  it('triggers dragging on subtle 2px movement without long delay', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="透明" value={0.5} step="0.05" min="0" max="1" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseDown(scrubber, { clientX: 10, clientY: 10, button: 0 });
    // First tiny movement of 1px: below 2px deadband, should not trigger yet
    fireEvent.mouseMove(document, { clientX: 11, clientY: 10 });
    expect(onChange).not.toHaveBeenCalled();

    // Second tiny movement reaches 2px cumulative: triggers drag immediately!
    fireEvent.mouseMove(document, { clientX: 12, clientY: 10 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.any(Number), true);

    fireEvent.mouseUp(document, { clientX: 12, clientY: 10 });
    expect(onChange).toHaveBeenLastCalledWith(expect.any(Number), false);
  });

  it('clamps numeric values strictly within min and max during drag', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="透明" value={0.9} step="0.05" min="0" max="1" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseDown(scrubber, { clientX: 10, clientY: 10, button: 0 });
    // Huge drag to the right
    fireEvent.mouseMove(document, { clientX: 1000, clientY: 10 });
    expect(onChange).toHaveBeenLastCalledWith(1, true);

    // Huge drag to the left
    fireEvent.mouseMove(document, { clientX: -1000, clientY: 10 });
    expect(onChange).toHaveBeenLastCalledWith(0, true);

    fireEvent.mouseUp(document, { clientX: -1000, clientY: 10 });
    expect(onChange).toHaveBeenLastCalledWith(0, false);
  });

  it('clamps direct input on blur and supports Escape to cancel', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="透明" value={0.5} step="0.05" min="0" max="1" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseDown(scrubber, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document, { clientX: 10, clientY: 10 });

    const input = container.querySelector('input.scrubbable-input-mode') as HTMLInputElement;
    expect(input).not.toBeNull();

    // Type 999 (which exceeds max=1)
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);

    // It must clamp to 1!
    expect(onChange).toHaveBeenCalledWith(1, false);
  });

  it('cancels edit on Escape key without emitting onChange', () => {
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="透明" value={0.5} step="0.05" min="0" max="1" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseDown(scrubber, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document, { clientX: 10, clientY: 10 });

    const input = container.querySelector('input.scrubbable-input-mode') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.8' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(container.querySelector('input.scrubbable-input-mode')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('.scrubbable-badge-value')!.textContent).toBe('0.5');
  });

  it('supports Alt for fine adjustment and Shift for coarse keyboard adjustment', () => {
    const onChange = vi.fn();
    render(<InlineNumericInput ariaLabel="旋转" value={0} step="1" onChange={onChange} />);

    const spinbutton = screen.getByRole('spinbutton', { name: '旋转' });
    fireEvent.keyDown(spinbutton, { key: 'ArrowUp', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(5, false);

    fireEvent.keyDown(spinbutton, { key: 'ArrowUp', altKey: true });
    expect(onChange).toHaveBeenLastCalledWith(5.2, false);
  });

  it('shows scale popover on hover for bounded parameter and allows dragging track', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="X" value={0.2} step="0.01" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseEnter(scrubber);
    expect(document.querySelector('.scrubbable-popover')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    const popover = document.querySelector('.scrubbable-popover') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.textContent).toContain('0');
    expect(popover.textContent).toContain('1');

    const trackContainer = document.querySelector('.scrubbable-popover__track-container') as HTMLElement;
    expect(trackContainer).not.toBeNull();

    trackContainer.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      width: 100,
      height: 10,
      right: 200,
      bottom: 60,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    fireEvent.pointerDown(trackContainer, { clientX: 180, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(0.8, true);

    fireEvent.pointerMove(trackContainer, { clientX: 150, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(0.5, true);

    fireEvent.pointerUp(trackContainer, { clientX: 150, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(0.5, false);

    fireEvent.mouseLeave(scrubber);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('.scrubbable-popover')).toBeNull();
    vi.useRealTimers();
  });

  it('magnetically snaps to ticks when pointer is close to tick marks, and allows Alt key bypass', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="X" value={0.2} step="0.01" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseEnter(scrubber);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const popover = document.querySelector('.scrubbable-popover') as HTMLElement;
    expect(popover).not.toBeNull();

    const trackContainer = document.querySelector('.scrubbable-popover__track-container') as HTMLElement;
    trackContainer.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      width: 100,
      height: 10,
      right: 200,
      bottom: 60,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    // 75% tick is at clientX = 175. clientX = 174 is 1px away (within SNAP_THRESHOLD_PX 4.5px)
    fireEvent.pointerDown(trackContainer, { clientX: 174, pointerId: 1 });
    // Magnetic snap activates: snaps to 0.75 instead of 0.74
    expect(onChange).toHaveBeenLastCalledWith(0.75, true);
    const thumb = document.querySelector('.scrubbable-popover__thumb') as HTMLElement;
    expect(thumb.className).toContain('is-snapped');

    const activeTicks = document.querySelectorAll('.scrubbable-popover__tick--active');
    expect(activeTicks.length).toBeGreaterThan(0);

    // Holding Alt key bypasses magnetic snapping
    fireEvent.pointerMove(trackContainer, { clientX: 174, pointerId: 1, altKey: true });
    expect(onChange).toHaveBeenLastCalledWith(0.74, true);
    expect(thumb.className).not.toContain('is-snapped');

    // Releasing Alt key re-enables magnetic snapping
    fireEvent.pointerMove(trackContainer, { clientX: 174, pointerId: 1, altKey: false });
    expect(onChange).toHaveBeenLastCalledWith(0.75, true);
    expect(thumb.className).toContain('is-snapped');

    // Pointer up commits the snapped value and clears is-snapped
    fireEvent.pointerUp(trackContainer, { clientX: 174, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(0.75, false);

    fireEvent.mouseLeave(scrubber);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('.scrubbable-popover')).toBeNull();
    vi.useRealTimers();
  });

  it('flips popover placement when space above is constrained to prevent viewport occlusion', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="Y" value={0.5} step="0.01" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    // Mock near-top positioning where spaceAbove < POPOVER_HEIGHT
    scrubber.getBoundingClientRect = () => ({
      left: 50,
      top: 20,
      right: 120,
      bottom: 40,
      width: 70,
      height: 20,
      x: 50,
      y: 20,
      toJSON: () => {},
    });

    fireEvent.mouseEnter(scrubber);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const popover = document.querySelector('.scrubbable-popover') as HTMLElement;
    expect(popover).not.toBeNull();
    // Space above is only 20 - 7 - 8 = 5px < 74px, so it must flip to bottom
    expect(popover.className).toContain('scrubbable-popover--bottom');

    fireEvent.mouseLeave(scrubber);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('.scrubbable-popover')).toBeNull();
    vi.useRealTimers();
  });

  it('shows popover for unbounded numeric input and auto-centers view range', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="Z" value={50} step="10" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseEnter(scrubber);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const popover = document.querySelector('.scrubbable-popover') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.querySelector('.scrubbable-popover__ticks')).not.toBeNull();
    expect(popover.querySelector('.scrubbable-popover__edge-hint--left')).not.toBeNull();
    expect(popover.querySelector('.scrubbable-popover__edge-hint--right')).not.toBeNull();

    fireEvent.mouseLeave(scrubber);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector('.scrubbable-popover')).toBeNull();
    vi.useRealTimers();
  });

  it('supports dragging and auto-scrolling on unbounded numeric inputs', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(
      <InlineNumericInput dragLabel="Z" value={0} step="1" popoverMin="-10" popoverMax="10" onChange={onChange} />,
    );

    const scrubber = container.querySelector('.scrubbable-badge') as HTMLElement;
    fireEvent.mouseEnter(scrubber);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const popover = document.querySelector('.scrubbable-popover') as HTMLElement;
    expect(popover).not.toBeNull();
    const trackContainer = document.querySelector('.scrubbable-popover__track-container') as HTMLElement;

    trackContainer.getBoundingClientRect = () => ({
      left: 100,
      top: 50,
      width: 100,
      height: 10,
      right: 200,
      bottom: 60,
      x: 100,
      y: 50,
      toJSON: () => {},
    });

    // Pointer down near the right edge (clientX = 195, ratio = 0.95 > 0.88)
    fireEvent.pointerDown(trackContainer, { clientX: 195, pointerId: 1 });
    expect(onChange).toHaveBeenCalled();

    // Advancing timers executes the auto-scroll requestAnimationFrame
    act(() => {
      vi.advanceTimersByTime(100);
    });

    fireEvent.pointerUp(trackContainer, { clientX: 195, pointerId: 1 });

    fireEvent.mouseLeave(scrubber);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
  });

  it('keeps a focused textarea draft when remote state updates the prop value', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextArea label="文本内容" value="远端旧文本" onChange={onChange} />,
    );
    const textarea = container.querySelector('textarea')!;

    fireEvent.mouseDown(textarea);
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '本地写到一半' } });
    rerender(<TextArea label="文本内容" value="远端新文本" onChange={onChange} />);

    expect(textarea.value).toBe('本地写到一半');
    expect(screen.getByRole('status').textContent).toContain('远端已更新');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledWith('本地写到一半');
  });

  it('does not flag the echo of the user\'s own committed value as a remote update during a follow-up edit', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextArea label="文本内容" value="旧文本" onChange={onChange} />,
    );
    const textarea = container.querySelector('textarea')!;

    // 1. First editing session: commit "新文本1" (blur fires onChange).
    fireEvent.mouseDown(textarea);
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '新文本1' } });
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenLastCalledWith('新文本1');

    // 2. The authoring commit is async — the prop still carries the old
    //    value when the user immediately re-focuses and starts a follow-up
    //    edit session ("新文本2").
    fireEvent.mouseDown(textarea);
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '新文本2' } });

    // 3. The async commit lands: the prop now carries exactly the value the
    //    user committed in session 1. This is the user's own echo, not a
    //    remote update — no collaborative notice may appear.
    rerender(<TextArea label="文本内容" value="新文本1" onChange={onChange} />);

    expect(textarea.value).toBe('新文本2');
    expect(screen.queryByRole('status')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);

    // 4. Blurring still commits the follow-up draft.
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenLastCalledWith('新文本2');
  });

  it('keeps the just-committed text while the async commit is in flight (stale prop must not clobber the field)', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextArea label="文本内容" value="旧文本" onChange={onChange} />,
    );
    const textarea = container.querySelector('textarea')!;

    // 1. Commit "新文本" by blurring. The async authoring commit is in
    //    flight, so the prop still carries the pre-commit value.
    fireEvent.mouseDown(textarea);
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '新文本' } });
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenLastCalledWith('新文本');

    // 2. While the commit is still pending the parent re-renders with the
    //    same old prop (playback ticks, unrelated state). The stale prop
    //    must NOT visually revert the input to the pre-commit text.
    rerender(<TextArea label="文本内容" value="旧文本" onChange={onChange} />);

    expect(textarea.value).toBe('新文本');

    // 3. The async commit lands — the field settles on the committed value
    //    and no collaborative notice appears.
    rerender(<TextArea label="文本内容" value="新文本" onChange={onChange} />);

    expect(textarea.value).toBe('新文本');
    expect(screen.queryByRole('status')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('rejects an ambient refocus that arrives without a user gesture after a manual blur', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextArea label="文本内容" value="旧文本" onChange={onChange} />,
    );
    const textarea = container.querySelector('textarea')!;

    // 1. User edits and blurs (real click sequence: mousedown precedes focus).
    fireEvent.mouseDown(textarea);
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '新文本' } });
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenLastCalledWith('新文本');

    // 2. The async commit lands, re-rendering the inspector. Chromium may
    //    native-restore focus to the just-edited field — focusin arrives with
    //    NO mousedown on the field (the last mousedown was the user's earlier
    //    click elsewhere). The hook must reject it and immediately blur the
    //    field again.
    rerender(<TextArea label="文本内容" value="新文本" onChange={onChange} />);
    fireEvent.mouseDown(document.body);
    fireEvent.focus(textarea);

    expect(document.activeElement).not.toBe(textarea);
    expect(onChange).toHaveBeenCalledTimes(1);

    // 3. A real re-click (mousedown precedes focusin) re-enters an editing
    //    session and commits normally.
    fireEvent.mouseDown(textarea);
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '新文本2' } });
    fireEvent.blur(textarea);
    expect(onChange).toHaveBeenLastCalledWith('新文本2');
  });

  it('syncs an unfocused text input to the latest remote value without showing a draft warning', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextInput label="标签" value="远端旧标签" onChange={onChange} />,
    );
    const input = container.querySelector('input')!;

    rerender(<TextInput label="标签" value="远端新标签" onChange={onChange} />);

    expect(input.value).toBe('远端新标签');
    expect(screen.queryByRole('status')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not overwrite a remote update when a focused input has no local edits', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextInput label="标签" value="远端旧标签" onChange={onChange} />,
    );
    const input = container.querySelector('input')!;

    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    rerender(<TextInput label="标签" value="远端新标签" onChange={onChange} />);

    expect(input.value).toBe('远端旧标签');
    expect(screen.getByRole('status').textContent).toContain('远端已更新');

    fireEvent.blur(input);

    expect(input.value).toBe('远端新标签');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lets Escape cancel a focused text input draft back to the latest remote value', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <TextInput label="标签" value="远端旧标签" onChange={onChange} />,
    );
    const input = container.querySelector('input')!;

    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '本地草稿标签' } });
    rerender(<TextInput label="标签" value="远端新标签" onChange={onChange} />);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('远端新标签');
    expect(screen.queryByRole('status')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a focused environment layer draft when the remote layer name changes', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <EnvironmentLayerNameInput
        label="图层"
        value="旧背景"
        options={['旧背景', '新背景']}
        onChange={onChange}
      />,
    );
    const input = container.querySelector('input')!;

    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '本地图层草稿' } });
    rerender(
      <EnvironmentLayerNameInput
        label="图层"
        value="远端图层"
        options={['远端图层', '本地图层草稿']}
        onChange={onChange}
      />,
    );

    expect(input.value).toBe('本地图层草稿');
    expect(screen.getByRole('status').textContent).toContain('远端已更新');

    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith('本地图层草稿');
  });

  it('keeps the environment layer input editable after cancelling a draft with Escape', () => {
    const onChange = vi.fn();
    render(
      <EnvironmentLayerNameInput
        label="图层"
        value="旧背景"
        options={['旧背景', '新背景']}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('combobox', { name: '图层' }) as HTMLInputElement;

    fireEvent.mouseDown(input);
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '临时草稿' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('旧背景');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: '继续编辑' } });
    expect(input.value).toBe('继续编辑');
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith('继续编辑');
  });

  it('imports voice file inputs with the vocal resource kind', async () => {
    const sceneAssets = {
      importAssetPath: vi.fn().mockResolvedValue('vocal/line.wav'),
    };
    const onChange = vi.fn();

    const { container } = renderWithSceneAssets(
      <FileInput
        label="语音文件"
        value=""
        onChange={onChange}
        filters={[{ name: '音频', extensions: ['mp3', 'wav', 'ogg'] }]}
        importKind="vocal"
      />,
      sceneAssets,
    );
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: 'C:\\voices\\line.wav' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(sceneAssets.importAssetPath).toHaveBeenCalledWith('C:\\voices\\line.wav', 'vocal');
      expect(onChange).toHaveBeenCalledWith('vocal/line.wav');
    });
  });

  it('opens voice file browser in the vocal resource directory', async () => {
    const sceneAssets = {
      importAssetPath: vi.fn(),
    };
    (window as any).aeonStageryAPI = { fs: { readDir: vi.fn() } };

    renderWithSceneAssets(
      <FileInput
        label="语音文件"
        value=""
        onChange={vi.fn()}
        filters={[{ name: '音频', extensions: ['mp3', 'wav', 'ogg'] }]}
        importKind="vocal"
      />,
      sceneAssets,
    );

    fireEvent.click(screen.getByTitle('打开资源浏览器'));

    await waitFor(() => {
      expect(resourceLibraryMocks.readMergedDirectory).toHaveBeenCalledWith('vocal');
    });
    expect(screen.getAllByText('vocal').length).toBeGreaterThan(0);
  });
});
