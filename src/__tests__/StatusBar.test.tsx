/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { StatusBar } from '../ui/StatusBar';

function makeStores() {
  const subscribe = () => () => {};
  return {
    document: {
      filePath: '',
      subscribe,
      getCurrentSceneDocumentSnapshot: () => ({
        schemaVersion: 4,
        sceneId: 'status-bar-test',
        meta: { title: '协作测试剧本' },
        statements: [],
      }),
    } as any,
    playback: { playing: false, duration: 12, engineStatus: 'ready', subscribe } as any,
    editor: {
      selectedActionIds: {},
      selectedActionIdsSnapshot: {},
      selectedCount: 0,
      pixelsPerSecond: 50,
      gizmosVisible: true,
      saveStatus: 'saved',
      subscribe,
    } as any,
    validation: { issues: [], loading: false, errorsCount: 0, warningsCount: 0, subscribe } as any,
  };
}

function renderStatusBar(collaboration?: any) {
  const adapters = {
    document: {} as any,
    playback: {
      getCurrentTime: () => 0,
      subscribeTime: () => () => {},
    } as any,
    camera: {} as any,
    character: {} as any,
    stage: {} as any,
    timeline: {} as any,
    export: {} as any,
  };
  const stores = makeStores();
  const services = { sceneFile: {} as any };

  return render(
    <AppProvider adapters={adapters} stores={stores} services={services} collaboration={collaboration}>
      <StatusBar />
    </AppProvider>,
  );
}

describe('StatusBar collaboration readout', () => {
  it('hides collaboration readout when disconnected', () => {
    renderStatusBar({ status: 'disconnected' });
    expect(screen.queryByText(/^协作 ·/)).toBeNull();
  });

  it('shows model-derived trusted footer label and tooltip including member names', () => {
    renderStatusBar({
      status: 'connected',
      self: { clientId: 'self-1', displayName: '导演' },
      peers: [
        { clientId: 'peer-1', displayName: '副导演', selectedStatementIds: [], editingTarget: null },
      ],
    });
    const readout = screen.getByText('协作 · 已同步 · 2 人');
    expect(readout).toBeTruthy();
    const title = readout.closest('.status-bar__collaboration')?.getAttribute('title') ?? '';
    expect(title).toContain('实时通道已连接');
    expect(title).toContain('导演（你）、副导演');
  });

  it('shows offline collaboration sessions instead of hiding them', () => {
    renderStatusBar({
      status: 'offline',
      self: { clientId: 'self-1', displayName: '导演' },
      peers: [],
    });
    expect(screen.getByText('协作 · 已断开')).toBeTruthy();
  });
});
