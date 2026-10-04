export type AeonStageryReleaseStage = 'alpha' | 'beta';

/**
 * Single manually-edited release-stage constant for pre-1.0 distribution labels.
 * Do not derive this from build commands, environment variables, or release channels.
 */
export const AEONSTAGERY_RELEASE_STAGE: AeonStageryReleaseStage = 'beta';

export const BETA_WINDOWS_DISTRIBUTION_POLICY = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  installerTarget: 'nsis',
  portableBuild: false,
  codeSigningRequired: false,
  autoUpdatePromised: false,
});
