import path from 'node:path';
import {
  startCollaborationServer,
  type CollaborationServerStatus,
  type RunningCollaborationServer,
} from '../server/collaboration/server';
import {
  clearPreviousCollaborationSessions,
  resolveProjectCollaborationSessionDataDir,
  type ClearCollaborationSessionsResult,
} from '../server/collaboration/sessionStore';

export interface EmbeddedCollaborationStartInput {
  userDataPath: string;
  projectId: string;
  host: string;
  port: number;
}

export interface EmbeddedCollaborationStartResult {
  status: CollaborationServerStatus;
  reused: boolean;
}

/** Serializes start/stop IPC calls and retains the current room on repeat starts. */
export class EmbeddedCollaborationServer {
  private server: RunningCollaborationServer | null = null;
  private activeInput: EmbeddedCollaborationStartInput | null = null;
  private operations: Promise<void> = Promise.resolve();

  getStatus(): CollaborationServerStatus | null {
    return this.server?.getStatus() ?? null;
  }

  start(input: EmbeddedCollaborationStartInput): Promise<EmbeddedCollaborationStartResult> {
    return this.enqueue(async () => {
      const projectId = input.projectId.trim();
      if (!projectId) throw new Error('A project ID is required to host collaboration');
      const previous = this.activeInput;
      if (
        this.server?.getStatus().running
        && previous?.projectId === projectId
        && previous.host === input.host
        && previous.port === input.port
        && path.resolve(previous.userDataPath) === path.resolve(input.userDataPath)
      ) return { status: this.server.getStatus(), reused: true };

      const dataDir = await resolveProjectCollaborationSessionDataDir(input.userDataPath, projectId);
      if (this.server) {
        await this.server.stop();
        this.server = null;
        this.activeInput = null;
      }
      this.server = await startCollaborationServer({
        host: input.host,
        port: input.port,
        dataDir,
        expectedProjectId: projectId,
      });
      this.activeInput = { ...input, projectId };
      return { status: this.server.getStatus(), reused: false };
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.server) return;
      await this.server.stop();
      this.server = null;
      this.activeInput = null;
    });
  }

  clearPreviousSessions(userDataPath: string): Promise<ClearCollaborationSessionsResult> {
    return this.enqueue(() => clearPreviousCollaborationSessions(userDataPath, this.getStatus()?.dataDir));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
