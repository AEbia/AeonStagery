import type {
  AiConversationMessage,
  AiConversationRequest,
  AiConversationResponse,
} from '../../api/types/ai-conversation';
import type { AiConversationTransport } from '../ai-authoring/AiConversationTransport';
import {
  projectAiConversationImagePayloads,
  type AiConversationImagePayloadResolver,
} from '../ai-conversation/AiConversationImageProjection';
import type { AgentConversationSummaryV1 } from './ProjectAgentTask';
import type { ProjectAgentContinuationSummarizerPort } from './ProjectAgentCoordinator';

/**
 * Production conversation summarizer (ADR0023): calls the CURRENT
 * projectAgentModel through the shared transport with NO tools registered and
 * a structured json_object response format. The summary model may consume the
 * in-memory image payloads projected from the session cache and must return
 * textual key findings only. Raw provider failures surface as structured
 * results so the coordinator can suspend the round as
 * `context_compaction_required` without ever generating a deterministic
 * semantic summary.
 */
export class ModelProjectAgentContinuationSummarizer implements ProjectAgentContinuationSummarizerPort {
  private readonly transport: AiConversationTransport;
  private readonly imagePayloadResolver: AiConversationImagePayloadResolver | null;

  constructor(options: {
    transport: AiConversationTransport;
    imagePayloadResolver?: AiConversationImagePayloadResolver | null;
  }) {
    this.transport = options.transport;
    this.imagePayloadResolver = options.imagePayloadResolver ?? null;
  }

  async summarize(input: {
    originalTaskText: string;
    messages: readonly AiConversationMessage[];
    committedChangeNotes: readonly string[];
    maxTokens: number;
    endpoint?: string;
    model?: string;
    imagePayloadResolver?: AiConversationImagePayloadResolver | null;
    previousError?: string | null;
  }): Promise<
    | { ok: true; value: AgentConversationSummaryV1 }
    | { ok: false; code: string; message: string }
  > {
    if (!input.endpoint || !input.model) {
      return {
        ok: false,
        code: 'invalid_arguments',
        message: 'No current endpoint/model is resolved for the summary request',
      };
    }
    const resolver = input.imagePayloadResolver ?? this.imagePayloadResolver;
    const conversation = resolver
      ? await projectAiConversationImagePayloads(input.messages, resolver)
      : [...input.messages];
    const request: AiConversationRequest = {
      endpoint: input.endpoint,
      model: input.model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: buildSummarySystemInstruction(input.maxTokens) }],
        },
        ...conversation,
        {
          role: 'user',
          content: [{ type: 'text', text: buildSummaryTaskInstruction(input) }],
        },
      ],
      responseFormat: { type: 'json_object' },
    };
    let response: AiConversationResponse;
    try {
      response = await this.transport.complete(request);
    } catch (error) {
      return {
        ok: false,
        code: 'summary_request_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const text = assistantText(response.message);
    const parsed = parseSummaryJson(text);
    if (!parsed.ok) {
      return { ok: false, code: 'summary_schema_invalid', message: parsed.error };
    }
    return { ok: true, value: parsed.value };
  }
}

function buildSummarySystemInstruction(maxTokens: number): string {
  return [
    'You are the project Agent conversation summarizer. Produce the AgentConversationSummaryV1 for the conversation below.',
    'Respond with a single JSON object: {"version": 1, "objective": string, "importantDetails": [string], "workState": {"completed": [string], "active": [string], "nextMove": [string]}, "relevantFiles": [string]}.',
    'objective is the CURRENT direction of the conversation, not a persistent goal identity; it never creates a completion or terminal state. All list fields must be arrays of strings (empty arrays allowed).',
    'Exclusion rules: never include full scene text, agent line numbers, internal UUIDs, full tool receipts or tool logs, or image bytes. Images in the conversation may be consumed to extract textual key findings only.',
    `The whole summary must stay within ${maxTokens} tokens.`,
    'Reply with ONLY the JSON object.',
  ].join('\n');
}

function buildSummaryTaskInstruction(input: {
  originalTaskText: string;
  committedChangeNotes: readonly string[];
  previousError?: string | null;
}): string {
  const parts = [
    `Original user task: ${input.originalTaskText}`,
  ];
  if (input.committedChangeNotes.length > 0) {
    parts.push(`Host-trusted committed changes: ${input.committedChangeNotes.join('; ')}`);
  }
  parts.push('Summarize the conversation above into AgentConversationSummaryV1.');
  if (input.previousError) {
    parts.push(`Your previous summary failed schema validation: ${input.previousError}. Fix it and retry.`);
  }
  return parts.join('\n');
}

function assistantText(message: AiConversationResponse['message']): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n')
    .trim();
}

function parseSummaryJson(text: string): { ok: true; value: AgentConversationSummaryV1 } | {
  ok: false;
  error: string;
} {
  if (!text) {
    return { ok: false, error: 'The summary model returned an empty response' };
  }
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const value = JSON.parse(cleaned) as unknown;
    return { ok: true, value: value as AgentConversationSummaryV1 };
  } catch {
    return { ok: false, error: 'The summary model response is not valid JSON' };
  }
}
