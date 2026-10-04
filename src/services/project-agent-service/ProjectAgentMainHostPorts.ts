import type { ProjectAgentMainHost } from '../../api/types/project-agent-ipc';
import type {
  ProjectAgentJournalPort,
  ProjectAgentJournalRecord,
} from '../project-agent/ProjectAgentJournal';
import type {
  ProjectAgentLeaseAcquireResult,
  ProjectAgentLeaseHandle,
  ProjectAgentLeasePort,
  ProjectAgentLeaseReleaseResult,
} from '../project-agent/ProjectAgentLease';
import type { ProjectAgentTerminalPort } from '../project-agent/ProjectAgentPorts';
import type { AgentRunTerminalCommandArgs } from '../../api/types/project-agent';

/**
 * Renderer-side lease port delegating to the main-process coordinator, which
 * owns the application-global singleton running slot. Any window, renderer
 * reload or UI bypass still cannot create a second running task (ADR0023).
 */
export function createMainHostLeasePort(host: ProjectAgentMainHost): ProjectAgentLeasePort {
  return {
    tryAcquire: (projectId, taskId): Promise<ProjectAgentLeaseAcquireResult> =>
      host.acquireLease(projectId, taskId),
    release: (leaseToken: string): Promise<ProjectAgentLeaseReleaseResult> =>
      host.releaseLease(leaseToken),
    getHolder: (): Promise<ProjectAgentLeaseHandle | null> => host.getLeaseHolder(),
  };
}

/**
 * Renderer-side journal port delegating to the main-process coordinator,
 * which atomically persists records in the application local data directory.
 * Journals never enter project files, collaboration state or model context.
 */
export function createMainHostJournalPort(host: ProjectAgentMainHost): ProjectAgentJournalPort {
  return {
    load: (projectId, taskId): Promise<ProjectAgentJournalRecord | null> =>
      host.journalLoad(projectId, taskId),
    save: (record): Promise<void> =>
      // The main gate enforces terminal first-wins; a refused non-terminal
      // write is a stale in-memory pause and must never overwrite the
      // persisted terminal record (ADR0023).
      host.journalSave(record).then(() => undefined),
    delete: (): Promise<void> =>
      // Journal deletion is main-process-owned (acknowledgeReport, discard);
      // the editor renderer never deletes journal records (ADR0023).
      Promise.reject(new Error('Journal deletion is main-process-owned; the editor renderer never deletes journal records.')),
    listByProject: (projectId): Promise<readonly ProjectAgentJournalRecord[]> =>
      host.journalListByProject(projectId),
  };
}

/**
 * Renderer-side terminal adapter. Main validates that `taskId` belongs to a
 * durable full-access Conversation before it starts the child process.
 */
export function createMainHostTerminalPort(
  host: ProjectAgentMainHost,
  projectId: string,
  taskId: string,
  idFactory: () => string,
): ProjectAgentTerminalPort {
  return {
    async runTerminalCommand(options: AgentRunTerminalCommandArgs, signal?: AbortSignal) {
      if (!host.runTerminalCommand) {
        throw new Error('Terminal command execution is unavailable in this host');
      }
      const requestId = idFactory();
      let aborted = false;
      const abort = () => {
        aborted = true;
        void host.cancelTerminalCommand?.(requestId);
      };
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (aborted) throw new Error('Terminal command was cancelled');
        const response = await host.runTerminalCommand({
          projectId,
          taskId,
          requestId,
          ...options,
        });
        if (!response.ok || !response.result) {
          throw new Error(response.error ?? 'Terminal command could not be started');
        }
        return response.result;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
