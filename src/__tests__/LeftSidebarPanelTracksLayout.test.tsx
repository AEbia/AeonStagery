/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LeftSidebarPanel } from '../ui/timeline/LeftSidebarPanel';

const semanticDocumentState = vi.hoisted(() => ({
  document: {
    schemaVersion: 4 as const,
    sceneId: 'scene_test',
    meta: {
      title: 'Tracks Test Scene',
      characters: [
        { id: 'char_1', name: 'Alice' },
        { id: 'char_2', name: 'Bob' },
      ],
    },
    statements: [
      {
        id: 'stmt_1',
        time: 1.5,
        type: 'dialogue' as const,
        params: { characterId: 'char_1', text: 'Hello from tracks mode' },
      },
    ],
  },
}));

const mockTimelineAdapter = vi.hoisted(() => ({
  select: vi.fn(),
  selectSingle: vi.fn(),
  toggleSelection: vi.fn(),
  clearSelection: vi.fn(),
  getSelectedIds: vi.fn(() => ({})),
}));

const mockEditorState = vi.hoisted(() => ({
  selectedActionIds: {} as Record<string, boolean>,
  setSelectedIds: vi.fn(),
  loadExample: vi.fn(async () => true),
}));

vi.mock('../ui/timeline/TimelineListView', () => ({
  TimelineListView: (props: any) => (
    <div data-testid="mock-timeline-list-view">
      <span>TimelineListView Mounted</span>
      <button
        data-testid="select-stmt-btn"
        onClick={() => props.handleSelect('stmt_1', false)}
      >
        Select Stmt 1
      </button>
      <button
        data-testid="multi-select-stmt-btn"
        onClick={() => props.handleSelect('stmt_1', true)}
      >
        Multi Select Stmt 1
      </button>
      <button
        data-testid="select-multiple-btn"
        onClick={() => props.handleSelect(['stmt_1', 'stmt_2'], false)}
      >
        Select Multiple
      </button>
      <button
        data-testid="switch-to-chars-btn"
        onClick={() => props.onSelectWorkspaceView?.('characters')}
      >
        Switch to Chars
      </button>
    </div>
  ),
}));

vi.mock('../ui/timeline/CharacterDirectoryPanel', () => ({
  CharacterDirectoryPanel: ({ sceneMeta }: { sceneMeta: any }) => (
    <div data-testid="mock-character-directory-panel">
      <span>Character Directory Panel: {sceneMeta?.characters?.length ?? 0} characters</span>
    </div>
  ),
}));

vi.mock('../ui/context/AppContext', () => ({
  useApp: () => ({
    adapters: {
      timeline: mockTimelineAdapter,
    },
    stores: {
      editor: {
        setCopyBuffer: vi.fn(),
      },
    },
  }),
  usePlaybackAdapter: () => ({
    getCurrentTime: () => 0,
    seek: vi.fn(),
  }),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => semanticDocumentState.document,
    getCompiledSceneSnapshot: () => null,
  }),
  useSemanticAuthoringService: () => ({
    author: vi.fn(async () => ({ createdStatementIds: ['stmt_new'] })),
  }),
  useTimelineAdapter: () => mockTimelineAdapter,
  useTemplatePackageCatalog: () => undefined,
  useCollaborationStatus: () => 'connected',
  usePlaybackStore: () => ({}),
  useCharacterAdapter: () => ({
    getCoreModel: () => null,
    getModel: () => null,
  }),
}));

vi.mock('../ui/store/storeHooks', () => ({
  useSemanticDocument: () => ({ document: semanticDocumentState.document, filePath: null }),
  useEditorState: () => mockEditorState,
  useValidationIssues: () => ({ issues: [] }),
}));

