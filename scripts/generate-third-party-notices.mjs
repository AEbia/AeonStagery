#!/usr/bin/env node
/**
 * AeonStagery — third-party notices generator (ADR-0035).
 *
 *   node scripts/generate-third-party-notices.mjs          # write the notices
 *   node scripts/generate-third-party-notices.mjs --check  # fail when stale
 *
 * The shipped/reachable dependency set is derived from `package-lock.json`:
 * every package that is not marked `dev` is copied into the packaged app's
 * `node_modules`, and the renderer bundle is built from the same dependency
 * tree. `EXTRA_BUNDLED_PACKAGES` covers packages that are bundled into `dist`
 * while being classified as dev dependencies.
 *
 * Output is deterministic (sorted, no timestamps) so `--check` is meaningful.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));

/**
 * Packages bundled into `dist`/`dist-electron` even when classified as dev
 * dependencies (Vite inlines them, so nothing is resolved from node_modules at
 * runtime). Keep this list reviewed and minimal.
 */
const EXTRA_BUNDLED_PACKAGES = [
  // The engine's lazy audio integration resolves this dependency while Vite
  // builds the renderer, even though npm classifies it as a dev dependency.
  '@pixi/sound',
  // The Cubism 2 adapter bundle: MIT code that ships inside the renderer bundle
  // (dev-classified so electron-builder never copies the package — its sibling
  // `dist/cubism.js` / `dist/index.js` entries embed Live2D framework code).
  'untitled-pixi-live2d-engine',
];

const RUNTIME_SETUP_URL =
  'https://github.com/AEbia/aeonstagery#live2d-runtimes-are-not-part-of-the-repository';

/**
 * The lockfile is the primary license source, but a few packages omit the
 * `license` field entirely. Values here are read from the package's own
 * `LICENSE` file in `node_modules` and must be verified when the dependency is
 * upgraded.
 */
const LICENSE_OVERRIDES = {
  // node_modules/parse-cache-control/LICENSE: BSD-style text
  // "Copyright (c) 2012-2014, Walmart and other contributors" with the
  // "Neither the name of Walmart nor the names of its contributors" clause.
  'parse-cache-control': 'BSD-3-Clause',
};

/** Human-readable normalisation for license strings that are not SPDX ids. */
function normalizeLicense(license) {
  if (!license) return null;
  if (license.startsWith("Standard 'no charge' license")) return 'GreenSock Standard License';
  return license;
}

function installedPackageLicense(packageName) {
  const manifestPath = path.join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return normalizeLicense(typeof manifest.license === 'string' ? manifest.license : null);
  } catch {
    return null;
  }
}

function installedPackageLicenseText(packageName) {
  const packageRoot = path.join(projectRoot, 'node_modules', ...packageName.split('/'));
  for (const fileName of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    const licensePath = path.join(packageRoot, fileName);
    if (fs.existsSync(licensePath) && fs.statSync(licensePath).isFile()) {
      return fs.readFileSync(licensePath, 'utf8').trimEnd();
    }
  }
  throw new Error(`Bundled package ${packageName} has no readable LICENSE/COPYING file.`);
}

const NOTICES_PATH = path.join(projectRoot, 'THIRD_PARTY_NOTICES.md');
const SHIPPED_COPY_PATH = path.join(projectRoot, 'public', 'licenses', 'third-party-notices.md');

const packages = lock.packages ?? {};

function entryName(entryKey, entry) {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  const index = entryKey.lastIndexOf(marker);
  if (index < 0) return entryKey;
  return entryKey.slice(index + marker.length);
}

function resolveLicense(name, entry) {
  const override = LICENSE_OVERRIDES[name];
  if (override) return override;
  const fromLock = normalizeLicense(entry.license);
  if (fromLock && fromLock !== 'UNKNOWN') return fromLock;
  return installedPackageLicense(name) ?? 'UNKNOWN — verify manually';
}

