import type { Live2DPerformanceKind } from '../../engine/runtime/Live2DRuntimeContracts';

export interface PreviewRequest {
  type: 'live2d-preview:play';
  requestId: number;
  modelUrl: string;
  kind: Live2DPerformanceKind;
  key: string;
}

export type PreviewResponse =
  | { type: 'live2d-preview:ready' }
  | { type: 'live2d-preview:close' }
  | { type: 'live2d-preview:played'; requestId: number }
  | { type: 'live2d-preview:error'; requestId: number; message: string };

export function isPreviewRequest(value: unknown): value is PreviewRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'live2d-preview:play'
    && typeof message.requestId === 'number'
    && typeof message.modelUrl === 'string'
    && (message.kind === 'motion' || message.kind === 'expression')
    && typeof message.key === 'string';
}

export function isPreviewResponse(value: unknown): value is PreviewResponse {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'live2d-preview:ready'
    || message.type === 'live2d-preview:close'
    || (typeof message.requestId === 'number'
      && (message.type === 'live2d-preview:played'
        || (message.type === 'live2d-preview:error' && typeof message.message === 'string')));
}
