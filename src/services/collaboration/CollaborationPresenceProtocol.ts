import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
} from '../../api/types/collaboration';
import type {
  CollaborationPresenceClientMessageV2,
  CollaborationPresenceClientMessageV3,
  CollaborationPresencePatchV2,
  CollaborationPresencePeerV2,
  CollaborationPresenceServerMessageV2,
  CollaborationPresenceServerMessageV3,
} from '../../api/types/collaboration';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPresenceEditingTargetV2(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'scene') return true;
  if (value.kind === 'statement') {
    return typeof value.statementId === 'string';
  }
  if (value.kind === 'companion') {
    return typeof value.statementId === 'string' && typeof value.companionId === 'string';
  }
  return (
    value.kind === 'marker'
    || value.kind === 'visualTarget'
    || value.kind === 'segment'
    || value.kind === 'asset'
  ) && typeof value.id === 'string';
}

function isPresencePlayheadTime(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isPresencePingMs(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isPresencePointer(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || value.surface !== 'timeline') return false;
  return typeof value.time === 'number'
    && Number.isFinite(value.time)
    && value.time >= 0
    && (value.trackId === undefined || typeof value.trackId === 'string');
}

export function isCollaborationPresencePatchV2(value: unknown): value is CollaborationPresencePatchV2 {
  return isRecord(value)
    && isStringArray(value.selectedStatementIds)
    && isPresenceEditingTargetV2(value.editingTarget)
    && isPresencePlayheadTime(value.playheadTime)
    && isPresencePointer(value.pointer);
}

export function isCollaborationPresencePeerV2(value: unknown): value is CollaborationPresencePeerV2 {
  return isRecord(value)
    && typeof value.clientId === 'string'
    && typeof value.displayName === 'string'
    && isPresencePingMs(value.pingMs)
    && isCollaborationPresencePatchV2(value);
}

export function isCollaborationPresenceClientMessageV2(value: unknown): value is CollaborationPresenceClientMessageV2 {
  return isRecord(value)
    && value.type === 'presence:update'
    && value.schemaVersion === COLLABORATION_SCHEMA_VERSION_V2
    && isCollaborationPresencePatchV2(value);
}

export function isCollaborationPresenceClientMessageV3(value: unknown): value is CollaborationPresenceClientMessageV3 {
  return isRecord(value)
    && value.type === 'presence:update'
    && value.schemaVersion === COLLABORATION_SCHEMA_VERSION_V3
    && isCollaborationPresencePatchV2(value);
}

export function isCollaborationPresenceClientMessage(
  value: unknown,
): value is CollaborationPresenceClientMessageV2 | CollaborationPresenceClientMessageV3 {
  return isCollaborationPresenceClientMessageV2(value) || isCollaborationPresenceClientMessageV3(value);
}

export function parseCollaborationPresenceServerMessageV2(data: string): CollaborationPresenceServerMessageV2 | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }

  if (
    !isRecord(message)
    || typeof message.type !== 'string'
    || message.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V2
  ) {
    return null;
  }
  if (message.type === 'presence:snapshot') {
    return Array.isArray(message.peers) && message.peers.every(isCollaborationPresencePeerV2)
      ? message as CollaborationPresenceServerMessageV2
      : null;
  }
  if (message.type === 'presence:update') {
    return isCollaborationPresencePeerV2(message.peer) ? message as CollaborationPresenceServerMessageV2 : null;
  }
  if (message.type === 'presence:remove') {
    return typeof message.clientId === 'string' ? message as CollaborationPresenceServerMessageV2 : null;
  }
  return null;
}

export function parseCollaborationPresenceServerMessageV3(data: string): CollaborationPresenceServerMessageV3 | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }

  if (
    !isRecord(message)
    || typeof message.type !== 'string'
    || message.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
  ) {
    return null;
  }
  if (message.type === 'presence:snapshot') {
    return Array.isArray(message.peers) && message.peers.every(isCollaborationPresencePeerV2)
      ? message as CollaborationPresenceServerMessageV3
      : null;
  }
  if (message.type === 'presence:update') {
    return isCollaborationPresencePeerV2(message.peer) ? message as CollaborationPresenceServerMessageV3 : null;
  }
  if (message.type === 'presence:remove') {
    return typeof message.clientId === 'string' ? message as CollaborationPresenceServerMessageV3 : null;
  }
  return null;
}

export function encodeCollaborationPresenceClientMessageV2(
  patch: CollaborationPresencePatchV2,
): string {
  const message: CollaborationPresenceClientMessageV2 = {
    type: 'presence:update',
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    ...patch,
  };
  return JSON.stringify(message);
}

export function encodeCollaborationPresenceClientMessageV3(
  patch: CollaborationPresencePatchV2,
): string {
  const message: CollaborationPresenceClientMessageV3 = {
    type: 'presence:update',
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    ...patch,
  };
  return JSON.stringify(message);
}