function collectShipped() {
  const shipped = new Map();
  for (const [entryKey, entry] of Object.entries(packages)) {
    if (!entryKey || entryKey === '') continue;
    if (entry.dev === true) continue;
    const name = entryName(entryKey, entry);
    if (!name) continue;
    shipped.set(name, {
      name,
      version: entry.version ?? 'unknown',
      license: resolveLicense(name, entry),
      resolved: entry.resolved ?? '',
    });
  }
  for (const name of EXTRA_BUNDLED_PACKAGES) {
    if (shipped.has(name)) continue;
    const entryKey = Object.keys(packages).find((key) => entryName(key, packages[key]) === name);
    if (!entryKey) throw new Error(`Bundled package ${name} is missing from package-lock.json.`);
    const entry = packages[entryKey];
    shipped.set(name, {
      name,
      version: entry.version ?? 'unknown',
      license: resolveLicense(name, entry),
      resolved: entry.resolved ?? '',
    });
  }
  return [...shipped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const shipped = collectShipped();

const licenseCounts = new Map();
for (const item of shipped) {
  licenseCounts.set(item.license, (licenseCounts.get(item.license) ?? 0) + 1);
}

const lines = [];
lines.push('# Third-Party Notices');
lines.push('');
lines.push(`AeonStagery itself is licensed under the Apache License 2.0 (see \`LICENSE\`).`);
lines.push('');
lines.push(
  'This file lists third-party components that are either copied into the packaged application '
  + '(`node_modules`) or bundled into the built renderer/main bundles. Each component remains under '
  + 'its own license; the Apache-2.0 license of AeonStagery does not apply to them.',
);
lines.push('');
lines.push('## Who is NOT bundled');
lines.push('');
lines.push(
  'Live2D Cubism Core scripts (`live2d.min.js`, `live2dcubismcore.min.js`) are **never** '
  + 'part of a release build. They are proprietary Live2D '
  + 'software and must be obtained and staged locally by the user. Only the internal verification '
  + 'build (`npm run dist:win:verify`) contains them, and that build must never be redistributed.',
);
lines.push('');
lines.push('The Cubism 3/4/5 framework and shaders are bundled through `untitled-pixi-live2d-engine/cubism`; no external SDK checkout is required. Live2D-derived framework code remains subject to Live2D license terms.');
lines.push('');
lines.push('## License summary');
lines.push('');
lines.push('| License | Packages |');
lines.push('| --- | --- |');
for (const [license, count] of [...licenseCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`| ${license} | ${count} |`);
}
lines.push('');
lines.push('## Bundled / shipped packages');
lines.push('');
lines.push('| Package | Version | License | Source |');
lines.push('| --- | --- | --- | --- |');
for (const item of shipped) {
  const source = item.resolved ? `[npm](${item.resolved})` : '—';
  lines.push(`| \`${item.name}\` | ${item.version} | ${item.license} | ${source} |`);
}
lines.push('');

const unverified = shipped.filter((item) => item.license.startsWith('UNKNOWN'));
if (unverified.length > 0) {
  lines.push('### Licenses that need manual confirmation');
  lines.push('');
  lines.push('The following packages declare no license in `package-lock.json` or in their installed `package.json`. '
    + 'Read their bundled license text and add an entry to `LICENSE_OVERRIDES` in '
    + '`scripts/generate-third-party-notices.mjs`:');
  lines.push('');
  for (const item of unverified) {
    lines.push(`- \`${item.name}\`@${item.version} — inspect \`node_modules/${item.name}/LICENSE*\``);
  }
  lines.push('');
}
lines.push('## Components requiring specific attention');
lines.push('');
lines.push('### FFmpeg (`ffmpeg-static`)');
lines.push('');
lines.push('- License: **GPL-3.0-or-later** (the binary and the `ffmpeg-static` wrapper package).');
lines.push('- Usage boundary: AeonStagery only ever executes FFmpeg as a **separate child process** '
  + '(`spawn` / `execFile`). It is not linked into the application, so AeonStagery remains '
  + 'Apache-2.0 while the FFmpeg executable keeps its own GPL-3.0 terms.');
lines.push('- Binary source: `ffmpeg-static` release builds — Windows x64 from '
  + '[gyan.dev](https://www.gyan.dev/ffmpeg/builds/), Linux from '
  + '[johnvansickle.com](https://johnvansickle.com/ffmpeg/), macOS from '
  + '[evermeet.cx](https://evermeet.cx/ffmpeg/) / [osxexperts.net](https://osxexperts.net/).');
lines.push('- Corresponding FFmpeg source: <https://git.ffmpeg.org/ffmpeg.git> and '
  + '<https://ffmpeg.org/download.html>. The full GPL-3.0 text ships in '
  + '`public/licenses/ffmpeg/GPL-3.0.txt`; `node_modules/ffmpeg-static/ffmpeg.exe.LICENSE` is '
  + 'copied into the packaged app alongside the binary.');
lines.push('- Users may point the exporter at their own FFmpeg build instead of the bundled binary.');
lines.push('');
lines.push('### GSAP (GreenSock Animation Platform)');
lines.push('');
lines.push('- License: **GreenSock Standard License** (`no charge` license), which is not an OSI '
  + 'license and does not permit selling the library itself. It is bundled into the renderer '
  + 'bundle as an animation runtime.');
lines.push('- License text: <https://gsap.com/standard-license/>.');
lines.push('');
lines.push('### Fonts');
lines.push('');
lines.push('- JetBrains Mono, Noto Sans SC and Outfit are bundled under the SIL Open Font License '
  + '1.1; the full texts ship in `public/licenses/fonts/`.');
lines.push('');
lines.push('### Live2D runtimes (user-supplied)');
lines.push('');
lines.push('- `live2d.min.js` (Cubism 2.1 core) and `live2dcubismcore.min.js` (Cubism 3/4/5 Core) '
  + 'are covered by Live2D Inc. license terms; see '
  + '<https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html> and '
  + '<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>.');
lines.push(`- They are staged locally by the user (see <${RUNTIME_SETUP_URL}>) and are the `
  + 'user\'s responsibility to license.');
lines.push('');
lines.push('## License texts for separately bundled packages');
lines.push('');
lines.push(
  'These packages are bundled into the renderer from development dependencies, so their '
  + 'license files are reproduced here rather than relying on packaged `node_modules` files.',
);
lines.push('');
for (const packageName of EXTRA_BUNDLED_PACKAGES) {
  const item = shipped.find((candidate) => candidate.name === packageName);
  if (!item) throw new Error(`Bundled package ${packageName} is missing from the generated notices.`);
  lines.push(`### ${packageName}@${item.version} (${item.license})`);
  lines.push('');
  lines.push('```text');
  lines.push(installedPackageLicenseText(packageName));
  lines.push('```');
  lines.push('');
}
lines.push('## Regenerating');
lines.push('');
lines.push('```bash');
lines.push('npm run notices          # regenerate this file');
lines.push('npm run notices:check    # CI: fail when the file is stale');
lines.push('```');
lines.push('');
const generated = lines.join('\n');

const check = process.argv.includes('--check');

if (check) {
  const failures = [];
  for (const target of [NOTICES_PATH, SHIPPED_COPY_PATH]) {
    if (!fs.existsSync(target)) {
      failures.push(`missing: ${path.relative(projectRoot, target)}`);
      continue;
    }
    if (fs.readFileSync(target, 'utf8') !== generated) {
      failures.push(`stale: ${path.relative(projectRoot, target)}`);
    }
  }
  if (failures.length > 0) {
    console.error('[third-party-notices] FAILED:');
    for (const message of failures) console.error(`  - ${message}`);
    console.error('[third-party-notices] run `npm run notices` and commit the result.');
    process.exit(1);
  }
  console.log(`[third-party-notices] up to date (${shipped.length} packages).`);
} else {
  fs.mkdirSync(path.dirname(SHIPPED_COPY_PATH), { recursive: true });
  fs.writeFileSync(NOTICES_PATH, generated, 'utf8');
  fs.writeFileSync(SHIPPED_COPY_PATH, generated, 'utf8');
  console.log(`[third-party-notices] wrote ${shipped.length} packages to THIRD_PARTY_NOTICES.md and public/licenses/.`);
}
