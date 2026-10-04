import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../api/types/collaboration';
import type {
  CollaborationLeaseClientMessageV2,
  CollaborationLeaseClientMessageV3,
  CollaborationLeaseServerMessageV2,
  CollaborationLeaseServerMessageV3,
  CollaborationLeaseTargetV2,
} from '../../api/types/collaboration';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCollaborationLeaseTargetV2(value: unknown): value is CollaborationLeaseTargetV2 {
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

export function isCollaborationLeaseClientMessageV2(value: unknown): value is CollaborationLeaseClientMessageV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2
    || typeof value.requestId !== 'string'
    || value.requestId.length === 0
  ) {
    return false;
  }
  if (value.type !== 'lease:acquire' && value.type !== 'lease:renew' && value.type !== 'lease:release') {
    return false;
  }
  return isCollaborationLeaseTargetV2(value.target);
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
  return isCollaborationLeaseTargetV2(value.target);
}

export function isCollaborationLeaseClientMessage(
  value: unknown,
): value is CollaborationLeaseClientMessageV2 | CollaborationLeaseClientMessageV3 {
  return isCollaborationLeaseClientMessageV2(value) || isCollaborationLeaseClientMessageV3(value);
}

export function isCollaborationLeaseServerMessageV2(value: unknown): value is CollaborationLeaseServerMessageV2 {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2
  ) {
    return false;
  }
  if (value.type === 'lease:released') {
    return isCollaborationLeaseTargetV2(value.target);
  }
  if (value.type === 'lease:acquired' || value.type === 'lease:denied') {
    if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
    if (!isCollaborationLeaseTargetV2(value.target)) return false;
    if (value.type === 'lease:denied' && typeof value.heldByClientId !== 'string') return false;
    return true;
  }
  return false;
}

export function isCollaborationLeaseServerMessageV3(value: unknown): value is CollaborationLeaseServerMessageV3 {
  if (
    !isRecord(value)
    || value.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
  ) {
    return false;
  }
  if (value.type === 'lease:released') {
    return isCollaborationLeaseTargetV2(value.target);
  }
  if (value.type === 'lease:acquired' || value.type === 'lease:denied') {
    if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
    if (!isCollaborationLeaseTargetV2(value.target)) return false;
    if (value.type === 'lease:denied' && typeof value.heldByClientId !== 'string') return false;
    return true;
  }
  return false;
}

export function encodeCollaborationLeaseClientMessageV2(
  message: Omit<CollaborationLeaseClientMessageV2, 'schemaVersion'>,
): string {
  return JSON.stringify({ ...message, schemaVersion: COLLABORATION_SCHEMA_VERSION_V2 });
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

export function parseCollaborationLeaseServerMessageV2(data: string): CollaborationLeaseServerMessageV2 | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  return isCollaborationLeaseServerMessageV2(message) ? message : null;
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
