import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const playwrightCli = path.resolve('node_modules/@playwright/test/cli.js');
const playwrightArgs = [
  playwrightCli,
  'test',
  '-c',
  'playwright.e2e.config.ts',
  ...process.argv.slice(2),
];

if (!existsSync(playwrightCli)) {
  console.error(`Playwright CLI not found: ${playwrightCli}`);
  process.exit(1);
}

let command = process.execPath;
let args = playwrightArgs;

if (process.platform === 'linux') {
  const xvfbCheck = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (xvfbCheck.error || xvfbCheck.status !== 0) {
    console.error('Linux E2E tests require xvfb-run. Install the Xvfb package and retry.');
    process.exit(1);
  }

  command = 'xvfb-run';
  args = [
    '--auto-servernum',
    '--server-args=-screen 0 1920x1080x24',
    process.execPath,
    ...playwrightArgs,
  ];
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    WAYLAND_DISPLAY: undefined,
    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
  },
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
