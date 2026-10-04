#!/usr/bin/env node
/**
 * AeonStagery — one deterministic packaging entry point per Live2D runtime mode
 * (ADR-0035).
 *
 *   node scripts/package.mjs none   [--dir] [--win] [--linux] [--mac] [--no-build]
 *   node scripts/package.mjs verify [--dir] [--win] [--linux] [--mac] [--no-build]
 *
 * Stages the requested runtime mode, builds, packages with the matching
 * electron-builder configuration and then proves the result with the packaging
 * gates. `none` is the only mode that may be released publicly.
 *
 * Output directories: `release/` for `none`, `release/verify/` for `verify`.
 * Keeping the verification build out of `release/` means the update manifest it
 * generates for its own feed can never shadow the release manifest.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRuntimeMode, RUNTIME_MODES } from './lib/live2dRuntimeStaging.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const mode = positional[0] ?? 'none';
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const skipBuild = flags.has('--no-build');

const packageModes = ['none', 'verify'];
if (!packageModes.includes(mode)) {
  console.error(`[package] mode must be one of ${packageModes.join(', ')} (got "${mode}")`);
  process.exit(1);
}
if (!RUNTIME_MODES.includes(mode)) {
  console.error(`[package] unknown staging mode "${mode}"`);
  process.exit(1);
}

const targetFlags = ['--win', '--linux', '--mac'].filter((flag) => flags.has(flag));
if (targetFlags.length === 0) targetFlags.push('--win');
if (flags.has('--dir')) targetFlags.push('--dir');

function run(label, args, options = {}) {
  console.log(`\n[package] ${label}: ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    console.error(`[package] ${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// 1. Stage the runtime for this mode. `none` ignores LIVE2D_CUBISM2_CORE /
//    CUBISM_WEB_SDK_DIR entirely, so an ambient variable can never leak a
//    proprietary runtime into a release package.
try {
  const manifest = applyRuntimeMode({
    projectRoot,
    mode,
    env: process.env,
    log: (message) => console.log(message),
  });
  console.log(
    `[package] staged runtime mode=${manifest.mode} cubism2=${manifest.families.cubism2} `
    + `cubism3Plus=${manifest.families.cubism3Plus}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// 2. Build the renderer + main bundles.
if (!skipBuild) {
  run('renderer build', [path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')]);
  run('vite build', [
    path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build',
  ]);
}

// 3. Gate the staged sources + built bundle before packaging.
run('runtime gate', [
  path.join(projectRoot, 'scripts', 'verify-live2d-runtime.mjs'),
  `--mode=${mode}`,
]);

// 4. Package.
const electronBuilderArgs = [
  path.join(projectRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
  ...targetFlags,
];
if (mode === 'verify') {
  electronBuilderArgs.push('--config', path.join(projectRoot, 'electron-builder.verify.config.cjs'));
}
// The bundled `publish` provider is the OSS generic feed, so packaging must
// never upload implicitly: release artifacts are uploaded deliberately, and the
// `none` mode in particular must stay un-published by construction.
if (!targetFlags.includes('--dir')) {
  electronBuilderArgs.push('--publish', 'never');
}
run('electron-builder', electronBuilderArgs, {
  env: { AEON_LIVE2D_RUNTIME_MODE: mode },
});

// 5. Gate the produced artifact. The verification mode builds into
//    `release/verify` (see electron-builder.verify.config.cjs) so the manifest
//    it generates can never shadow the release feed.
const outputDir = path.join(projectRoot, 'release', ...(mode === 'verify' ? ['verify'] : []));
const unpackedDir = path.join(
  outputDir,
  targetFlags.includes('--mac') ? 'mac' : targetFlags.includes('--linux') ? 'linux-unpacked' : 'win-unpacked',
);
if (fs.existsSync(unpackedDir)) {
  run('package gate', [
    path.join(projectRoot, 'scripts', 'verify-package-contents.mjs'),
    `--mode=${mode}`,
    `--dir=${unpackedDir}`,
  ]);
} else {
  console.log(`[package] note: ${path.relative(projectRoot, unpackedDir)} not found; skipped the artifact gate.`);
}
