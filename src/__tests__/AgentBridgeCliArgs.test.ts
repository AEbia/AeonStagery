import { homedir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  agentBridgeUsageText,
  defaultAgentBridgeJournalDirectory,
  parseAgentBridgeCliArgs,
} from '../services/project-agent-standalone/AgentBridgeCli';

const EMPTY_ENV: Record<string, string | undefined> = {};

describe('defaultAgentBridgeJournalDirectory', () => {
  it('joins os.homedir with the agent-bridge journal path', () => {
    expect(defaultAgentBridgeJournalDirectory()).toBe(
      join(homedir(), '.config', 'AeonStagery', 'agent-bridge-journal'),
    );
  });
});

describe('parseAgentBridgeCliArgs basic forms', () => {
  it('parses --key value style', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir', '/p', '--scene-rel-path', 's.json', '--message', 'hi'],
      EMPTY_ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toMatchObject({
      command: 'run',
      projectDir: '/p',
      sceneRelPath: 's.json',
      message: 'hi',
    });
  });

  it('parses --key=value style', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir=/p', '--scene-rel-path=s.json', '--message=hello'],
      EMPTY_ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toMatchObject({
      command: 'run',
      projectDir: '/p',
      sceneRelPath: 's.json',
      message: 'hello',
    });
  });

  it('accepts boolean dotted flags', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir', '/p', '--scene-rel-path', 's.json', '--message', 'hi', '--full-access'],
      EMPTY_ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.accessMode).toBe('full_access');
  });

  it('parses a mode via --access-mode', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir', '/p', '--scene-rel-path', 's.json', '--message', 'hi', '--access-mode', 'standard'],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.accessMode).toBe('standard');
  });

  it('parses timeout-ms as a non-negative integer', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir', '/p', '--scene-rel-path', 's.json', '--message', 'hi', '--timeout-ms', '5000'],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.timeoutMs).toBe(5000);
    expect(typeof result.args.timeoutMs).toBe('number');
  });

  it('parses --journal to override the default directory and applies defaults', () => {
    const result = parseAgentBridgeCliArgs(
      ['show', '--journal', '/custom/j', '--project-id', 'proj', '--task-id', 't1'],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args).toMatchObject({
      command: 'show',
      journalDirectory: '/custom/j',
      projectId: 'proj',
      taskId: 't1',
    });
    // defaults preserved
    expect(result.args.endpoint).toBeUndefined();
    expect(result.args.accessMode).toBeUndefined();
    expect(result.args.timeoutMs).toBeUndefined();
  });
});

describe('parseAgentBridgeCliArgs usage errors', () => {
  it('rejects an unknown flag', () => {
    const result = parseAgentBridgeCliArgs(['run', '--bogus', 'x'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('unknown option') });
  });

  it('rejects run missing projectDir', () => {
    const result = parseAgentBridgeCliArgs(['run', '--scene-rel-path', 's.json', '--message', 'hi'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('project-dir') });
  });

  it('rejects run missing sceneRelPath', () => {
    const result = parseAgentBridgeCliArgs(['run', '--project-dir', '/p', '--message', 'hi'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('scene-rel-path') });
  });

  it('rejects run missing message', () => {
    const result = parseAgentBridgeCliArgs(['run', '--project-dir', '/p', '--scene-rel-path', 's.json'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('message') });
  });

  it('rejects an unknown command', () => {
    const result = parseAgentBridgeCliArgs(['frobnicate'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('command') });
  });

  it('rejects list missing projectId', () => {
    const result = parseAgentBridgeCliArgs(['list'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('project-id') });
  });

  it('rejects show missing projectId or taskId', () => {
    expect(parseAgentBridgeCliArgs(['show', '--task-id', 't1'], EMPTY_ENV)).toEqual({
      ok: false,
      error: expect.stringContaining('project-id'),
    });
    expect(parseAgentBridgeCliArgs(['show', '--project-id', 'p1'], EMPTY_ENV)).toEqual({
      ok: false,
      error: expect.stringContaining('task-id'),
    });
  });

  it('rejects a non-integer timeout', () => {
    const result = parseAgentBridgeCliArgs(['run', '--timeout-ms', 'abc'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('timeout-ms') });
  });

  it('rejects a negative timeout', () => {
    const result = parseAgentBridgeCliArgs(['run', '--timeout-ms', '-3'], EMPTY_ENV);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('timeout-ms') });
  });

  it('parses --context-window as a positive integer', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir', '/p', '--scene-rel-path', 's.json', '--message', 'hi', '--context-window', '1000000'],
      EMPTY_ENV,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.contextWindow).toBe(1_000_000);
  });

  it('reads --context-window from the environment fallback', () => {
    const result = parseAgentBridgeCliArgs(
      ['serve'],
      { AEON_AGENT_BRIDGE_CONTEXT_WINDOW: '262144' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.contextWindow).toBe(262144);
  });

  it('rejects an invalid context window', () => {
    for (const bad of ['abc', '0', '-1']) {
      const result = parseAgentBridgeCliArgs(['serve', '--context-window', bad], EMPTY_ENV);
      expect(result).toEqual({ ok: false, error: expect.stringContaining('context-window') });
    }
  });
});

