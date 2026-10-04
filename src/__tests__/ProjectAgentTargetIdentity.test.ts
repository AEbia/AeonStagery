import { describe, expect, it } from 'vitest';
import {
  buildProjectAgentSystemPrompt,
  PROJECT_AGENT_CAPABILITY_CATALOG_SLOT,
} from '../services/project-agent-service/ProjectAgentSystemPrompt';
import {
  decodeProjectAgentTargetIdentity,
  encodeProjectAgentTargetIdentity,
  type ProjectAgentTargetIdentityRef,
} from '../services/project-agent-service/ProjectAgentTargetIdentity';

const TARGET: ProjectAgentTargetIdentityRef = {
  projectId: 'project-abc',
  sceneEntryId: 'scene-entry-42',
  sceneDocumentId: 'scene-doc-7',
};

describe('ProjectAgentTargetIdentity', () => {
  it('encodes the three-part identity into the coordinator targetSceneIdentity string', () => {
    const encoded = encodeProjectAgentTargetIdentity(TARGET);
    expect(encoded).toContain('scene-entry-42');
    expect(encoded).toContain('scene-doc-7');
    expect(encoded).toContain('project-abc');
  });

  it('round-trips the decoded identity fields', () => {
    const decoded = decodeProjectAgentTargetIdentity(encodeProjectAgentTargetIdentity(TARGET));
    expect(decoded).toEqual(TARGET);
  });

  it('rejects malformed encoded identities', () => {
    expect(decodeProjectAgentTargetIdentity('not-an-identity')).toBeNull();
    expect(decodeProjectAgentTargetIdentity('')).toBeNull();
    expect(decodeProjectAgentTargetIdentity('a\u0000b\u0000c\u0000d')).toBeNull();
  });

  it('never embeds the identity inside model-visible content builders', () => {
    const encoded = encodeProjectAgentTargetIdentity(TARGET);
    const systemPrompt = buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' });
    expect(systemPrompt).not.toContain(encoded);
    expect(systemPrompt).not.toContain('scene-entry-42');
    expect(systemPrompt).not.toContain('scene-doc-7');
    expect(systemPrompt).not.toContain('project-abc');
  });
});

describe('buildProjectAgentSystemPrompt', () => {
  it('keeps the base system prompt and declares autonomous context', () => {
    const prompt = buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' });
    expect(prompt).toContain('You are the project agent.');
    expect(prompt).toContain('readProjectOverview');
    expect(prompt).toMatch(/autonomous/i);
  });

  it('guides broad reads and independent batching without stale control tools', () => {
    const prompt = buildProjectAgentSystemPrompt({ baseSystemPrompt: 'base' });
    expect(prompt).toContain('readScene({ startLine: 1, lineCount: 500 })');
    expect(prompt).toContain('Batch independent read tools');
    expect(prompt).toContain('pathPrefix');
    expect(prompt).toContain('Use text only to find a known name');
    expect(prompt).not.toContain('completeTask');
    expect(prompt).not.toContain('reportBlocked');
  });

  it('exposes the capability catalog placeholder slot and nothing else injected', () => {
    const prompt = buildProjectAgentSystemPrompt({ baseSystemPrompt: 'base' });
    expect(prompt).toContain(PROJECT_AGENT_CAPABILITY_CATALOG_SLOT);
    expect(prompt).not.toContain('projectId');
    expect(prompt).not.toContain('sceneId');
    expect(prompt).not.toContain('taskId');
    expect(prompt).not.toContain('lease');
    expect(prompt).not.toContain('/Users/');
  });
});
