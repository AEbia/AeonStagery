import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_AGENT_BENCHMARK_EXIT } from './ProjectAgentBenchmarkCli';
import type { ProjectAgentBenchmarkArtifact } from './ProjectAgentBenchmarkTypes';

export type ProjectAgentBenchmarkArtifactWriteResult =
  | { readonly ok: true; readonly outputPath: string }
  | {
      readonly ok: false;
      readonly exitCode: typeof PROJECT_AGENT_BENCHMARK_EXIT.configuration;
      readonly message: string;
    };

const PROHIBITED_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]+/i,
  /https?:\/\//i,
  /api[_-]?key/i,
  /authorization/i,
  /reasoningContent/i,
  /Update this line\./,
  /Inserted draft\./,
  /Downstream stays until delete\./,
  /Batch dialogue\./,
];

export function writeProjectAgentBenchmarkArtifact(options: {
  readonly output: string;
  readonly overwrite: boolean;
  readonly artifact: ProjectAgentBenchmarkArtifact;
}): ProjectAgentBenchmarkArtifactWriteResult {
  assertProjectAgentBenchmarkArtifactRedacted(options.artifact);
  const outputPath = path.resolve(options.output);
  if (fs.existsSync(outputPath) && !options.overwrite) {
    return {
      ok: false,
      exitCode: PROJECT_AGENT_BENCHMARK_EXIT.configuration,
      message: `Artifact already exists: ${outputPath}`,
    };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(options.artifact, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, outputPath);
  return { ok: true, outputPath };
}

export function assertProjectAgentBenchmarkArtifactRedacted(artifact: unknown): void {
  const serialized = JSON.stringify(artifact);
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`Benchmark artifact contains prohibited content matching ${pattern}`);
    }
  }
}
