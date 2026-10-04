import { describe, expect, it } from 'vitest';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';
import {
  PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE,
  PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE_MAX_CHARS,
  STATEMENT_AUTHORING_REFERENCE_FAMILIES,
} from '../services/project-agent/StatementAuthoringReference';
import { sceneStatementDefinitionRegistry } from '../services/semantic-scene/SceneStatementDefinitionRegistry';

describe('ProjectAgentStatementAuthoringReference', () => {
  it('covers every registered statement family (drift guard)', () => {
    const registryFamilies = sceneStatementDefinitionRegistry.list().map((definition) => definition.family).sort();
    expect([...STATEMENT_AUTHORING_REFERENCE_FAMILIES].sort()).toEqual(registryFamilies);
  });

  it('documents the mode enums the Agent most often gets wrong', () => {
    const text = PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE;
    expect(text).toContain('mode! (set|transform|remove)');
    expect(text).toContain('mode! (enter|exit)');
    expect(text).toContain('role! (bgm|sfx)');
    expect(text).toContain('mode! (play|stop)');
    expect(text).toContain('focus|move|follow|path|shake|reset');
  });

  it('stays within the bounded size guard', () => {
    expect(PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE.length).toBeLessThanOrEqual(
      PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE_MAX_CHARS,
    );
    expect(PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE.length).toBeGreaterThan(500);
  });

  it('does not teach removed characterPerformance params', () => {
    const text = PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE;
    expect(text).not.toContain('optional durationSeconds, loop, priority');
    expect(text).toContain('no params.durationSeconds / loop / priority');
    expect(text).toContain('motion is "" (unfilled placeholder)');
    expect(text).toContain('"kind":"resource"');
  });

  it('marks audio play file as required in the current Scene Document', () => {
    const text = PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE;
    expect(text).toContain('bgm play: file!');
    expect(text).toContain('sfx play: instanceId!, file!');
  });

  it('documents integration defaults and its centered brightness delta', () => {
    const text = PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE;
    expect(text).toContain('integration set defaults to intensity 0.8 and colorBlendMode multiply, and accepts brightness (-1..1, default 0).');
    expect(text).not.toContain('optional intensity, brightness');
  });

  it('documents the required locator fields of visualStyle and companions', () => {
    const text = PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE;
    expect(text).toContain('scope! (object)');
    expect(text).toContain('slot! (integration|accent|distortion|rim-light)');
    expect(text).toContain('{ anchor (start|end), offset (seconds), type, params }');
  });

  it('describes current authoring capability rather than retired alternatives', () => {
    const text = PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE;
    expect(text).not.toContain('hitchcock');
    expect(text).not.toContain('grounding');
    expect(text).not.toContain('filterAdd');
    expect(text).not.toContain('deprecated');
  });
});

describe('buildProjectAgentSystemPrompt statement authoring injection', () => {
  it('injects the reference and the no-guessing rules', () => {
    const prompt = buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' });
    expect(prompt).toContain('Statement authoring reference (authoritative; never guess statement.params)');
    expect(prompt).toContain(PROJECT_AGENT_STATEMENT_AUTHORING_REFERENCE);
    expect(prompt).toContain('Never probe field names one guess at a time');
    expect(prompt).toContain('fix every reported issue in the next call');
  });

  it('clarifies version advancement so consecutive writes do not look conflicting', () => {
    const prompt = buildProjectAgentSystemPrompt({ baseSystemPrompt: 'base' });
    expect(prompt).toContain('advances your base snapshot after commit');
    expect(prompt).toContain('use applyAuthoringTransaction when changes must succeed or fail together');
  });
});
