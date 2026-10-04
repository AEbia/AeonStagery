type CoreGlobal = {
  Version?: {
    csmGetVersion?: () => number;
  };
  Logging?: {
    csmSetLogFunction?: (fn: ((message: string) => void) | null) => void;
    csmGetLogFunction?: () => ((message: string) => void) | null;
  };
  Memory?: {
    initializeAmountOfMemory?: (size: number) => void;
  };
};

type CubismWindow = Window & typeof globalThis & {
  Live2DCubismCore?: CoreGlobal;
};

function getCubismWindow(): CubismWindow | null {
  if (typeof window === 'undefined') return null;
  return window as CubismWindow;
}

export interface OfficialCubismSdkStatus {
  available: boolean;
  initialized: boolean;
  message: string | null;
}

type CubismFrameworkModule = {
  CubismFramework: {
    startUp: (option?: unknown) => void;
    initialize: () => void;
  };
  Option: new () => {
    logFunction?: (message: string) => void;
    loggingLevel?: number;
  };
};

let startupAttempted = false;
let initialized = false;
let initError: string | null = null;
let frameworkModulePromise: Promise<CubismFrameworkModule> | null = null;

async function loadCubismFrameworkModule(): Promise<CubismFrameworkModule> {
  if (!frameworkModulePromise) {
    frameworkModulePromise = import('@cubism/live2dcubismframework') as Promise<CubismFrameworkModule>;
  }
  return frameworkModulePromise;
}

export function getOfficialCubismSdkStatus(): OfficialCubismSdkStatus {
  const cubismWindow = getCubismWindow();
  const available = !!cubismWindow?.Live2DCubismCore?.Version?.csmGetVersion;
  return {
    available,
    initialized,
    message: available ? initError : '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。',
  };
}

export async function initOfficialCubismWebSdk(): Promise<void> {
  if (initialized) return;

  const cubismWindow = getCubismWindow();
  if (!cubismWindow?.Live2DCubismCore?.Version?.csmGetVersion) {
    initError = '官方 Cubism Web SDK Core 脚本缺失或未加载（/live2dcubismcore.min.js）。';
    throw new Error(initError);
  }

  if (startupAttempted) {
    if (initError) throw new Error(initError);
    return;
  }

  startupAttempted = true;

  try {
    const { CubismFramework, Option } = await loadCubismFrameworkModule();
    const option = new Option();
    option.logFunction = (message: string) => console.debug(`[CubismWeb] ${message}`);
    option.loggingLevel = 1;
    CubismFramework.startUp(option);
    CubismFramework.initialize();
    initialized = true;
    initError = null;
  } catch (error) {
    initError = error instanceof Error
      ? `官方 Cubism Web SDK 初始化失败：${error.message}`
      : '官方 Cubism Web SDK 初始化失败。';
    throw new Error(initError);
  }
}
