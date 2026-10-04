import type { Live2DRuntimeFamily } from '../services/collaboration/assets/Live2DModelEntry';
import { describeLive2DModelEntrypoint } from '../services/collaboration/assets/Live2DModelEntry';
import { getOfficialCubismSdkStatus } from './OfficialCubismWebSdk';

/**
 * Positive "confirmed missing" overrides, set by the Cubism 2 runtime
 * availability module (electron/main.ts seeds + renderer bootstrap probes).
 * Unknown stays conservative (`true`) so availability checks never block a
 * working path; consumers only flip these when they hold direct evidence.
 */
const runtimeAvailabilityFlags = {
  cubism2: true,
};

export function setLive2DCubism2RuntimeAvailable(available: boolean): void {
  runtimeAvailabilityFlags.cubism2 = available;
}

export function isLive2DCubism2RuntimeAvailable(): boolean {
  return runtimeAvailabilityFlags.cubism2;
}

export type Live2DAdapterId = 'pixi-live2d-display-cubism2' | 'official-cubism-web' | 'unknown';

export interface Live2DRuntimeDescriptor {
  runtimeFamily: Live2DRuntimeFamily;
  adapterId: Live2DAdapterId;
  supported: boolean;
}

export function resolveLive2DRuntimeDescriptor(modelPath: string, parsedJson?: any): Live2DRuntimeDescriptor {
  const entry = describeLive2DModelEntrypoint(modelPath, parsedJson);

  if (entry.runtimeFamily === 'cubism2' || entry.runtimeFamily === 'wmdl') {
    return {
      runtimeFamily: entry.runtimeFamily,
      adapterId: 'pixi-live2d-display-cubism2',
      supported: runtimeAvailabilityFlags.cubism2,
    };
  }

  if (entry.runtimeFamily === 'cubism3-plus') {
    const sdkStatus = getOfficialCubismSdkStatus();
    return {
      runtimeFamily: 'cubism3-plus',
      adapterId: 'official-cubism-web',
      supported: sdkStatus.available,
    };
  }

  return {
    runtimeFamily: 'unknown',
    adapterId: 'unknown',
    supported: true,
  };
}

export function getUnsupportedLive2DRuntimeMessage(modelPath: string, runtime: Live2DRuntimeDescriptor): string | null {
  if (runtime.supported) return null;
  if (runtime.runtimeFamily === 'cubism2' || runtime.runtimeFamily === 'wmdl') {
    return `Live2D 模型 "${modelPath}" 需要 Cubism 2.1 运行时，但 live2d.min.js 缺失或未加载。`;
  }
  if (runtime.runtimeFamily === 'cubism3-plus') {
    const sdkStatus = getOfficialCubismSdkStatus();
    return `Live2D 模型 "${modelPath}" 需要 Cubism 3/4/5 runtime adapter。${sdkStatus.message ?? '官方 Cubism Web runtime 当前不可用。'}`;
  }
  return `Live2D 模型 "${modelPath}" 使用当前未支持的 runtime。`;
}
