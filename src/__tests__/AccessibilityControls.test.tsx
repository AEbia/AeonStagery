/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '../ui/SearchableSelect';
import { FormSelect } from '../ui/FormSelect';
import { PlaybackControls } from '../ui/PlaybackControls';
import { AssetBrowserModal } from '../ui/AssetBrowserModal';
import { useKeyboardShortcuts } from '../ui/hooks/useKeyboardShortcuts';
import { useModalDialog } from '../ui/hooks/useModalDialog';
import { BlockContextMenu } from '../ui/timeline/BlockContextMenu';
import { MarkerPrompt } from '../ui/timeline/MarkerPrompt';

const testState = vi.hoisted(() => ({
  isPlaying: false,
  playbackAdapter: {
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 10),
    subscribeTime: vi.fn((_listener: (time: number) => void) => () => undefined),
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    setLoopEnabled: vi.fn(),
    setLoop: vi.fn(),
    setSpeed: vi.fn(),
  },
  stageAdapter: {
    getPreviewResolution: vi.fn(() => 1 as const),
    setPreviewResolution: vi.fn(),
  },
  readMergedDirectory: vi.fn(async () => []),
}));

vi.mock('../ui/context/AppContext', () => ({
  usePlaybackAdapter: () => testState.playbackAdapter,
  useStageAdapter: () => testState.stageAdapter,
  useSceneAssetService: () => undefined,
  useResourceAuthoringService: () => undefined,
}));

vi.mock('../ui/store/storeHooks', () => ({
  useEditorDuration: () => 10,
  useEditorStatus: () => ({ isPlaying: testState.isPlaying }),
}));

vi.mock('../ui/ResourceLibrary', () => ({
  readMergedDirectory: testState.readMergedDirectory,
}));

function KeyboardShortcutHarness({ initialized = true, onPlayPause, onUndo }: { initialized?: boolean; onPlayPause: () => void; onUndo: () => void }) {
  useKeyboardShortcuts({
    initialized,
    onPlayPause,
    onStageReset: vi.fn(),
    onFrameStep: vi.fn(),
    onUndo,
  });
  return (
    <>
      <button type="button">交互按钮</button>
      <div className="timeline-editor-root">
        <button type="button">时间线语句块</button>
      </div>
      <input aria-label="文本输入" />
    </>
  );
}

function ModalFocusHarness({ name, onClose }: { name: string; onClose: () => void }) {
  const dialogRef = useModalDialog(onClose);
  return (
    <div ref={dialogRef} role="dialog" aria-label={name} tabIndex={-1}>
      <button type="button" tabIndex={-1}>非活动标签</button>
      <button type="button">活动控件</button>
    </div>
  );
}

