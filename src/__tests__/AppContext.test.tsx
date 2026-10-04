/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import {
  AppProvider,
  useApp,
  usePlaybackAdapter,
  useCameraAdapter,
  useCharacterAdapter,
  useStageAdapter,
  useTimelineAdapter,
  useExportAdapter,
  useDocumentStore,
  usePlaybackStore,
  useEditorStore,
  useProjectOpenWorkflow,
  useFileAccessService,
  useCollaborationStatus,
  useCollaborationPresence,
  useCollaborationPresencePublisher,
  useIsCollaborationUndoDisabled,
  isCollaborationUndoDisabled,
  useTemplatePackageCatalog,
} from '../ui/context/AppContext';

function makeMockAdapters() {
  return {
    playback: { play: () => {}, pause: () => {}, subscribeTime: () => () => {} } as any,
    camera: { focusOn: () => {} } as any,
    character: { add: async () => {} } as any,
    stage: { setBackground: async () => {} } as any,
    timeline: { select: () => {} } as any,
    export: { export: async () => {} } as any,
  };
}

function makeMockStores() {
  return {
    document: { sceneData: null, version: 0 } as any,
    playback: { playing: false, duration: 0 } as any,
    editor: { selectedActionIds: {}, canUndo: false } as any,
    validation: { issues: [], loading: false, errorsCount: 0, warningsCount: 0 } as any,
  };
}

function renderInContext(ui: React.ReactElement, collaboration?: any) {
  const adapters = makeMockAdapters();
  const stores = makeMockStores();
  const services = {
    fileAccess: {
      readFile: async () => ({ data: '', path: '' }),
    } as any,
    sceneFile: {} as any,
    projectOpenWorkflow: {
      createProjectAndLoadDefaultScene: async () => ({}),
      openProjectAndLoadDefaultScene: async () => ({}),
      openRecentProjectAndLoadDefaultScene: async () => ({}),
    } as any,
    templatePackages: {
      getSummaries: () => [{ id: 'aeonstagery.default', name: 'Default', version: '2.0.0', scope: 'builtin' }],
      subscribe: () => () => {},
    } as any,
  };
  const result = render(
    <AppProvider adapters={adapters} stores={stores} services={services} collaboration={collaboration}>
      {ui}
    </AppProvider>,
  );
  return { ...result, adapters, stores, services };
}

