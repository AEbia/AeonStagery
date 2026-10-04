/**
 * Internal target identity for a project Agent task (ADR0023).
 * The coordinator exposes `targetSceneIdentity: string`; the editor service
 * encodes the full `{ projectId, sceneEntryId, sceneDocumentId }` identity
 * there. These values never enter model messages or tool results.
 */

export interface ProjectAgentTargetIdentityRef {
  readonly projectId: string;
  readonly sceneEntryId: string;
  readonly sceneDocumentId: string;
}

const TARGET_IDENTITY_SEPARATOR = '\u0000';

export function encodeProjectAgentTargetIdentity(
  identity: ProjectAgentTargetIdentityRef,
): string {
  return [
    identity.projectId,
    identity.sceneEntryId,
    identity.sceneDocumentId,
  ].join(TARGET_IDENTITY_SEPARATOR);
}

export function decodeProjectAgentTargetIdentity(
  encoded: string,
): ProjectAgentTargetIdentityRef | null {
  const parts = encoded.split(TARGET_IDENTITY_SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  return {
    projectId: parts[0]!,
    sceneEntryId: parts[1]!,
    sceneDocumentId: parts[2]!,
  };
}