describe('LeftSidebarPanel in Tracks Mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEditorState.selectedActionIds = {};
  });

  it('renders dual tabs: "剧本时间轴" and "角色管理" with accessible markup', () => {
    render(<LeftSidebarPanel width={340} />);

    const panel = screen.getByTestId('left-sidebar-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.width).toBe('340px');

    const tabList = screen.getByRole('tablist');
    expect(tabList).toBeTruthy();

    const timelineTab = screen.getByRole('tab', { name: '剧本时间轴' });
    const charactersTab = screen.getByRole('tab', { name: '角色管理' });
    expect(timelineTab).toBeTruthy();
    expect(charactersTab).toBeTruthy();

    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(charactersTab.getAttribute('aria-selected')).toBe('false');

    const timelinePanel = screen.getByRole('tabpanel', { name: '剧本时间轴' });
    const charactersPanel = document.getElementById('left-panel-tabpanel-characters')!;
    expect(timelinePanel).toBeTruthy();
    expect(charactersPanel).toBeTruthy();
    expect(charactersPanel.getAttribute('role')).toBe('tabpanel');

    expect(timelinePanel.hidden).toBe(false);
    expect(charactersPanel.hidden).toBe(true);

    // Both views are mounted in DOM for clean state preservation
    expect(screen.getByTestId('mock-timeline-list-view')).toBeTruthy();
    expect(screen.getByTestId('mock-character-directory-panel')).toBeTruthy();
  });

  it('switches tabs cleanly preserving active state of both views', () => {
    render(<LeftSidebarPanel />);

    const timelineTab = screen.getByRole('tab', { name: '剧本时间轴' });
    const charactersTab = screen.getByRole('tab', { name: '角色管理' });
    const timelinePanel = document.getElementById('left-panel-tabpanel-timeline')!;
    const charactersPanel = document.getElementById('left-panel-tabpanel-characters')!;

    // Initial state: timeline tab active
    expect(timelinePanel.hidden).toBe(false);
    expect(charactersPanel.hidden).toBe(true);

    // Click characters tab
    fireEvent.click(charactersTab);

    expect(timelineTab.getAttribute('aria-selected')).toBe('false');
    expect(charactersTab.getAttribute('aria-selected')).toBe('true');
    expect(timelinePanel.hidden).toBe(true);
    expect(charactersPanel.hidden).toBe(false);

    // Both components remain mounted in DOM
    expect(screen.getByTestId('mock-timeline-list-view')).toBeTruthy();
    expect(screen.getByTestId('mock-character-directory-panel')).toBeTruthy();

    // Switch back to timeline tab
    fireEvent.click(timelineTab);

    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(charactersTab.getAttribute('aria-selected')).toBe('false');
    expect(timelinePanel.hidden).toBe(false);
    expect(charactersPanel.hidden).toBe(true);
  });

  it('supports keyboard navigation between tabs using arrow keys', () => {
    render(<LeftSidebarPanel />);

    const timelineTab = screen.getByRole('tab', { name: '剧本时间轴' });
    const charactersTab = screen.getByRole('tab', { name: '角色管理' });

    expect(timelineTab.getAttribute('aria-selected')).toBe('true');

    // Press ArrowRight to switch to characters
    fireEvent.keyDown(timelineTab, { key: 'ArrowRight' });
    expect(charactersTab.getAttribute('aria-selected')).toBe('true');

    // Press ArrowLeft to switch back to timeline
    fireEvent.keyDown(charactersTab, { key: 'ArrowLeft' });
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
  });

  it('switches to characters tab when TimelineListView triggers onSelectWorkspaceView("characters")', () => {
    render(<LeftSidebarPanel />);

    const charactersTab = screen.getByRole('tab', { name: '角色管理' });
    expect(charactersTab.getAttribute('aria-selected')).toBe('false');

    const switchBtn = screen.getByTestId('switch-to-chars-btn');
    fireEvent.click(switchBtn);

    expect(charactersTab.getAttribute('aria-selected')).toBe('true');
    const charactersPanel = screen.getByRole('tabpanel', { name: '角色管理' });
    expect(charactersPanel.hidden).toBe(false);
  });

  it('properly triggers timelineAdapter.select and setSelectedIds when selecting an action', () => {
    render(<LeftSidebarPanel />);

    const selectBtn = screen.getByTestId('select-stmt-btn');
    fireEvent.click(selectBtn);

    expect(mockEditorState.setSelectedIds).toHaveBeenCalledWith({ stmt_1: true });
    expect(mockTimelineAdapter.select).toHaveBeenCalledWith({ stmt_1: true });
  });

  it('properly triggers timelineAdapter.select and setSelectedIds for multi-selection', () => {
    mockEditorState.selectedActionIds = { stmt_existing: true };
    render(<LeftSidebarPanel />);

    const multiSelectBtn = screen.getByTestId('multi-select-stmt-btn');
    fireEvent.click(multiSelectBtn);

    expect(mockEditorState.setSelectedIds).toHaveBeenCalledWith({
      stmt_existing: true,
      stmt_1: true,
    });
    expect(mockTimelineAdapter.select).toHaveBeenCalledWith({
      stmt_existing: true,
      stmt_1: true,
    });
  });

  it('properly triggers timelineAdapter.select and setSelectedIds when selecting an array of ids', () => {
    render(<LeftSidebarPanel />);

    const selectMultipleBtn = screen.getByTestId('select-multiple-btn');
    fireEvent.click(selectMultipleBtn);

    expect(mockEditorState.setSelectedIds).toHaveBeenCalledWith({
      stmt_1: true,
      stmt_2: true,
    });
    expect(mockTimelineAdapter.select).toHaveBeenCalledWith({
      stmt_1: true,
      stmt_2: true,
    });
  });

  it('supports controlled activeTab and onTabChange callback', () => {
    const handleTabChange = vi.fn();
    const { rerender } = render(
      <LeftSidebarPanel activeTab="timeline" onTabChange={handleTabChange} />
    );

    const timelineTab = screen.getByRole('tab', { name: '剧本时间轴' });
    const charactersTab = screen.getByRole('tab', { name: '角色管理' });
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(charactersTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(charactersTab);
    expect(handleTabChange).toHaveBeenCalledWith('characters');

    // Rerender with controlled tab updated
    rerender(<LeftSidebarPanel activeTab="characters" onTabChange={handleTabChange} />);
    expect(timelineTab.getAttribute('aria-selected')).toBe('false');
    expect(charactersTab.getAttribute('aria-selected')).toBe('true');
  });

  it('renders with defaultTab="characters" when specified', () => {
    render(<LeftSidebarPanel defaultTab="characters" />);

    const charactersTab = screen.getByRole('tab', { name: '角色管理' });
    expect(charactersTab.getAttribute('aria-selected')).toBe('true');

    const timelinePanel = document.getElementById('left-panel-tabpanel-timeline')!;
    const charactersPanel = document.getElementById('left-panel-tabpanel-characters')!;
    expect(timelinePanel.hidden).toBe(true);
    expect(charactersPanel.hidden).toBe(false);
  });

  it('renders tab icons and badge counts for timeline statements and characters', () => {
    const { container } = render(<LeftSidebarPanel />);

    const icons = container.querySelectorAll('.left-panel__tab-icon');
    expect(icons.length).toBe(2);

    const badges = container.querySelectorAll('.left-panel__tab-badge');
    expect(badges.length).toBe(2);
    expect(badges[0].textContent?.trim()).toBe('1'); // 1 statement
    expect(badges[1].textContent?.trim()).toBe('2'); // 2 characters
  });

  it('renders styled empty state when semantic document is unavailable', () => {
    const originalDoc = semanticDocumentState.document;
    semanticDocumentState.document = null as any;

    try {
      render(<LeftSidebarPanel defaultTab="characters" />);
      const emptyState = screen.getByTestId('left-panel-empty-state-characters');
      expect(emptyState).toBeTruthy();
      expect(emptyState.textContent).toContain('等待场景加载...');
    } finally {
      semanticDocumentState.document = originalDoc;
    }
  });
});