describe('AppContext', () => {
  it('useApp() returns { adapters, stores }', () => {
    let captured: any = null;
    function Reader() {
      captured = useApp();
      return null;
    }
    const { adapters, stores } = renderInContext(<Reader />);
    expect(captured).toBeDefined();
    expect(captured.adapters).toBe(adapters);
    expect(captured.stores).toBe(stores);
  });

  it('usePlaybackAdapter returns the playback adapter', () => {
    let captured: any = null;
    function Reader() {
      captured = usePlaybackAdapter();
      return null;
    }
    const { adapters } = renderInContext(<Reader />);
    expect(captured).toBe(adapters.playback);
  });

  it('useCameraAdapter returns the camera adapter', () => {
    let captured: any = null;
    function Reader() {
      captured = useCameraAdapter();
      return null;
    }
    const { adapters } = renderInContext(<Reader />);
    expect(captured).toBe(adapters.camera);
  });

  it('useCharacterAdapter returns the character adapter', () => {
    let captured: any = null;
    function Reader() {
      captured = useCharacterAdapter();
      return null;
    }
    const { adapters } = renderInContext(<Reader />);
    expect(captured).toBe(adapters.character);
  });

  it('useStageAdapter returns the stage adapter', () => {
    let captured: any = null;
    function Reader() {
      captured = useStageAdapter();
      return null;
    }
    const { adapters } = renderInContext(<Reader />);
    expect(captured).toBe(adapters.stage);
  });

  it('useTimelineAdapter returns the timeline adapter', () => {
    let captured: any = null;
    function Reader() {
      captured = useTimelineAdapter();
      return null;
    }
    const { adapters } = renderInContext(<Reader />);
    expect(captured).toBe(adapters.timeline);
  });

  it('useExportAdapter returns the export adapter', () => {
    let captured: any = null;
    function Reader() {
      captured = useExportAdapter();
      return null;
    }
    const { adapters } = renderInContext(<Reader />);
    expect(captured).toBe(adapters.export);
  });

  it('useDocumentStore returns the document store', () => {
    let captured: any = null;
    function Reader() {
      captured = useDocumentStore();
      return null;
    }
    const { stores } = renderInContext(<Reader />);
    expect(captured).toBe(stores.document);
  });

  it('usePlaybackStore returns the playback store', () => {
    let captured: any = null;
    function Reader() {
      captured = usePlaybackStore();
      return null;
    }
    const { stores } = renderInContext(<Reader />);
    expect(captured).toBe(stores.playback);
  });

  it('useEditorStore returns the editor store', () => {
    let captured: any = null;
    function Reader() {
      captured = useEditorStore();
      return null;
    }
    const { stores } = renderInContext(<Reader />);
    expect(captured).toBe(stores.editor);
  });

  it('useTemplatePackageCatalog returns the semantic template package catalog', () => {
    let captured: any = null;
    function Reader() {
      captured = useTemplatePackageCatalog();
      return null;
    }
    const { services } = renderInContext(<Reader />);
    expect(captured).toBe(services.templatePackages);
    expect(captured.getSummaries()[0]).toEqual(expect.objectContaining({
      id: 'aeonstagery.default',
      version: '2.0.0',
    }));
  });

  it('useProjectOpenWorkflow returns the project open workflow service', () => {
    let captured: any = null;
    function Reader() {
      captured = useProjectOpenWorkflow();
      return null;
    }
    renderInContext(<Reader />);
    expect(captured).toBeDefined();
    expect(typeof captured.openProjectAndLoadDefaultScene).toBe('function');
  });

  it('useFileAccessService returns the file access service', () => {
    let captured: any = null;
    function Reader() {
      captured = useFileAccessService();
      return null;
    }
    const { services } = renderInContext(<Reader />);
    expect(captured).toBe(services.fileAccess);
  });

  it('useCollaborationStatus returns the provider collaboration status', () => {
    let status: any = null;
    let undoDisabled: any = null;
    function Reader() {
      status = useCollaborationStatus();
      undoDisabled = useIsCollaborationUndoDisabled();
      return null;
    }
    renderInContext(<Reader />, { status: 'connected' });
    expect(status).toBe('connected');
    expect(undoDisabled).toBe(true);
  });

  it('isCollaborationUndoDisabled only disables undo while a collaboration session is active or transitioning', () => {
    expect(isCollaborationUndoDisabled('disconnected')).toBe(false);
    expect(isCollaborationUndoDisabled('error')).toBe(false);
    expect(isCollaborationUndoDisabled('connecting')).toBe(true);
    expect(isCollaborationUndoDisabled('seeding')).toBe(true);
    expect(isCollaborationUndoDisabled('connected')).toBe(true);
    expect(isCollaborationUndoDisabled('offline')).toBe(true);
  });

  it('useCollaborationPresence returns empty defaults when no presence is provided', () => {
    let presence: any = null;
    function Reader() {
      presence = useCollaborationPresence();
      return null;
    }
    renderInContext(<Reader />);
    expect(presence).toEqual({ self: null, peers: [] });
  });

  it('useCollaborationPresence returns provided self and peers without breaking status', () => {
    const self = { clientId: 'self-1', displayName: '导演' };
    const peers = [
      {
        clientId: 'peer-1',
        displayName: '副导演',
        selectedStatementIds: ['statement-a1'],
        editingTarget: { kind: 'statement', statementId: 'statement-a1' },
      },
    ];
    let status: any = null;
    let presence: any = null;
    function Reader() {
      status = useCollaborationStatus();
      presence = useCollaborationPresence();
      return null;
    }
    renderInContext(<Reader />, { status: 'connected', self, peers });
    expect(status).toBe('connected');
    expect(presence).toEqual({ self, peers });
  });

  it('useCollaborationPresencePublisher returns the provider publisher', () => {
    const publishPresence = () => {};
    let captured: any = null;
    function Reader() {
      captured = useCollaborationPresencePublisher();
      return null;
    }
    renderInContext(<Reader />, { status: 'connected', publishPresence });
    expect(captured).toBe(publishPresence);
  });

});
