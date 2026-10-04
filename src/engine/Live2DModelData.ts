import { describeLive2DModelEntrypoint } from '../services/collaboration/assets/Live2DModelEntry';

export interface Live2DModelData {
  motions: string[];
  expressions: string[];
  runtimeFamily: 'cubism2' | 'cubism3-plus' | 'wmdl' | 'unknown';
}

export function extractLive2DModelData(json: any, entrypointPath = ''): Live2DModelData {
  const descriptor = describeLive2DModelEntrypoint(entrypointPath, json);
  let motions: string[] = [];
  let expressions: string[] = [];

  if (json?.FileReferences) {
    if (json.FileReferences.Motions) {
      motions = Object.keys(json.FileReferences.Motions);
    }
    if (json.FileReferences.Expressions && Array.isArray(json.FileReferences.Expressions)) {
      expressions = json.FileReferences.Expressions
        .map((expression: any) => expression.Name || expression.name)
        .filter(Boolean);
    }
  } else {
    if (json?.motions) {
      motions = Object.keys(json.motions);
    }
    if (json?.expressions) {
      if (Array.isArray(json.expressions)) {
        expressions = json.expressions
          .map((expression: any) => expression.name || expression.Name)
          .filter(Boolean);
      } else {
        expressions = Object.keys(json.expressions);
      }
    }
  }

  return {
    motions,
    expressions,
    runtimeFamily: descriptor.runtimeFamily,
  };
}
