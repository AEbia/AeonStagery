import type {
  AgentRunTerminalCommandArgs,
  AgentRunTerminalCommandResult,
  AgentToolResult,
} from '../../api/types/project-agent';
import type { ProjectAgentTerminalPort } from './ProjectAgentPorts';
import { toolFail, toolOk } from './ProjectAgentPathRules';

/** Thin typed facade over the main-process terminal execution seam. */
export class ProjectAgentTerminalTools {
  constructor(private readonly terminal?: ProjectAgentTerminalPort) {}

  async runTerminalCommand(
    args: AgentRunTerminalCommandArgs,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<AgentRunTerminalCommandResult>> {
    if (!this.terminal) {
      return toolFail({
        code: 'terminal_unavailable',
        message: 'Terminal execution is unavailable for this Conversation',
        retryable: false,
      });
    }
    if (signal?.aborted) {
      return toolFail({ code: 'cancelled', message: 'Terminal command was cancelled', retryable: false });
    }
    try {
      return toolOk(await this.terminal.runTerminalCommand(args, signal));
    } catch {
      return toolFail({
        code: 'terminal_unavailable',
        message: 'Terminal command could not be started',
        retryable: true,
      });
    }
  }
}
