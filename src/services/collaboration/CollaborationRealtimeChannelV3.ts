import * as Y from 'yjs';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborationConnectionStatus,
  type CollaborationIdentity,
  type CollaborationLeaseClientMessageV3,
  type CollaborationLeaseServerMessageV3,
  type CollaborationLeaseTargetV2,
  type CollaborationPresencePatchV2,
  type CollaborationPresenceServerMessageV3,
} from '../../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V5 } from '../../api/types/semantic-scene';
import {
  encodeCollaborationPresenceClientMessageV3,
  parseCollaborationPresenceServerMessageV3,
} from './CollaborationPresenceProtocol';
import {
  encodeCollaborationLeaseClientMessageV3,
  parseCollaborationLeaseServerMessageV3,
} from './CollaborationLeaseProtocol';
import {
  toCollaborationWebSocketUrl,
  type CollaborationWebSocketLike,
} from './CollaborationTransport';
import { readCollaborativeSchemaVersions } from './CollaborativeYDocStore';
import {
  CollaborationRemoteStateRejectedError,
  CollaborationTransientTransportError,
} from './CollaborationErrors';

export interface CollaborationRealtimeChannelV3Options {
  endpoint: string;
  identity?: CollaborationIdentity;
  ydoc: Y.Doc;
  webSocketFactory: (url: string) => CollaborationWebSocketLike;
  applyServerState: () => Promise<void>;
  replaceWithServerState: () => Promise<void>;
  onStateChanged: () => void;
  onPresence: (message: CollaborationPresenceServerMessageV3) => void;
  onLease?: (message: CollaborationLeaseServerMessageV3) => void;
  onServerError: (error: Error) => void;
  onConnectionChanged: (isConnected: boolean) => void;
  onRealtimeStatusChanged?: (status: CollaborationConnectionStatus) => void;
}

const WEBSOCKET_OPEN = 1;
const MAX_AUTO_RECONNECT_ATTEMPTS = 5;
const AUTO_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

function binaryMessageToUint8Array(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    throw new Error('Blob WebSocket messages are not supported by this client');
  }
  throw new Error('Unsupported collaboration update payload');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseCollaborationServerErrorMessage(data: string): string | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }

  if (
    isRecord(message) &&
    message.type === 'collaboration:error' &&
    typeof message.message === 'string'
  ) {
    return message.message;
  }
  return null;
}

export class CollaborationRealtimeChannelV3 {
  private socket: CollaborationWebSocketLike | null = null;
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private realtimeWritable = false;
  private hasStartedRealtime = false;
  private realtimeGeneration = 0;
  private realtimeStatus: CollaborationConnectionStatus = 'offline';
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectSuppressed = false;
  private disposed = false;

  constructor(private readonly options: CollaborationRealtimeChannelV3Options) {}

