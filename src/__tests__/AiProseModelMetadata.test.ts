import { describe, expect, it } from 'vitest';
import { parseAiProseModelListPayload } from '../services/ai-authoring/AiProseContracts';

describe('AI prose model metadata', () => {
  it('preserves provider context-window metadata without changing the model id list', () => {
    expect(parseAiProseModelListPayload({
      data: [
        { id: 'model-b', context_window: 64000 },
        { id: 'model-a', metadata: { contextLength: 128000 } },
        { id: 'model-b', unknown_limit: 999999 },
      ],
    })).toEqual({
      models: ['model-a', 'model-b'],
      modelMetadata: {
        'model-a': { contextWindow: 128000 },
        'model-b': { contextWindow: 64000 },
      },
    });
  });

  it('reads common provider context-window aliases (vLLM-style max_model_len etc.)', () => {
    expect(parseAiProseModelListPayload({
      data: [
        { id: 'vllm-model', max_model_len: 32768 },
        { id: 'tokens-model', context_tokens: 8192 },
        { id: 'size-model', maxContextSize: 16000 },
        { id: 'camel-model', maxModelLen: 65536 },
      ],
    })).toEqual({
      models: ['camel-model', 'size-model', 'tokens-model', 'vllm-model'],
      modelMetadata: {
        'vllm-model': { contextWindow: 32768 },
        'tokens-model': { contextWindow: 8192 },
        'size-model': { contextWindow: 16000 },
        'camel-model': { contextWindow: 65536 },
      },
    });
  });

  it('omits metadata when the provider does not report a valid context window', () => {
    expect(parseAiProseModelListPayload({
      data: [
        { id: 'unknown-model' },
        { id: 'invalid-model', context_window: 0 },
        { id: 'string-model', context_window: '128000' },
      ],
    })).toEqual({
      models: ['invalid-model', 'string-model', 'unknown-model'],
    });
  });
});