describe('accessible custom controls', () => {
  beforeEach(() => {
    testState.playbackAdapter.getCurrentTime.mockReturnValue(0);
    testState.playbackAdapter.seek.mockClear();
    testState.playbackAdapter.subscribeTime.mockClear();
    testState.stageAdapter.getPreviewResolution.mockClear();
    testState.stageAdapter.setPreviewResolution.mockClear();
    testState.readMergedDirectory.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares one outside-pointer listener and selects combobox options from the keyboard', () => {
    const addEventListener = vi.spyOn(document, 'addEventListener');
    const onChange = vi.fn();

    render(
      <>
        <SearchableSelect label="第一项" value="" options={['one', 'two']} onChange={onChange} />
        <SearchableSelect label="第二项" value="" options={['one', 'two']} onChange={vi.fn()} />
      </>,
    );

    const pointerDownCalls = addEventListener.mock.calls.filter(([type]) => type === 'pointerdown');
    expect(pointerDownCalls).toHaveLength(1);
    expect(pointerDownCalls[0]?.[2]).toBe(true);
    const firstCombobox = screen.getByRole('combobox', { name: '第一项' });
    expect(firstCombobox.getAttribute('aria-expanded')).toBe('false');

    const closedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    firstCombobox.dispatchEvent(closedEscape);
    expect(closedEscape.defaultPrevented).toBe(false);

    fireEvent.click(firstCombobox);
    expect(firstCombobox.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(firstCombobox.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(firstCombobox);
    const searchbox = screen.getByRole('searchbox', { name: '搜索选项' });
    fireEvent.keyDown(searchbox, { key: 'Enter', isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(searchbox, { key: 'ArrowDown' });
    fireEvent.keyDown(searchbox, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('two');
    expect(firstCombobox.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(firstCombobox);
  });

  it('keeps portal options keyboard-accessible and skips disabled values', () => {
    const onChange = vi.fn();
    render(
      <>
        <label htmlFor="track-select">轨道</label>
        <FormSelect
          id="track-select"
          value=""
          aria-label="轨道"
          options={[
            { value: '', label: '改轨道', disabled: true },
            { value: 'dialogue', label: '对白' },
            { value: 'camera', label: '镜头', disabled: true },
            { value: 'audio', label: '音频' },
          ]}
          onChange={onChange}
        />
        <button type="button">下一项</button>
      </>,
    );

    const combobox = screen.getByRole('combobox', { name: '轨道' });
    combobox.focus();
    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    expect(combobox.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('listbox', { name: '轨道选项' })).toBeTruthy();
    expect(combobox.getAttribute('aria-activedescendant')).toContain('option-1');

    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    expect(combobox.getAttribute('aria-activedescendant')).toContain('option-3');
    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('audio');
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(combobox);

    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(combobox, { key: '音' });
    expect(combobox.getAttribute('aria-expanded')).toBe('true');
    expect(combobox.getAttribute('aria-activedescendant')).toContain('option-3');
    fireEvent.keyDown(combobox, { key: 'Tab' });
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not treat a portal option as an outside click', () => {
    const onChange = vi.fn();
    render(
      <FormSelect
        aria-label="导出格式"
        value="mp4"
        options={[
          { value: 'mp4', label: 'MP4' },
          { value: 'webm', label: 'WebM' },
        ]}
        onChange={onChange}
      />,
    );

    const combobox = screen.getByRole('combobox', { name: '导出格式' });
    fireEvent.click(combobox);
    const webm = screen.getByRole('option', { name: 'WebM' });
    fireEvent.pointerDown(webm);
    fireEvent.click(webm);

    expect(onChange).toHaveBeenCalledWith('webm');
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
  });

  it('seeks the playback slider with arrow and boundary keys', () => {
    render(<PlaybackControls />);
    const slider = screen.getByRole('slider', { name: '播放进度' });

    expect(testState.playbackAdapter.subscribeTime).toHaveBeenCalledTimes(1);
    expect(slider.getAttribute('aria-valuemin')).toBe('0');
    expect(slider.getAttribute('aria-valuemax')).toBe('10');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'End' });

    expect(testState.playbackAdapter.seek).toHaveBeenNthCalledWith(1, 1 / 60);
    expect(testState.playbackAdapter.seek).toHaveBeenNthCalledWith(2, 10);
  });

  it('keeps the progress fill inside the slider when the CTI moves past the scene duration', () => {
    render(<PlaybackControls />);
    const slider = screen.getByRole('slider', { name: '播放进度' });
    const fill = slider.querySelector('.playback-controls__progress-fill') as HTMLElement;
    const onTime = testState.playbackAdapter.subscribeTime.mock.calls[0][0];

    onTime(15);

    expect(fill.style.width).toBe('100%');
    expect(slider.getAttribute('aria-valuenow')).toBe('10');
    expect(screen.getByText('00:15.00')).toBeTruthy();
  });

  it('starts with a bounded progress fill when the CTI is already past the scene duration', () => {
    testState.playbackAdapter.getCurrentTime.mockReturnValue(15);
    render(<PlaybackControls />);

    const slider = screen.getByRole('slider', { name: '播放进度' });
    const fill = slider.querySelector('.playback-controls__progress-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(slider.getAttribute('aria-valuenow')).toBe('10');
  });

  it('keeps preview resolution controls below the stage and delegates quality changes', () => {
    render(<PlaybackControls />);

    expect(screen.getByRole('group', { name: '预览分辨率' })).toBeTruthy();
    const halfResolution = screen.getByRole('button', { name: '预览分辨率 1/2' });
    fireEvent.click(halfResolution);

    expect(testState.stageAdapter.setPreviewResolution).toHaveBeenCalledWith(0.5);
    expect(halfResolution.getAttribute('aria-pressed')).toBe('true');
  });

  it('provides accessible speed controls and delegates speed changes', () => {
    render(<PlaybackControls />);

    expect(screen.getByRole('group', { name: '播放速度' })).toBeTruthy();
    const halfSpeed = screen.getByRole('button', { name: '0.5 倍播放速度' });
    fireEvent.click(halfSpeed);

    expect(testState.playbackAdapter.setSpeed).toHaveBeenCalledWith(0.5);
    expect(halfSpeed.getAttribute('aria-pressed')).toBe('true');
  });

  it('isolates global shortcuts from IME and interactive controls', () => {
    const onPlayPause = vi.fn();
    const onUndo = vi.fn();
    render(<KeyboardShortcutHarness onPlayPause={onPlayPause} onUndo={onUndo} />);

    fireEvent.keyDown(screen.getByRole('button', { name: '交互按钮' }), { key: ' ', code: 'Space' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '文本输入' }), { key: 'z', code: 'KeyZ', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space', isComposing: true });
    expect(onPlayPause).not.toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(onPlayPause).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('button', { name: '时间线语句块' }), { key: ' ', code: 'Space' });
    expect(onPlayPause).toHaveBeenCalledTimes(2);
  });

  it('does not register global shortcuts before initialization', () => {
    const onPlayPause = vi.fn();
    render(<KeyboardShortcutHarness initialized={false} onPlayPause={onPlayPause} onUndo={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });

    expect(onPlayPause).not.toHaveBeenCalled();
  });

  it('exposes the asset browser as a modal and closes it with Escape', async () => {
    const onClose = vi.fn();
    render(<AssetBrowserModal value="" onSelect={vi.fn()} onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: '资源浏览器' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the asset browser from an outside pointer down', async () => {
    const onClose = vi.fn();
    render(<AssetBrowserModal value="" onSelect={vi.fn()} onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: '资源浏览器' });
    fireEvent.pointerDown(dialog.parentElement!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('skips negative-tabindex controls when choosing initial modal focus', async () => {
    render(<ModalFocusHarness name="焦点测试" onClose={vi.fn()} />);

    const activeControl = screen.getByRole('button', { name: '活动控件' });
    await waitFor(() => expect(document.activeElement).toBe(activeControl));
  });

  it('traps modal focus, restores the opener, and deduplicates stacked dialog listeners', async () => {
    const addEventListener = vi.spyOn(document, 'addEventListener');
    const openerView = render(<button type="button">打开资源浏览器</button>);
    const opener = screen.getByRole('button', { name: '打开资源浏览器' });
    opener.focus();

    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const modalView = render(
      <>
        <AssetBrowserModal key="first" value="" onSelect={vi.fn()} onClose={firstClose} />
        <AssetBrowserModal key="second" value="" onSelect={vi.fn()} onClose={secondClose} />
      </>,
    );

    const dialogs = await screen.findAllByRole('dialog', { name: '资源浏览器' });
    const topDialog = dialogs[1];
    await waitFor(() => expect(topDialog.contains(document.activeElement)).toBe(true));
    expect(addEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

    const focusable = topDialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(firstClose).not.toHaveBeenCalled();

    modalView.rerender(<><AssetBrowserModal key="first" value="" onSelect={vi.fn()} onClose={firstClose} /></>);
    await waitFor(() => expect(screen.getByRole('dialog', { name: '资源浏览器' }).contains(document.activeElement)).toBe(true));
    modalView.unmount();
    expect(document.activeElement).toBe(opener);

    opener.focus();
    const simultaneousView = render(
      <>
        <AssetBrowserModal key="first" value="" onSelect={vi.fn()} onClose={firstClose} />
        <AssetBrowserModal key="second" value="" onSelect={vi.fn()} onClose={secondClose} />
      </>,
    );
    const simultaneousDialogs = await screen.findAllByRole('dialog', { name: '资源浏览器' });
    await waitFor(() => expect(simultaneousDialogs[1].contains(document.activeElement)).toBe(true));
    simultaneousView.unmount();
    expect(document.activeElement).toBe(opener);
    openerView.unmount();
  });

  it('focuses the marker input and restores the marker trigger when the dialog closes', async () => {
    const openerView = render(<button type="button">添加标记</button>);
    const opener = screen.getByRole('button', { name: '添加标记' });
    opener.focus();

    const promptView = render(
      <MarkerPrompt prompt={{ time: 2 }} onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    const markerInput = screen.getByRole('textbox', { name: '输入标记名称:' });
    await waitFor(() => expect(document.activeElement).toBe(markerInput));

    promptView.rerender(
      <MarkerPrompt prompt={null} onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(document.activeElement).toBe(opener);
    openerView.unmount();
  });

  it('moves focus through the block menu and dismisses it with Escape', async () => {
    const openerView = render(<button type="button">区块操作入口</button>);
    const opener = screen.getByRole('button', { name: '区块操作入口' });
    opener.focus();
    const onDismiss = vi.fn();
    const menuView = render(
      <BlockContextMenu
        menu={{ x: 10, y: 10, targetId: 'action-1' }}
        onAction={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    const menu = screen.getByRole('menu', { name: '区块操作' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '复制' })));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '粘贴' }));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '删除' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    menuView.rerender(
      <BlockContextMenu menu={null} onAction={vi.fn()} onDismiss={onDismiss} />,
    );
    expect(document.activeElement).toBe(opener);
    openerView.unmount();
  });
});
