import type { Live2DRuntimeClock } from '../live2d/runtime/Live2DRuntimeClockCoordinator';
import type {
  Live2DModelCreateOptions,
  Live2DModelDisplayObject,
  Live2DPerformanceMetadata,
  PerformanceCompatibility,
  PreparedAssetRef,
} from './Live2DRuntimeContracts';

export interface Cubism2Config {
  cubism2?: { maskSize?: number };
}

/** Only the legacy constructor's static surface used by the adapter. */
export interface Cubism2ModelClass {
  config?: unknown;
  from?: (url: string, options: Live2DModelCreateOptions) => Promise<Live2DModelDisplayObject>;
}

function isPropertyContainer(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

export function readSdkProperty(value: unknown, key: string): unknown {
  return isPropertyContainer(value) ? value[key] : undefined;
}

export function isCubism2ModelClass(value: unknown): value is Cubism2ModelClass {
  return isPropertyContainer(value) && (value.from === undefined || typeof value.from === 'function');
}

export function isCubism2Config(value: unknown): value is Cubism2Config {
  if (!isPropertyContainer(value)) return false;
  const config = value.cubism2;
  return config === undefined || (isPropertyContainer(config)
    && (config.maskSize === undefined || typeof config.maskSize === 'number'));
}

export function isRuntimeClock(value: unknown): value is Live2DRuntimeClock {
  return isPropertyContainer(value)
    && typeof value.getUserTimeMSec === 'function'
    && typeof value.setUserTimeMSec === 'function';
}

type ExternalPerformanceMethod = (
  key: string,
  source: PreparedAssetRef,
  metadata?: Live2DPerformanceMetadata,
) => unknown;

type GenericExternalPerformanceMethod = (
  kind: 'motion' | 'expression',
  ...args: Parameters<ExternalPerformanceMethod>
) => unknown;

export function isExternalPerformanceMethod(value: unknown): value is ExternalPerformanceMethod {
  return typeof value === 'function';
}

export function isGenericExternalPerformanceMethod(value: unknown): value is GenericExternalPerformanceMethod {
  return typeof value === 'function';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

export function isPerformanceCompatibility(value: unknown): value is PerformanceCompatibility {
  return isPropertyContainer(value)
    && (value.status === 'compatible' || value.status === 'partial' || value.status === 'incompatible')
    && isStringArray(value.missingParameterIds)
    && isStringArray(value.ignoredParameterIds)
    && isStringArray(value.diagnostics);
}

export function readExpressionNames(definitions: unknown): string[] {
  if (!Array.isArray(definitions)) {
    return isPropertyContainer(definitions) ? Object.keys(definitions) : [];
  }
  return definitions.flatMap((definition: unknown) => {
    const name = readSdkProperty(definition, 'Name');
    return typeof name === 'string' && name ? [name] : [];
  });
}
