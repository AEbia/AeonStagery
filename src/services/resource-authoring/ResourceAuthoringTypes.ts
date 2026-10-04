export const RESOURCE_KINDS = [
  'live2dModel',
  'live2dMotion',
  'live2dExpression',
  'background',
  'image',
  'icon',
  'bgm',
  'sfx',
  'voice',
  'animation',
  'font',
  'lut',
  'mask',
] as const;

import type { ResourceKind } from '../../api/types/project';
export type { ResourceKind } from '../../api/types/project';

export interface ResourceKey {
  kind: ResourceKind;
  name: string;
  namespace?: string;
  ownerId?: string;
  outfitId?: string;
}

export type ResourceCandidateSource = 'explicit' | 'alias' | 'outfit' | 'owner' | 'convention';

export interface ResourceCandidate {
  key: ResourceKey;
  namespace: string;
  portablePath: string;
  source: ResourceCandidateSource;
  metadata?: Readonly<Record<string, unknown>>;
}

export type ResourceResolutionDiagnosticCode =
  | 'invalid-input'
  | 'missing-owner'
  | 'not-found'
  | 'ambiguous';

export interface ResourceResolutionDiagnostic {
  code: ResourceResolutionDiagnosticCode;
  message: string;
}

export type ResourceResolution =
  | { status: 'resolved'; input: string; key: ResourceKey; candidate: ResourceCandidate }
  | { status: 'not-found'; input: string; key?: ResourceKey; diagnostics: ResourceResolutionDiagnostic[] }
  | { status: 'ambiguous'; input: string; key: ResourceKey; candidates: ResourceCandidate[]; diagnostics: ResourceResolutionDiagnostic[] };

export interface ResourceResolutionContext {
  kind: ResourceKind;
  ownerId?: string;
  outfitId?: string;
  enabledNamespaces?: readonly string[];
}

export interface ResourceCandidateQuery extends ResourceResolutionContext {
  text?: string;
  includeOtherOwners?: boolean;
  ownerFilter?: string;
  namespaceFilter?: string;
}

export interface ResourceCandidateView {
  candidate: ResourceCandidate;
  displayName: string;
  fullIdentity: string;
  isCurrentOwner: boolean;
  namespaceVisible: boolean;
}
