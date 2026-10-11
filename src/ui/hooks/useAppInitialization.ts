import { useEffect, useRef, useState } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import { getLogger } from '../../engine/Logger';

const appLogger = getLogger('App');

export function useAppInitialization(contextValue: BootstrapContext) {
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const [initialized, setInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [defaultProjectName, setDefaultProjectName] = useState('AeonStagery Project');
  const [defaultProjectLocation, setDefaultProjectLocation] = useState('');
  useEffect(() => {
    let mounted = true;

    const initialize = async () => {
      try {
        contextValue.stores.playback.setEngineStatus('initializing');
        const defaultProjectsPath = await window.aeonStageryAPI.app.getDefaultProjectsPath();
        if (!mounted) return;
        setDefaultProjectLocation(defaultProjectsPath.replace(/\\/g, '/'));
        setDefaultProjectName(`AeonStagery Project ${new Date().toISOString().slice(0, 10)}`);

        if (canvasMountRef.current) {
          await contextValue.adapters.stage.mount(canvasMountRef.current);
        }

        if (!mounted) return;
        setInitialized(true);
        contextValue.stores.playback.setEngineStatus('ready');
      } catch (err: unknown) {
        appLogger.error('Failed to initialize application', err);
        if (!mounted) return;
        setInitError(err instanceof Error ? err.message : String(err));
        contextValue.stores.playback.setEngineStatus('error');
      }
    };

    void initialize();
    return () => {
      mounted = false;
    };
  }, [contextValue]);

  useEffect(() => {
    const conversationBridge = window.aeonStageryAPI?.conversation;
    if (!conversationBridge?.onDebugLog) return undefined;
    return conversationBridge.onDebugLog((entry) => {
      console.info(`[LLM debug] ${entry.tag}`, entry.payload);
    });
  }, []);

  return {
    canvasMountRef, initialized, initError, defaultProjectName, defaultProjectLocation,
  };
}
