import * as Y from 'yjs';
import type {
  CollaborationIdentity,
  CollaborationLeaseClientMessageV2,
  CollaborationLeaseServerMessageV2,
  CollaborationLeaseTargetV2,
  CollaborationPresencePatchV2,
  CollaborationPresenceServerMessageV2,
} from '../../api/types/collaboration';
import {
  encodeCollaborationPresenceClientMessageV2,
  parseCollaborationPresenceServerMessageV2,
} from './CollaborationPresenceProtocol';
import {
  encodeCollaborationLeaseClientMessageV2,
  parseCollaborationLeaseServerMessageV2,
} from './CollaborationLeaseProtocol';
import {
  toCollaborationWebSocketUrl,
  getCollaborationWebSocketProtocols,
  type CollaborationWebSocketLike,
} from './CollaborationTransport';

export interface CollaborationRealtimeChannelV2Options {
  endpoint: string;
  identity?: CollaborationIdentity;
  ydoc: Y.Doc;
  webSocketFactory: (url: string, protocols?: string[]) => CollaborationWebSocketLike;
  applyServerState: () => Promise<void>;
  replaceWithServerState: () => Promise<void>;
  onStateChanged: () => void;
  onPresence: (message: CollaborationPresenceServerMessageV2) => void;
  onLease?: (message: CollaborationLeaseServerMessageV2) => void;
  onServerError: (error: Error) => void;
  onConnectionChanged: (isConnected: boolean) => void;
}

const WEBSOCKET_OPEN = 1;

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
    isRecord(message)
    && message.type === 'collaboration:error'
    && typeof message.message === 'string'
  ) {
    return message.message;
  }
  return null;
}

export class CollaborationRealtimeChannelV2 {
  private socket: CollaborationWebSocketLike | null = null;
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private realtimeWritable = false;
  private hasOpenedRealtime = false;
  private realtimeGeneration = 0;

  constructor(private readonly options: CollaborationRealtimeChannelV2Options) {}

  isConnected(): boolean {
    return this.realtimeWritable && this.socket?.readyState === WEBSOCKET_OPEN;
  }

  updatePresence(patch: CollaborationPresencePatchV2): void {
    if (this.socket?.readyState !== WEBSOCKET_OPEN) return;
    this.socket.send(encodeCollaborationPresenceClientMessageV2(patch));
  }

  /** Send a lease request (acquire / renew / release) to the server. */
  sendLeaseRequest(message: Omit<CollaborationLeaseClientMessageV2, 'schemaVersion'>): void {
    if (this.socket?.readyState !== WEBSOCKET_OPEN) return;
    this.socket.send(encodeCollaborationLeaseClientMessageV2(message));
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
    if (this.socket) return;

    this.setRealtimeWritable(false);
    const generation = ++this.realtimeGeneration;
    const needsResyncBeforeCommit = this.hasOpenedRealtime;
    const socket = this.options.webSocketFactory(toCollaborationWebSocketUrl(
      this.options.endpoint,
      this.options.identity,
    ), getCollaborationWebSocketProtocols(this.options.endpoint));
    socket.binaryType = 'arraybuffer';
    socket.onopen = async () => {
      try {
        if (needsResyncBeforeCommit) {
          await this.options.applyServerState();
        }
        if (this.socket === socket && this.realtimeGeneration === generation && socket.readyState === WEBSOCKET_OPEN) {
          this.setRealtimeWritable(true);
          this.hasOpenedRealtime = true;
        }
      } catch {
        this.setRealtimeWritable(false);
        if (this.socket === socket) {
          socket.close();
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
        const message = parseCollaborationPresenceServerMessageV2(event.data);
        if (message) {
          this.options.onPresence(message);
          return;
        }
        const leaseMessage = parseCollaborationLeaseServerMessageV2(event.data);
        if (leaseMessage) {
          this.options.onLease?.(leaseMessage);
          return;
        }
        return;
      }

      const update = binaryMessageToUint8Array(event.data);
      Y.applyUpdate(this.options.ydoc, update, 'remote');
      this.options.onStateChanged();
    };
    socket.onerror = () => {
      this.setRealtimeWritable(false);
      this.options.onStateChanged();
    };
    socket.onclose = () => {
      this.setRealtimeWritable(false);
      this.socket = null;
      this.detachUpdateHandler();
      this.options.onStateChanged();
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
    this.detachUpdateHandler();
    this.socket?.close();
    this.socket = null;
    this.setRealtimeWritable(false);
    this.realtimeGeneration++;
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
      }
    } catch (error) {
      this.options.onServerError(error instanceof Error ? error : new Error(String(error)));
      if (this.socket === socket && this.realtimeGeneration === generation) {
        this.socket = null;
        this.detachUpdateHandler();
        if (socket.readyState === WEBSOCKET_OPEN) {
          socket.close();
        }
      }
    }
  }

  private setRealtimeWritable(isWritable: boolean): void {
    if (this.realtimeWritable === isWritable) return;
    this.realtimeWritable = isWritable;
    this.options.onConnectionChanged(this.isConnected());
  }
}
