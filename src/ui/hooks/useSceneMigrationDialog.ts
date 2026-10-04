import { useCallback, useEffect, useState } from 'react';
import type {
  SceneMigrationConfirmationRequest,
  SceneMigrationExperience,
} from '../../services/semantic-scene/SceneMigrationExperience';

/**
 * Wires the SceneMigrationExperience (constructed before React during
 * Bootstrap) to a React confirmation dialog. While a migration request is
 * pending, `request` is present; confirm/cancel settle the adapter so the
 * awaiting open flow resolves.
 */
export function useSceneMigrationDialog(experience?: SceneMigrationExperience) {
  const [request, setRequest] = useState<SceneMigrationConfirmationRequest | null>(null);

  useEffect(() => {
    if (!experience) return undefined;
    const handler = {
      show: (next: SceneMigrationConfirmationRequest) => setRequest(next),
      clear: () => setRequest(null),
    };
    experience.presenterHost.setHandler(handler);
    return () => {
      experience.presenterHost.setHandler(null);
    };
  }, [experience]);

  const confirm = useCallback(() => {
    experience?.confirmation?.complete(true);
  }, [experience]);

  const cancel = useCallback(() => {
    experience?.confirmation?.complete(false);
  }, [experience]);

  return { request, confirm, cancel };
}
