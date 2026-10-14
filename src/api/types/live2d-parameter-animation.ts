export type Live2DParameterMetadataSource = 'runtime' | 'sidecar' | 'known-cubism2-default';

export interface Live2DParameterMetadata {
  readonly id: string;
  readonly index?: number;
  readonly label?: string;
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue?: number;
  readonly source: Live2DParameterMetadataSource;
}

export interface Live2DParameterMetadataSidecar {
  readonly schemaVersion: 1;
  readonly model: string;
  readonly parameters: readonly Live2DParameterMetadata[];
}

/** Detached inspection of one loaded model parameter. */
export interface Live2DParameterInspection extends Live2DParameterMetadata {
  readonly index: number;
  readonly label: string;
  readonly value: number;
}

export type Live2DParameterEdit = { readonly id: string; readonly value: number }
  | { readonly index: number; readonly value: number };

export interface Live2DParameterEditResult {
  readonly appliedParameterIds: readonly string[];
}
