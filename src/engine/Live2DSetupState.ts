type SetupSceneClock = {
  getCurrentTime(): number;
  transformationProxies?: { get(id: string): import('./actions/types').TransformationProxy | undefined };
};

let scriptEngineForSetup: SetupSceneClock | null = null;

export function setScriptEngineForSetup(engine: SetupSceneClock | null): void {
  scriptEngineForSetup = engine;
}

export function getScriptEngineForSetup(): SetupSceneClock | null {
  return scriptEngineForSetup;
}