describe('parseAgentBridgeCliArgs benchmark command', () => {
  it('parses the four benchmark phase arguments plus optional overwrite', () => {
    const result = parseAgentBridgeCliArgs(
      ['benchmark', '--phase', 'candidate', '--runs', '3', '--token-budget', '200000', '--output', 'art/candidate.json', '--overwrite'],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args).toMatchObject({
      command: 'benchmark',
      phase: 'candidate',
      runs: 3,
      tokenBudget: 200000,
      output: 'art/candidate.json',
      overwrite: true,
    });
  });

  it('defaults overwrite to false and accepts --key=value style', () => {
    const result = parseAgentBridgeCliArgs(
      ['benchmark', '--phase=baseline', '--runs=1', '--token-budget=1000', '--output=out.json'],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args).toMatchObject({
      command: 'benchmark',
      phase: 'baseline',
      runs: 1,
      tokenBudget: 1000,
      output: 'out.json',
      overwrite: false,
    });
  });

  it('reuses bridge provider flags and env for the benchmark command', () => {
    const result = parseAgentBridgeCliArgs(
      ['benchmark', '--phase', 'baseline', '--runs', '1', '--token-budget', '1000', '--output', 'out.json', '--endpoint', 'https://cli', '--model', 'm1'],
      { AEON_AGENT_BRIDGE_ENDPOINT: 'https://env', AEON_AGENT_BRIDGE_MODEL: 'env-model' },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.endpoint).toBe('https://cli');
    expect(result.args.model).toBe('m1');
  });

  it('rejects benchmark missing required arguments', () => {
    const result = parseAgentBridgeCliArgs(
      ['benchmark', '--phase', 'baseline', '--runs', '3', '--token-budget', '200000'],
      EMPTY_ENV,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--output');
  });

  it('rejects an unknown benchmark phase', () => {
    const result = parseAgentBridgeCliArgs(
      ['benchmark', '--phase', 'sideways', '--runs', '3', '--token-budget', '200000', '--output', 'out.json'],
      EMPTY_ENV,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--phase must be baseline or candidate');
  });

  it('rejects a non-positive runs or token budget', () => {
    for (const argv of [
      ['benchmark', '--phase', 'baseline', '--runs', '0', '--token-budget', '100', '--output', 'out.json'],
      ['benchmark', '--phase', 'baseline', '--runs', '2', '--token-budget', '-5', '--output', 'out.json'],
      ['benchmark', '--phase', 'baseline', '--runs', 'abc', '--token-budget', '100', '--output', 'out.json'],
    ]) {
      const result = parseAgentBridgeCliArgs(argv, EMPTY_ENV);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/must be a positive integer/);
    }
  });

  it('rejects a value on the overwrite boolean flag', () => {
    const result = parseAgentBridgeCliArgs(
      ['benchmark', '--phase', 'baseline', '--runs', '1', '--token-budget', '100', '--output', 'out.json', '--overwrite=true'],
      EMPTY_ENV,
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining('does not take a value') });
  });
});

describe('parseAgentBridgeCliArgs external library mounts', () => {
  it('parses repeatable --mount <id>=<path> specs', () => {
    const result = parseAgentBridgeCliArgs(
      [
        'run',
        '--project-dir',
        '/p',
        '--scene-rel-path',
        's.json',
        '--message',
        'hi',
        '--mount',
        'library=C:/Library A/x',
        '--mount=webgal=C:/WebGAL/game',
      ],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.mounts).toEqual([
      { id: 'library', path: 'C:/Library A/x' },
      { id: 'webgal', path: 'C:/WebGAL/game' },
    ]);
  });

  it('keeps mounts undefined when --mount is absent', () => {
    const result = parseAgentBridgeCliArgs(
      ['run', '--project-dir', '/p', '--scene-rel-path', 's.json', '--message', 'hi'],
      EMPTY_ENV,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.mounts).toBeUndefined();
  });

  it('rejects a mount spec without a separator, empty path, or invalid id', () => {
    for (const spec of ['library', '=C:/x', 'bad!id=C:/x', 'library=', 'Bad_ID=C:/x']) {
      const result = parseAgentBridgeCliArgs(
        ['serve', '--mount', spec],
        EMPTY_ENV,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('mount');
    }
  });
});

describe('parseAgentBridgeCliArgs env fallback', () => {
  it('serves a valid no-required-args command', () => {
    const result = parseAgentBridgeCliArgs(['serve'], EMPTY_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.command).toBe('serve');
    // default journal directory
    expect(result.args.journalDirectory).toBe(defaultAgentBridgeJournalDirectory());
  });

  it('reads endpoint/model/apiKey from env', () => {
    const result = parseAgentBridgeCliArgs(
      ['serve'],
      {
        AEON_AGENT_BRIDGE_ENDPOINT: 'https://x',
        AEON_AGENT_BRIDGE_MODEL: 'm1',
        AEON_AGENT_BRIDGE_API_KEY: 'key1',
      },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.endpoint).toBe('https://x');
    expect(result.args.model).toBe('m1');
    expect(result.args.apiKey).toBe('key1');
  });

  it('prefers explicit --endpoint over env', () => {
    const result = parseAgentBridgeCliArgs(
      ['serve', '--endpoint', 'https://cli'],
      { AEON_AGENT_BRIDGE_ENDPOINT: 'https://env' },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.args.endpoint).toBe('https://cli');
  });
});

describe('agentBridgeUsageText', () => {
  it('mentions the supported commands', () => {
    const text = agentBridgeUsageText();
    for (const command of ['run', 'list', 'show', 'serve', 'benchmark']) {
      expect(text).toContain(command);
    }
    for (const flag of ['--phase', '--runs', '--token-budget', '--output', '--overwrite', '--mount']) {
      expect(text).toContain(flag);
    }
  });
});
