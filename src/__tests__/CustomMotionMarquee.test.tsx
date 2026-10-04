/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import * as motionEvaluator from '../engine/live2d/customMotion';
import { AppProvider } from '../ui/context/AppContext';
import { CustomMotionEditor, type CustomMotionEditorProps } from '../ui/timeline/CustomMotionEditor';
import { buildCurvePresetSegment, CURVE_PRESETS } from '../ui/timeline/curvePresets';

const motion: Extract<CharacterMotionOutput, { kind: 'custom' }> = {
  kind: 'custom', durationSeconds: 3, fadeInSeconds: 0, derivedFrom: { key: 'test', fadeInSeconds: 0, fadeOutSeconds: 0 },
  tracks: ['ParamAngleX', 'ParamAngleY'].map((parameterId) => ({ parameterId, keyframes: [
    { time: 0, value: 0, segment: { type: 'linear' as const } },
    { time: 1, value: 1, segment: { type: 'linear' as const } }, { time: 2, value: 2 },
  ] })),
};
function pointer(target: Element | Window, type: string, x = 0, y = 0, shiftKey = false) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, shiftKey }));
}
function setup(layout: 'panel' | 'timeline' = 'panel', busy = false, onCommit = vi.fn(), extra: Partial<CustomMotionEditorProps> = {}) {
  const view = render(<CustomMotionEditor motion={motion} layout={layout} busy={busy} blockTime={0} pixelsPerSecond={100} playheadTime={0} onCommit={onCommit} {...extra} />);
  const canvases = view.container.querySelectorAll<SVGSVGElement>('.cme__lane-canvas svg');
  canvases.forEach((canvas, index) => vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: index * 28, width: 600, height: 28, right: 600, bottom: (index + 1) * 28, x: 0, y: index * 28, toJSON: () => ({}) }));
  return { ...view, canvases, editor: screen.getByTestId('custom-motion-editor'), onCommit };
}
beforeEach(() => { vi.stubGlobal('PointerEvent', MouseEvent); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('custom motion marquee interactions', () => {
  it.each(['panel', 'timeline'] as const)('allows dragging an inactive row value and selects it immediately in %s layout', (layout) => {
    const { editor, onCommit } = setup(layout, false, vi.fn(), { playheadTime: 1 });
    const rows = editor.querySelectorAll('.cme__lane');
    const control = rows[1].querySelector('[role="spinbutton"]')!;
    expect(control).not.toBeNull();
    expect(rows[1].classList.contains('is-active')).toBe(false);
    fireEvent.mouseDown(control, { clientX: 100 });
    expect(rows[1].classList.contains('is-active')).toBe(true);
    expect((screen.getByRole('combobox', { name: '当前参数' }) as HTMLSelectElement).value).toBe('ParamAngleY');
    fireEvent.mouseMove(document, { clientX: 110 });
    fireEvent.mouseMove(document, { clientX: 120 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([{ type: 'update-keyframe', trackParameterId: 'ParamAngleY', time: 1, value: 2 }]);
  });

  it('selects an inactive row for keyboard adjustment and inserts at the exact playhead time', () => {
    const { editor, onCommit } = setup('panel', false, vi.fn(), { playheadTime: 0.256 });
    const row = editor.querySelectorAll('.cme__lane')[1];
    const control = row.querySelector<HTMLElement>('[role="spinbutton"]')!;
    act(() => control.focus());
    expect(row.classList.contains('is-active')).toBe(true);
    fireEvent.keyDown(control, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([{ type: 'insert-keyframe', trackParameterId: 'ParamAngleY', time: 0.256, value: 0.31 }]);
  });

  it('accepts typed values on an inactive row through the shared adjuster', () => {
    const { editor, onCommit } = setup('panel', false, vi.fn(), { playheadTime: 1 });
    const row = editor.querySelectorAll('.cme__lane')[1];
    const control = row.querySelector<HTMLElement>('[role="spinbutton"]')!;
    act(() => control.focus());
    fireEvent.keyDown(control, { key: 'Enter' });
    const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(row.classList.contains('is-active')).toBe(true);
    fireEvent.change(input, { target: { value: '7' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit.mock.calls[0][0]).toEqual([{ type: 'update-keyframe', trackParameterId: 'ParamAngleY', time: 1, value: 7 }]);
  });

  it('keeps all row values readonly while editing is blocked', () => {
    const { editor, onCommit } = setup('panel', true);
    for (const row of editor.querySelectorAll('.cme__lane')) {
      expect(row.querySelector('[role="spinbutton"]')).toBeNull();
    }
    fireEvent.mouseDown(editor.querySelectorAll('.cme__lane-value')[1]);
    expect(editor.querySelectorAll('.cme__lane')[1].classList.contains('is-active')).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('uses the shared numeric adjuster for every editable number and keeps its arrow keys local', () => {
    const { canvases, editor, onCommit } = setup();
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    for (const name of ['时间', '值', '动作时长（秒）', '动作淡入（秒）']) {
      expect(screen.getByRole('spinbutton', { name }).classList.contains('scrubbable-badge')).toBe(true);
    }
    expect(editor.querySelector('input[type="number"]')).toBeNull();
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '值' }), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0][0]).toMatchObject({ type: 'update-keyframe', time: 1, value: 1.05 });
    expect(screen.getByRole('spinbutton', { name: '值' })).toBeTruthy();
  });

  it('persists a numeric drag once on release', () => {
    const { canvases, onCommit } = setup();
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: '值' }), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 120 });
    fireEvent.mouseMove(document, { clientX: 140 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0][0]).toMatchObject({ type: 'update-keyframe', trackParameterId: 'ParamAngleX', time: 1 });
    expect(onCommit.mock.calls[0][0][0].value).toBeGreaterThan(1);
  });

  it('blocks readonly numeric adjustments', () => {
    const { canvases, onCommit } = setup('panel', true);
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    for (const name of ['时间', '值', '动作时长（秒）', '动作淡入（秒）']) {
      const control = screen.getByRole('spinbutton', { name });
      expect(control.getAttribute('aria-disabled')).toBe('true');
      fireEvent.keyDown(control, { key: 'ArrowUp' });
    }
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(CURVE_PRESETS)('displays the actual $id easing after loading a motion', ({ id, label }) => {
    const loaded = { ...motion, tracks: [{ ...motion.tracks[0], keyframes: [
      { ...motion.tracks[0].keyframes[0], segment: buildCurvePresetSegment(id, motion.tracks[0].keyframes[0], motion.tracks[0].keyframes[1])! },
      ...motion.tracks[0].keyframes.slice(1),
    ] }] };
    const { canvases } = setup('panel', false, vi.fn(), { motion: loaded });
    pointer(canvases[0].querySelector('[data-kf="0"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    const control = screen.getByRole('combobox', { name: '动画曲线预设' }) as HTMLSelectElement;
    expect(control.value).toBe(id);
    expect(control.selectedOptions[0].textContent).toBe(label);
    expect(control.textContent).not.toContain('选择曲线预设');
  });

  it('updates the displayed easing after applying a preset and after restoring motion', () => {
    const { canvases, rerender, onCommit } = setup();
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    const control = screen.getByRole('combobox', { name: '动画曲线预设' }) as HTMLSelectElement;
    expect(control.value).toBe('linear');
    fireEvent.change(control, { target: { value: 'easeOut' } });
    const segment = onCommit.mock.calls[0][0][0].segment;
    const changed = { ...motion, tracks: [{ ...motion.tracks[0], keyframes: [motion.tracks[0].keyframes[0], { ...motion.tracks[0].keyframes[1], segment }, motion.tracks[0].keyframes[2]] }, motion.tracks[1]] };
    const props = { blockTime: 0, pixelsPerSecond: 100, playheadTime: 0, onCommit };
    rerender(<CustomMotionEditor motion={changed} {...props} />);
    expect((screen.getByRole('combobox', { name: '动画曲线预设' }) as HTMLSelectElement).value).toBe('easeOut');
    rerender(<CustomMotionEditor motion={motion} {...props} />);
    expect((screen.getByRole('combobox', { name: '动画曲线预设' }) as HTMLSelectElement).value).toBe('linear');
  });

  it.each(['custom', 'stepped', 'inverseStepped'] as const)('shows %s interpolation without mislabeling it as a preset', (kind) => {
    const segment = kind === 'custom'
      ? { type: 'bezier' as const, controlPoints: [{ time: 0.2, value: 0.3 }, { time: 0.8, value: 0.6 }] as const }
      : { type: kind };
    const loaded = { ...motion, tracks: [{ ...motion.tracks[0], keyframes: [{ ...motion.tracks[0].keyframes[0], segment }, ...motion.tracks[0].keyframes.slice(1)] }] };
    const { canvases } = setup('panel', false, vi.fn(), { motion: loaded });
    pointer(canvases[0].querySelector('[data-kf="0"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    expect((screen.getByRole('combobox', { name: '动画曲线预设' }) as HTMLSelectElement).value).toBe(kind);
  });

  it.each(['panel', 'timeline'] as const)('selects across tracks and deletes once in %s layout', (layout) => {
    const { canvases, editor, onCommit } = setup(layout);
    pointer(canvases[0], 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 50);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
    expect(screen.getByRole('status', { name: '关键帧选择摘要' }).textContent).toContain('2 个参数');
    fireEvent.keyDown(editor, { key: 'Delete' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toHaveLength(4);
  });
  it('toggles selection with Shift and protects F0 during mixed deletion', () => {
    const { canvases, editor, onCommit } = setup();
    pointer(canvases[0].querySelector('[data-kf="0"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    pointer(canvases[1].querySelector('[data-kf="1"]')!, 'pointerdown', 0, 0, true);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(2);
    fireEvent.keyDown(editor, { key: 'Delete' });
    expect(onCommit.mock.calls[0][0]).toEqual([{ type: 'remove-keyframe', trackParameterId: 'ParamAngleY', time: 1 }]);
  });
  it('allows marquee selection when readonly but blocks deletion and movement', () => {
    const { canvases, editor, onCommit } = setup('panel', true);
    pointer(canvases[0], 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 50);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
    fireEvent.keyDown(editor, { key: 'Delete' });
    expect(onCommit).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '删除选中' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('cancels a marquee without writing and clears selection on view changes', () => {
    const { canvases, editor, onCommit } = setup();
    pointer(canvases[0], 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 50);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('commits a horizontal group drag once and never changes values in lanes', async () => {
    const { canvases, editor, onCommit } = setup();
    pointer(canvases[0], 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 50);
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown', 100, 14);
    pointer(window, 'pointermove', 150, 24);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => pointer(window, 'pointerup', 150, 24));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0][0]).toMatchObject({ type: 'move-keyframes', deltaTime: 0.5, deltaValue: 0 });
    expect(editor.querySelector('[data-testid="cme-marquee"]')).toBeNull();
  });
  it('appends a reverse marquee with Shift and keeps points outside the rectangle', () => {
    const { canvases, editor } = setup();
    pointer(canvases[0].querySelector('[data-kf="0"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    pointer(canvases[1], 'pointerdown', 210, 50, true);
    pointer(window, 'pointerup', 90, 30, true);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(3);
  });
  it('uses current canvas geometry after scrolling during selection', () => {
    const { canvases, editor } = setup();
    let left = 0;
    vi.spyOn(canvases[0], 'getBoundingClientRect').mockImplementation(() => ({ left, top: 0, width: 600, height: 28, right: left + 600, bottom: 28, x: left, y: 0, toJSON: () => ({}) }));
    pointer(canvases[0], 'pointerdown', 90, 5);
    left = -100;
    pointer(window, 'pointerup', 110, 50);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
  });
  it('selects and moves a group in the curve view using a single shared value delta', async () => {
    const { editor, onCommit } = setup();
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    const canvas = editor.querySelector<SVGSVGElement>('.cme__curve-canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 156, right: 600, bottom: 156, x: 0, y: 0, toJSON: () => ({}) });
    pointer(canvas, 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 150);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(2);
    pointer(canvas.querySelector('[data-kf="1"]')!, 'pointerdown', 100, 77);
    await act(async () => pointer(window, 'pointerup', 150, 67));
    const edit = onCommit.mock.calls[0][0][0];
    expect(edit.deltaTime).toBe(0.5);
    expect(edit.deltaValue).toBeCloseTo(10 / 122 * 2.72);
    expect(edit.keyframes).toHaveLength(2);
  });
  it('limits curve group movement by the first point to reach the model bounds', async () => {
    const { editor, onCommit } = setup('panel', false, vi.fn(), { parameterMetadata: [{ id: 'ParamAngleX', min: 0, max: 3, source: 'runtime' }] });
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    const canvas = editor.querySelector<SVGSVGElement>('.cme__curve-canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 156, right: 600, bottom: 156, x: 0, y: 0, toJSON: () => ({}) });
    pointer(canvas, 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 150);
    pointer(canvas.querySelector('[data-kf="1"]')!, 'pointerdown', 100, 77);
    await act(async () => pointer(window, 'pointerup', 100, -77));
    expect(onCommit.mock.calls[0][0][0].deltaValue).toBe(1);
  });
  it('preserves out-of-range source values during horizontal graph movement', async () => {
    const { editor, onCommit } = setup('panel', false, vi.fn(), { parameterMetadata: [{ id: 'ParamAngleX', min: 0, max: 1, source: 'runtime' }] });
    fireEvent.click(screen.getByRole('button', { name: '曲线' }));
    const canvas = editor.querySelector<SVGSVGElement>('.cme__curve-canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 156, right: 600, bottom: 156, x: 0, y: 0, toJSON: () => ({}) });
    pointer(canvas.querySelector('[data-kf="2"]')!, 'pointerdown', 200, 77);
    await act(async () => pointer(window, 'pointerup', 250, 77));
    expect(onCommit.mock.calls[0][0][0]).toMatchObject({ deltaTime: 0.5, deltaValue: 0 });
  });
  it('keeps the candidate while an asynchronous commit is pending and rolls back on failure', async () => {
    let reject!: (reason: Error) => void;
    const onCommit = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const { canvases, editor } = setup('panel', false, onCommit);
    pointer(canvases[0], 'pointerdown', 90, 5);
    pointer(window, 'pointerup', 210, 50);
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown', 100, 14);
    pointer(window, 'pointerup', 150, 14);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(canvases[0].querySelector('[data-kf="1"] path')?.getAttribute('d')).toContain('150');
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
    fireEvent.keyDown(editor, { key: 'Delete' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('lease lost')); });
    expect(canvases[0].querySelector('[data-kf="1"] path')?.getAttribute('d')).toContain('100');
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
  });
  it('coalesces pointer moves and scrolls at an edge until release', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => { callbacks.delete(frame); });
    const scroller = document.createElement('div');
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 220, height: 100, right: 220, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const { canvases, editor, onCommit } = setup('panel', false, vi.fn(), { scrollContainer: scroller });
    vi.spyOn(canvases[0], 'getBoundingClientRect').mockImplementation(() => ({ left: -scroller.scrollLeft, top: 0, width: 600, height: 28, right: 600 - scroller.scrollLeft, bottom: 28, x: -scroller.scrollLeft, y: 0, toJSON: () => ({}) }));
    const flush = (time: number) => act(() => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((callback) => callback(time)); });
    pointer(canvases[0], 'pointerdown', 90, 5);
    for (let index = 0; index < 100; index++) pointer(window, 'pointermove', 210, 50);
    expect(callbacks.size).toBe(1);
    flush(16);
    expect(editor.querySelectorAll('[data-selected="true"]')).toHaveLength(4);
    flush(32);
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    pointer(window, 'pointerup', 210, 50);
    expect(callbacks.size).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('renders only viewport markers for a 20,000-keyframe motion', () => {
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'clientWidth', { value: 220 });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 220, height: 100, right: 220, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const denseMotion = { ...motion, durationSeconds: 200, tracks: Array.from({ length: 100 }, (_, index) => ({ parameterId: String(index), keyframes: Array.from({ length: 200 }, (_, time) => ({ time, value: time, ...(time < 199 ? { segment: { type: 'linear' as const } } : {}) })) })) };
    const { editor } = setup('panel', false, vi.fn(), { motion: denseMotion, scrollContainer: scroller });
    expect(editor.querySelectorAll('.cme__lane')).toHaveLength(100);
    expect(editor.querySelectorAll('[data-kf]').length).toBeLessThan(500);
  });
  it('does not reevaluate unchanged keyframe rows on playback ticks', () => {
    const listeners = new Set<(time: number) => void>();
    const adapters = { playback: { getCurrentTime: () => 0, subscribeTime: (callback: (time: number) => void) => { listeners.add(callback); return () => listeners.delete(callback); } } };
    const evaluate = vi.spyOn(motionEvaluator, 'evaluateCustomMotionTrack');
    render(<AppProvider adapters={adapters as any} stores={{} as any}><CustomMotionEditor motion={motion} blockTime={0} pixelsPerSecond={100} playheadTime={0} onCommit={vi.fn()} /></AppProvider>);
    evaluate.mockClear();
    act(() => { for (const listener of listeners) listener(0.5); });
    // Only the numeric control should sample the tick; the row's static markers
    // must not rerender and evaluate the track a second time.
    expect(evaluate.mock.calls.filter(([track]) => track.parameterId === 'ParamAngleY')).toHaveLength(1);
  });

  it('drops a pending gesture when fps changes without changing persisted seconds', () => {
    const onCommit = vi.fn();
    const { canvases, editor, rerender } = setup('panel', false, onCommit);
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown', 100, 14);
    pointer(window, 'pointermove', 130, 14);
    rerender(<CustomMotionEditor motion={motion} fps={30} blockTime={0} pixelsPerSecond={100} playheadTime={0} onCommit={onCommit} />);
    pointer(window, 'pointerup', 130, 14);
    expect(onCommit).not.toHaveBeenCalled();
    expect(editor.querySelector('[data-kf="1"] path')?.getAttribute('d')).toContain('100');
    expect(motion.tracks[0].keyframes[1].time).toBe(1);
  });
  it('ignores destructive shortcuts while a numeric input has focus', () => {
    const { canvases, onCommit } = setup();
    pointer(canvases[0].querySelector('[data-kf="1"]')!, 'pointerdown');
    pointer(window, 'pointerup');
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '值' }), { key: 'Enter' });
    const input = screen.getByRole('spinbutton', { name: '值' });
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(onCommit).not.toHaveBeenCalled();
  });

});
