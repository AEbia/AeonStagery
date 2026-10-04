import packageJson from '../../../package.json';
import { AEONSTAGERY_RELEASE_STAGE } from '../beta/BetaReleasePolicy';

export const AEONSTAGERY_PRODUCT_NAME = packageJson.build.productName ?? packageJson.name;
export const AEONSTAGERY_PRODUCT_VERSION = packageJson.version;

export function getAeonStageryProductInfo() {
  return {
    name: AEONSTAGERY_PRODUCT_NAME,
    version: AEONSTAGERY_PRODUCT_VERSION,
    releaseStage: AEONSTAGERY_RELEASE_STAGE,
  };
}

export function formatAeonStageryProductLabel(): string {
  const product = getAeonStageryProductInfo();
  return `${product.name} ${product.version} ${product.releaseStage}`;
}

/**
 * Single UI version label: the real package version plus the release stage,
 * without repeating a stage token the version string already carries
 * ("0.8.0-beta" stays "0.8.0-beta" instead of becoming "0.8.0-beta beta").
 */
export function formatAeonStageryVersionLabel(): string {
  const { version, releaseStage } = getAeonStageryProductInfo();
  const normalized = version.replace(/^v/i, '');
  const carriesStage = new RegExp(`(^|[.-])${releaseStage}($|[.-])`, 'i').test(normalized);
  return carriesStage ? normalized : `${normalized} ${releaseStage}`;
}