  isConnected(): boolean {
    return this.realtimeWritable && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  updatePresence(patch: CollaborationPresencePatchV2): void {
    if (this.socket?.readyState !== WEBSOCKET_OPEN) return;
    this.socket.send(encodeCollaborationPresenceClientMessageV3(patch));
  }

  /** Send a lease request (acquire / renew / release) to the server. */
  sendLeaseRequest(message: Omit<CollaborationLeaseClientMessageV3, 'schemaVersion'>): void {
    if (this.socket?.readyState !== WEBSOCKET_OPEN) return;
    this.socket.send(encodeCollaborationLeaseClientMessageV3(message));
  }

  acquireLease(requestId: string, target: CollaborationLeaseTargetV2): void {
    this.sendLeaseRequest({ type: 'lease:acquire', requestId, target });
  }

  renewLease(requestId: string, target: CollaborationLeaseTargetV2): void {
    this.sendLeaseRequest({ type: 'lease:renew', requestId, target });
  }

  releaseLease(requestId: string, target: CollaborationLeaseTargetV2): void {
    this.sendLeaseRequest({ type: 'lease:release', requestId, target });
  }

  connect(): void {
    if (this.disposed || this.reconnectSuppressed || this.socket) return;
    this.openSocket(this.hasStartedRealtime);
  }

  reconnectNow(): void {
    if (this.disposed) return;
    this.clearRetryTimer();
    this.retryAttempt = 0;
    this.reconnectSuppressed = false;
    this.hasStartedRealtime = true;
    this.closeCurrentSocketSilently();
    this.setRealtimeWritable(false);
    this.setRealtimeStatus('reconnecting');
    this.openSocket(true);
  }

  rejectRemoteState(error: Error): void {
    this.stopForRemoteStateRejection(error, undefined, undefined, false);
  }

  private openSocket(needsResyncBeforeCommit: boolean): void {
    if (this.disposed || this.reconnectSuppressed || this.socket) return;
    const isReconnect = this.hasStartedRealtime;
    this.hasStartedRealtime = true;
    this.setRealtimeWritable(false);
    this.setRealtimeStatus(isReconnect ? 'reconnecting' : 'connecting');
    const generation = ++this.realtimeGeneration;
    let socket: CollaborationWebSocketLike;
    try {
      socket = this.options.webSocketFactory(toCollaborationWebSocketUrl(
        this.options.endpoint,
        this.options.identity,
      ));
    } catch (error) {
      const connectionError = asError(error);
      this.reconnectSuppressed = true;
      this.options.onServerError(connectionError);
      this.setRealtimeStatus('error');
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.onopen = async () => {
      try {
        if (needsResyncBeforeCommit) {
          await this.options.applyServerState();
        }
        if (this.socket === socket && this.realtimeGeneration === generation && socket.readyState === WEBSOCKET_OPEN) {
          this.retryAttempt = 0;
          this.setRealtimeWritable(true);
          this.setRealtimeStatus('connected');
        }
      } catch (error) {
        const connectionError = asError(error);
        if (connectionError instanceof CollaborationTransientTransportError) {
          this.failSocketAndRetry(generation, socket);
        } else {
          const rejected = connectionError instanceof CollaborationRemoteStateRejectedError
            ? connectionError
            : new CollaborationRemoteStateRejectedError(
              `The collaboration server state could not be applied: ${connectionError.message}`,
              connectionError,
            );
          this.stopForRemoteStateRejection(rejected, generation, socket, true);
        }
      }
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const serverErrorMessage = parseCollaborationServerErrorMessage(event.data);
        if (serverErrorMessage) {
          void this.handleCollaborationServerError(serverErrorMessage, generation, socket);
          return;
        }
        const message = parseCollaborationPresenceServerMessageV3(event.data);
        if (message) {
          this.options.onPresence(message);
          return;
        }
        const leaseMessage = parseCollaborationLeaseServerMessageV3(event.data);
        if (leaseMessage) {
          this.options.onLease?.(leaseMessage);
          return;
        }
        return;
      }

      try {
        const update = binaryMessageToUint8Array(event.data);
        this.handleIncomingBinaryUpdate(update, generation, socket);
      } catch (error) {
        this.stopForRemoteStateRejection(
          new CollaborationRemoteStateRejectedError(
            `The collaboration server sent an invalid document update: ${asError(error).message}`,
            error,
          ),
          generation,
          socket,
          true,
        );
      }
    };
    socket.onerror = () => {
      this.failSocketAndRetry(
        generation,
        socket,
      );
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.realtimeGeneration !== generation) return;
      this.setRealtimeWritable(false);
      this.socket = null;
      this.detachUpdateHandler();
      this.options.onStateChanged();
      this.scheduleReconnect();
    };
    this.socket = socket;

    this.updateHandler = (update, origin) => {
      if (origin === 'remote') return;
      const currentSocket = this.socket;
      if (this.isConnected() && currentSocket) {
        currentSocket.send(update);
      }
    };
    this.options.ydoc.on('update', this.updateHandler);

    if (socket.readyState === WEBSOCKET_OPEN) {
      void socket.onopen?.();
    }
  }

