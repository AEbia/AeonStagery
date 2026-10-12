import type { Live2DParameterEdit, Live2DParameterEditResult, Live2DParameterInspection } from '../../../api/types/live2d-parameter-animation';
import type { Live2DRuntimeModelControls } from '../../runtime/Live2DRuntimeContracts';

export function createBoundModelParameters(model: object, controls: Live2DRuntimeModelControls) {
  function inspectParameters(): readonly Live2DParameterInspection[] | null {
    const values = controls.getParameterValues(model);
    if (!values) return null;
    const metadata = new Map((controls.getParameterMetadata(model) ?? []).map(parameter => [parameter.id, parameter]));
    return values.map(parameter => ({
      source: 'runtime',
      ...metadata.get(parameter.name),
      id: parameter.name,
      index: parameter.index,
      label: metadata.get(parameter.name)?.label ?? parameter.name,
      value: parameter.value,
    }));
  }

  function editParameters(edits: readonly Live2DParameterEdit[]): Live2DParameterEditResult {
    const parameters = inspectParameters() ?? [];
    const resolved = new Map<string, number>();
    for (const edit of edits) {
      if (!Number.isFinite(edit.value)) continue;
      const parameter = parameters.find(parameter => 'id' in edit
        ? parameter.id === edit.id
        : parameter.index === edit.index);
      if (parameter) resolved.set(parameter.id, edit.value);
    }
    if (resolved.size === 0) return { appliedParameterIds: [] };

    for (const target of controls.getConcreteModels(model)) {
      const available = new Set((controls.getParameterValues(target) ?? []).map(parameter => parameter.name));
      let changed = false;
      for (const [id, value] of resolved) {
        if (!available.has(id)) continue;
        controls.setInjectedParameter(target, id, value);
        changed = true;
      }
      if (!changed) continue;
      // Newer runtimes commit through their bound hook. Plain legacy models
      // have no hook, so commit their Core geometry once after all ID writes.
      if (typeof target.syncInputParameters === 'function') controls.syncInputParameters(target);
      else controls.getCoreModel(target)?.update?.();
    }
    return { appliedParameterIds: [...resolved.keys()] };
  }

  return { inspectParameters, editParameters };
}
