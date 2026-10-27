import type {
  CollaborationLeaseClientMessageV3,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV3,
} from '../../api/types/collaboration';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../api/types/collaboration';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCollaborationLeaseTargetV3(value: unknown): value is CollaborationLeaseTargetV3 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'statement') {
    return typeof value.statementId === 'string' && value.statementId.length > 0;
  }
  if (value.kind === 'companion') {
    return typeof value.statementId === 'string'
      && value.statementId.length > 0
      && typeof value.companionId === 'string'
      && value.companionId.length > 0;
  }
  return false;
}

export function isCollaborationLeaseClientMessageV3(value: unknown): value is CollaborationLeaseClientMessageV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
    || typeof value.requestId !== 'string'
    || value.requestId.length === 0
  ) {
    return false;
  }
  if (value.type !== 'lease:acquire' && value.type !== 'lease:renew' && value.type !== 'lease:release') {
    return false;
  }
  return isCollaborationLeaseTargetV3(value.target);
}

export function isCollaborationLeaseClientMessage(
  value: unknown,
): value is CollaborationLeaseClientMessageV3 {
  return isCollaborationLeaseClientMessageV3(value);
}

export function isCollaborationLeaseServerMessageV3(value: unknown): value is CollaborationLeaseServerMessageV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
  ) {
    return false;
  }
  if (value.type === 'lease:released') {
    return isCollaborationLeaseTargetV3(value.target);
  }
  if (value.type === 'lease:acquired' || value.type === 'lease:denied') {
    if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
    if (!isCollaborationLeaseTargetV3(value.target)) return false;
    if (value.type === 'lease:denied' && typeof value.heldByClientId !== 'string') return false;
    return true;
  }
  return false;
}

export function encodeCollaborationLeaseClientMessageV3(
  message: Omit<CollaborationLeaseClientMessageV3, 'schemaVersion'>,
): string {
  return JSON.stringify({
    type: message.type,
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    requestId: message.requestId,
    target: message.target,
  });
}

export function parseCollaborationLeaseServerMessageV3(data: string): CollaborationLeaseServerMessageV3 | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  return isCollaborationLeaseServerMessageV3(message) ? message : null;
}
