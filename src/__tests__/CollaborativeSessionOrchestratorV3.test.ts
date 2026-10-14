import { describe, expect, it, vi } from 'vitest';
import { CollaborativeSessionOrchestratorV3 } from '../services/collaboration/CollaborativeSessionOrchestratorV3';
import type { CollaborativeClientPortV3 } from '../services/collaboration/CollaborativeClientPortV3';

function failingClient(): CollaborativeClientPortV3 {
  return {
    join: vi.fn(async () => { throw new Error('join failed'); }),
    seed: vi.fn(async () => {}),
    getState: vi.fn(() => null),
    publishState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
}

function startInput(client: CollaborativeClientPortV3) {
  return {
    endpoint: 'server.example:1234',
    identity: { clientId: 'director', displayName: 'Director' },
    collaborationProjectId: 'project-1',
    roomId: 'project-1:main',
    client,
  };
}

describe('CollaborativeSessionOrchestratorV3 disposal', () => {
  it('waits for entered authoring transactions and lease release before disposing a failed client', async () => {
    const client = failingClient();
    let finishRelease!: () => void;
    const beforeDispose = vi.fn(() => new Promise<void>((resolve) => { finishRelease = resolve; }));
    const orchestrator = new CollaborativeSessionOrchestratorV3();
    const starting = orchestrator.start({ ...startInput(client), beforeDispose });
    const rejection = expect(starting).rejects.toThrow('join failed');
    await vi.waitFor(() => expect(beforeDispose).toHaveBeenCalledOnce());
    expect(client.dispose).not.toHaveBeenCalled();
    finishRelease();
    await rejection;
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(orchestrator.activeLayer).toBeNull();
  });

  it('disposes the failed client even if the authoring cleanup rejects', async () => {
    const client = failingClient();
    const orchestrator = new CollaborativeSessionOrchestratorV3();
    await expect(orchestrator.start({
      ...startInput(client),
      beforeDispose: async () => { throw new Error('cleanup failed'); },
    })).rejects.toThrow('cleanup failed');
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});
