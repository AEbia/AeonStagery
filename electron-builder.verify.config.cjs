/**
 * AeonStagery — electron-builder configuration for the INTERNAL verification
 * package (ADR-0035).
 *
 * Differences from the release configuration in `package.json#build`:
 *   - `extraResources` also ships the locally staged Live2D runtimes, so the
 *     two runtime families can be validated end to end;
 *   - the artifact file name is marked `-verify`;
 *   - the output directory is `release/verify`, so the update manifest this
 *     build generates for itself can never overwrite — or be mistaken for —
 *     the release feed in `release/`.
 *
 * The generic `publish` feed from `package.json#build` is inherited rather than
 * nulled out, because that is what makes electron-builder emit
 * `resources/app-update.yml`. The verification build therefore resolves the
 * same `beta` update channel as the release build, so an internal verification
 * machine can exercise the real update path. This publishes nothing:
 * electron-builder never uploads for the `generic` provider, and
 * `scripts/package.mjs` always passes `--publish never`.
 *
 * The app identity (`appId` / `productName`) is deliberately identical to the
 * release build: userData — and therefore any Live2D runtime the user already
 * has under `%APPDATA%/<productName>/live2d-runtime` — must resolve to the same
 * directory so that installing a release build over a verification build (and
 * vice versa) provably preserves it.
 *
 * This artifact must never be redistributed publicly (ADR-0035): it contains
 * Live2D Framework source.
 */
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./package.json');

const projectRoot = __dirname;

const runtimeResources = [
  { from: 'public/live2d.min.js', to: 'live2d-runtime/live2d.min.js' },
  { from: 'public/live2dcubismcore.min.js', to: 'live2d-runtime/live2dcubismcore.min.js' },
  { from: 'public/vendor/cubism-web', to: 'live2d-runtime/vendor/cubism-web' },
];

const missing = [];
for (const resource of runtimeResources) {
  const absolute = path.join(projectRoot, resource.from);
  if (!fs.existsSync(absolute)) {
    missing.push(resource.from);
  }
}
if (missing.length > 0) {
  throw new Error(
    '[electron-builder.verify] Live2D runtime staging is incomplete; missing: '
    + `${missing.join(', ')}. Run \`npm run sync:live2d-runtime -- --mode=verify\` first.`,
  );
}

module.exports = {
  ...pkg.build,
  artifactName: '${productName}-${version}-${arch}-verify.${ext}',
  directories: {
    ...pkg.build.directories,
    output: 'release/verify',
  },
  extraResources: [...(pkg.build.extraResources ?? []), ...runtimeResources],
};
