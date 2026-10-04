import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import {
  AEONSTAGERY_PRODUCT_VERSION,
  formatAeonStageryProductLabel,
  formatAeonStageryVersionLabel,
  getAeonStageryProductInfo,
} from '../services/product/ProductInfo';

describe('ProductInfo', () => {
  it('uses package.json as the single version source', () => {
    expect(AEONSTAGERY_PRODUCT_VERSION).toBe(packageJson.version);
    expect(getAeonStageryProductInfo()).toEqual({
      name: 'AeonStagery',
      version: packageJson.version,
      releaseStage: 'beta',
    });
    expect(formatAeonStageryProductLabel()).toBe(`AeonStagery ${packageJson.version} beta`);
  });

  it('exposes one UI version label that never repeats the release stage', () => {
    const label = formatAeonStageryVersionLabel();

    expect(label).toBe(packageJson.version);
    expect(label).not.toMatch(/alpha/i);
    expect(label.toLowerCase().split(/\s+/).filter((token) => token === 'beta')).toHaveLength(
      packageJson.version.toLowerCase().includes('beta') ? 0 : 1,
    );
  });
});