  assertWritable(): void {
    if (!this.isConnected()) {
      throw new Error('Cannot publish collaborative changes while realtime connection is not open');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetryTimer();
    this.detachUpdateHandler();
    this.closeCurrentSocketSilently();
    this.setRealtimeWritable(false);
    this.setRealtimeStatus('offline');
  }

  private failSocketAndRetry(
    generation: number,
    socket: CollaborationWebSocketLike,
  ): void {
    if (this.socket !== socket || this.realtimeGeneration !== generation || this.disposed) return;
    this.hasStartedRealtime = true;
    this.setRealtimeWritable(false);
    this.options.onStateChanged();
    this.closeCurrentSocketSilently();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectSuppressed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.retryAttempt >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      this.setRealtimeStatus('offline');
      return;
    }

    const nextAttempt = this.retryAttempt + 1;
    this.setRealtimeStatus('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed || this.reconnectSuppressed || this.socket) return;
      this.retryAttempt = nextAttempt;
      this.openSocket(true);
    }, AUTO_RECONNECT_DELAYS_MS[nextAttempt - 1]);
  }

  private stopForRemoteStateRejection(
    error: Error,
    generation?: number,
    socket?: CollaborationWebSocketLike,
    reportError = true,
  ): void {
    if (socket && (this.socket !== socket || this.realtimeGeneration !== generation)) return;
    this.reconnectSuppressed = true;
    this.clearRetryTimer();
    this.setRealtimeWritable(false);
    this.setRealtimeStatus('error');
    if (reportError) this.options.onServerError(error);
    this.closeCurrentSocketSilently();
  }

  private closeCurrentSocketSilently(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.realtimeGeneration++;
    this.detachUpdateHandler();
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private detachUpdateHandler(): void {
    if (!this.updateHandler) return;
    this.options.ydoc.off('update', this.updateHandler);
    this.updateHandler = null;
  }

  private async handleCollaborationServerError(
    message: string,
    generation: number,
    socket: CollaborationWebSocketLike,
  ): Promise<void> {
    this.setRealtimeWritable(false);
    this.options.onServerError(new Error(message));
    try {
      await this.options.replaceWithServerState();
      if (this.socket === socket && this.realtimeGeneration === generation && socket.readyState === WEBSOCKET_OPEN) {
        this.setRealtimeWritable(true);
        this.setRealtimeStatus('connected');
      }
    } catch (error) {
      const connectionError = asError(error);
      if (connectionError instanceof CollaborationTransientTransportError) {
        this.failSocketAndRetry(generation, socket);
      } else {
        this.stopForRemoteStateRejection(
          connectionError instanceof CollaborationRemoteStateRejectedError
            ? connectionError
            : new CollaborationRemoteStateRejectedError(
              `The collaboration server state could not be restored: ${connectionError.message}`,
              connectionError,
            ),
          generation,
          socket,
          true,
        );
      }
    }
  }

  private setRealtimeWritable(isWritable: boolean): void {
    if (this.realtimeWritable === isWritable) return;
    this.realtimeWritable = isWritable;
    this.options.onConnectionChanged(this.isConnected());
  }

  private setRealtimeStatus(status: CollaborationConnectionStatus): void {
    if (this.realtimeStatus === status) return;
    this.realtimeStatus = status;
    this.options.onRealtimeStatusChanged?.(status);
  }

  private handleIncomingBinaryUpdate(
    update: Uint8Array,
    generation: number,
    socket: CollaborationWebSocketLike,
  ): void {
    // Validate on an isolated fresh document that update does not contain an invalid schema version (e.g. v2 client update)
    const isolatedDoc = new Y.Doc();
    try {
      Y.applyUpdate(isolatedDoc, update);
      const isolatedVersions = readCollaborativeSchemaVersions(isolatedDoc);
      if (
        isolatedVersions.schemaVersion !== null &&
        isolatedVersions.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
      ) {
        this.stopForRemoteStateRejection(
          new CollaborationRemoteStateRejectedError(
            `Rejected update with invalid collaboration schema version: ${isolatedVersions.schemaVersion} (expected ${COLLABORATION_SCHEMA_VERSION_V3})`,
          ),
          generation,
          socket,
          true,
        );
        return;
      }
      if (
        isolatedVersions.sceneSchemaVersion !== null &&
        isolatedVersions.sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V5
      ) {
        this.stopForRemoteStateRejection(
          new CollaborationRemoteStateRejectedError(
            `Rejected update with invalid scene schema version: ${isolatedVersions.sceneSchemaVersion} (expected ${SCENE_SCHEMA_VERSION_V5})`,
          ),
          generation,
          socket,
          true,
        );
        return;
      }
    } finally {
      isolatedDoc.destroy();
    }

    // Validate that merging update into current local state does not violate schemaVersion 3 and sceneSchemaVersion 5
    const testDoc = new Y.Doc();
    try {
      Y.applyUpdate(testDoc, Y.encodeStateAsUpdate(this.options.ydoc));
      Y.applyUpdate(testDoc, update);
      const versions = readCollaborativeSchemaVersions(testDoc);
      if (
        versions.schemaVersion !== null &&
        versions.schemaVersion !== COLLABORATION_SCHEMA_VERSION_V3
      ) {
        this.stopForRemoteStateRejection(
          new CollaborationRemoteStateRejectedError(
            `Rejected update with invalid collaboration schema version: ${versions.schemaVersion} (expected ${COLLABORATION_SCHEMA_VERSION_V3})`,
          ),
          generation,
          socket,
          true,
        );
        return;
      }
      if (
        versions.sceneSchemaVersion !== null &&
        versions.sceneSchemaVersion !== SCENE_SCHEMA_VERSION_V5
      ) {
        this.stopForRemoteStateRejection(
          new CollaborationRemoteStateRejectedError(
            `Rejected update with invalid scene schema version: ${versions.sceneSchemaVersion} (expected ${SCENE_SCHEMA_VERSION_V5})`,
          ),
          generation,
          socket,
          true,
        );
        return;
      }
    } finally {
      testDoc.destroy();
    }

    Y.applyUpdate(this.options.ydoc, update, 'remote');
    this.options.onStateChanged();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
