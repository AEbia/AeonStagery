import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maxBuffer = 32 * 1024 * 1024;

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer,
  });
}

function outputOf(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function reportFailure(label, result) {
  const code = result.status === null ? 'could not start' : `exit code ${result.status}`;
  console.error(`${label}: failed (${code}).`);

  const details = outputOf(result) || result.error?.message;
  if (details) console.error(details);
}

let failed = false;

// Repository hygiene (ADR-0035): no Live2D proprietary runtime may be tracked.
const hygiene = runNode(['scripts/check-repo-hygiene.mjs']);
if (hygiene.status === 0) {
  console.log('Repository hygiene check passed.');
} else {
  failed = true;
  reportFailure('Repository hygiene', hygiene);
}

// Third-party notices must match the current dependency graph.
const notices = runNode(['scripts/generate-third-party-notices.mjs', '--check']);
if (notices.status === 0) {
  console.log('Third-party notices check passed.');
} else {
  failed = true;
  reportFailure('Third-party notices', notices);
}

const tests = runNode([
  'node_modules/vitest/vitest.mjs',
  'run',
  '--reporter=minimal',
  '--silent',
]);
const testOutput = outputOf(tests);

if (tests.status === 0) {
  const files = testOutput.match(/Test Files\s+(\d+)\s+passed/);
  const cases = testOutput.match(/Tests\s+(\d+)\s+passed/);
  const duration = testOutput.match(/Duration\s+([\d.]+s)/);
  const summary = [
    files && `${files[1]} files`,
    cases && `${cases[1]} tests`,
    duration?.[1],
  ].filter(Boolean);

  console.log(summary.length ? `Tests passed: ${summary.join(', ')}.` : 'Tests passed.');
} else {
  failed = true;
  reportFailure('Tests', tests);
}

const typecheck = runNode(['node_modules/typescript/bin/tsc', '--noEmit']);
if (typecheck.status === 0) {
  console.log('TypeScript check passed.');
} else {
  failed = true;
  reportFailure('TypeScript check', typecheck);
}

if (failed) process.exitCode = 1;
