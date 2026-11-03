import { describe, expect, it } from 'vitest';
import { diagnoseAiError, shouldRequireAiCredentialSetup } from '../services/ai-authoring/aiErrorPresentation';

describe('AI credential setup', () => {
  it.each(['http://192.168.1.20:11434/v1', 'http://ollama.lan:11434/v1', 'https://ai.example.test/v1', 'http://localhost:11434/v1'])(
    'allows requests without credentials to a configured endpoint: %s', (endpoint) => {
      expect(shouldRequireAiCredentialSetup({ credentialChecked: true, credentialConfigured: false, endpoint })).toBe(false);
    },
  );

  it('guides setup when neither an endpoint nor a credential is configured', () => {
    expect(shouldRequireAiCredentialSetup({ credentialChecked: true, credentialConfigured: false, endpoint: ' ' })).toBe(true);
  });

  it('guides credential setup after an endpoint rejects an anonymous request', () => {
    expect(diagnoseAiError(new Error('HTTP 401 Unauthorized'))).toMatchObject({ category: 'unauthorized', suggestOpenSettings: true });
  });
});
