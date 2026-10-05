import * as Y from 'yjs';
import type {
  CollaborationIdentity,
  CollaborationLeaseServerMessageV2,
  CollaborationLeaseTargetV2,
  CollaborationPresencePatchV2,
  CollaborationPresenceServerMessageV2,
  CollaborativeSceneStateV2,
} from '../../api/types/collaboration';
import {
  CollaborationRealtimeChannelV2,
} from './CollaborationRealtimeChannelV2';
import {
  normalizeCollaborationEndpoint,
  getCollaborationAccessToken,
  withCollaborationAccessToken,
  authorizeCollaborationFetch,
  toCollaborationWebSocketUrl,
  type CollaborationWebSocketLike,
} from './CollaborationTransport';
import {
  type CollaborativeCompanionChanges,
  type CollaborativeStatementChanges,
  readCollaborativeStateV2FromYDoc,
  writeCollaborativeCompanionChangesV2ToYDoc,
  writeCollaborativeStatementChangesV2ToYDoc,
  writeCollaborativeStateV2ToYDoc,
} from './CollaborativeYDocStore';
import {
  type CollaborativeAssetFileTransferOptions,
  throwIfTransferAborted,
} from './CollaborativeAssetTransfer';

export type CollaborationStateListenerV2 = (state: CollaborativeSceneStateV2 | null) => void;
export type CollaborationPresenceListenerV2 = (message: CollaborationPresenceServerMessageV2) => void;
export type CollaborationLeaseListenerV2 = (message: CollaborationLeaseServerMessageV2) => void;
export type CollaborationRealtimeConnectionListenerV2 = (isConnected: boolean) => void;
export type CollaborationServerErrorListenerV2 = (error: Error) => void;

export interface CollaborationClientV2Options {
  endpoint: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string, protocols?: string[]) => CollaborationWebSocketLike;
  ydoc?: Y.Doc;
  identity?: CollaborationIdentity;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function encodeAssetPath(projectRelativePath: string): string {
  return projectRelativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function createAssetTransferAbortError(): Error {
  const error = new Error('已取消协作资源传输');
  error.name = 'AbortError';
  return error;
}

export { toCollaborationWebSocketUrl };

export class CollaborationClientV2 {
  readonly endpoint: string;
  readonly identity?: CollaborationIdentity;
  readonly ydoc: Y.Doc;
  private readonly fetchImpl: typeof fetch;
  private readonly useXhrUpload: boolean;
  private readonly accessToken?: string;
  private readonly webSocketFactory: (url: string, protocols?: string[]) => CollaborationWebSocketLike;
  private readonly listeners = new Set<CollaborationStateListenerV2>();
  private readonly presenceListeners = new Set<CollaborationPresenceListenerV2>();
  private readonly leaseListeners = new Set<CollaborationLeaseListenerV2>();
  private readonly realtimeConnectionListeners = new Set<CollaborationRealtimeConnectionListenerV2>();
  private readonly serverErrorListeners = new Set<CollaborationServerErrorListenerV2>();
  private readonly realtimeChannel: CollaborationRealtimeChannelV2;

  constructor(options: CollaborationClientV2Options) {
    this.endpoint = normalizeCollaborationEndpoint(options.endpoint);
    this.accessToken = getCollaborationAccessToken(options.endpoint);
    this.identity = options.identity;
    this.ydoc = options.ydoc ?? new Y.Doc();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('fetch is not available; provide fetchImpl');
    }
    this.useXhrUpload = options.fetchImpl === undefined && typeof XMLHttpRequest !== 'undefined';
    this.fetchImpl = authorizeCollaborationFetch(options.fetchImpl ?? fetchImpl.bind(globalThis), this.accessToken);
    this.webSocketFactory = options.webSocketFactory ?? ((url, protocols) => {
      if (typeof WebSocket === 'undefined') {
        throw new Error('WebSocket is not available; provide webSocketFactory');
      }
      return new WebSocket(url, protocols) as CollaborationWebSocketLike;
    });
    this.realtimeChannel = new CollaborationRealtimeChannelV2({
      endpoint: withCollaborationAccessToken(this.endpoint, this.accessToken),
      identity: this.identity,
      ydoc: this.ydoc,
      webSocketFactory: this.webSocketFactory,
      applyServerState: async () => {
        await this.applyServerYjsState('join');
      },
      replaceWithServerState: async () => {
        await this.replaceWithServerYjsState('resync');
      },
      onStateChanged: () => this.emitState(),
      onPresence: (message) => this.emitPresence(message),
      onLease: (message) => this.emitLease(message),
      onServerError: (error) => this.emitServerError(error),
      onConnectionChanged: () => this.emitRealtimeConnection(),
    });
  }

  subscribe(listener: CollaborationStateListenerV2): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribePresence(listener: CollaborationPresenceListenerV2): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }

  subscribeRealtimeConnection(listener: CollaborationRealtimeConnectionListenerV2): () => void {
    this.realtimeConnectionListeners.add(listener);
    return () => {
      this.realtimeConnectionListeners.delete(listener);
    };
  }

  subscribeErrors(listener: CollaborationServerErrorListenerV2): () => void {
    this.serverErrorListeners.add(listener);
    return () => {
      this.serverErrorListeners.delete(listener);
    };
  }

  getState(): CollaborativeSceneStateV2 | null {
    return readCollaborativeStateV2FromYDoc(this.ydoc);
  }

  isRealtimeConnected(): boolean {
    return this.realtimeChannel.isConnected();
  }

  updatePresence(patch: CollaborationPresencePatchV2): void {
    this.realtimeChannel.updatePresence(patch);
  }

  subscribeLease(listener: CollaborationLeaseListenerV2): () => void {
    this.leaseListeners.add(listener);
    return () => {
      this.leaseListeners.delete(listener);
    };
  }

  /** Atomically request the scoped edit lease for a characterPerformance entity. */
  acquireLease(requestId: string, target: CollaborationLeaseTargetV2): void {
    this.realtimeChannel.acquireLease(requestId, target);
  }

  renewLease(requestId: string, target: CollaborationLeaseTargetV2): void {
    this.realtimeChannel.renewLease(requestId, target);
  }

  releaseLease(requestId: string, target: CollaborationLeaseTargetV2): void {
    this.realtimeChannel.releaseLease(requestId, target);
  }

  async join(): Promise<CollaborativeSceneStateV2 | null> {
    return this.applyServerYjsState('join');
  }

  async seed(state: CollaborativeSceneStateV2): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to seed collaboration room at ${this.endpoint}: ${message}. `
        + 'Check that the tunnel forwards plain HTTP traffic to the host collaboration port.',
      );
    }
    if (!response.ok) {
      let message = `Failed to seed collaboration room: HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the HTTP fallback message.
      }
      throw new Error(message);
    }

    await this.applyServerYjsState('seed');
  }

  async publishState(state: CollaborativeSceneStateV2): Promise<void> {
    this.realtimeChannel.assertWritable();
    writeCollaborativeStateV2ToYDoc(this.ydoc, state, 'local');
    this.emitState();
  }

  async publishStatementChanges(changes: CollaborativeStatementChanges): Promise<void> {
    this.realtimeChannel.assertWritable();
    writeCollaborativeStatementChangesV2ToYDoc(this.ydoc, changes, 'local');
    this.emitState();
  }

  async publishCompanionChanges(changes: CollaborativeCompanionChanges): Promise<void> {
    this.realtimeChannel.assertWritable();
    writeCollaborativeCompanionChangesV2ToYDoc(this.ydoc, changes, 'local');
    this.emitState();
  }

  async uploadAssetFile(
    projectRelativePath: string,
    bytes: Uint8Array,
    options: CollaborativeAssetFileTransferOptions = {},
  ): Promise<void> {
    const url = `${this.endpoint}/assets/${encodeAssetPath(projectRelativePath)}`;
    if (this.useXhrUpload) {
      await this.uploadAssetFileWithXhr(url, projectRelativePath, bytes, options);
      return;
    }
    await this.uploadAssetFileWithFetch(url, projectRelativePath, bytes, options);
  }

  private async uploadAssetFileWithFetch(
    url: string,
    projectRelativePath: string,
    bytes: Uint8Array,
    options: CollaborativeAssetFileTransferOptions,
  ): Promise<void> {
    options.onProgress?.({
      loadedBytes: 0,
      totalBytes: options.totalBytes ?? bytes.byteLength,
    });
    const init: RequestInit = {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: toArrayBuffer(bytes),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      throw new Error(`Failed to upload collaborative asset "${projectRelativePath}": HTTP ${response.status}`);
    }
    options.onProgress?.({
      loadedBytes: bytes.byteLength,
      totalBytes: options.totalBytes ?? bytes.byteLength,
    });
  }

  private async uploadAssetFileWithXhr(
    url: string,
    projectRelativePath: string,
    bytes: Uint8Array,
    options: CollaborativeAssetFileTransferOptions,
  ): Promise<void> {
    if (options.signal?.aborted) {
      throwIfTransferAborted(options.signal);
    }

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const totalBytes = options.totalBytes ?? bytes.byteLength;
      let settled = false;
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', abort);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => {
        xhr.abort();
        finish(createAssetTransferAbortError());
      };

      xhr.open('PUT', url);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      if (this.accessToken) xhr.setRequestHeader('authorization', `Bearer ${this.accessToken}`);
      xhr.upload.onprogress = (event): void => {
        options.onProgress?.({
          loadedBytes: event.loaded,
          totalBytes: event.lengthComputable ? event.total : totalBytes,
        });
      };
      xhr.onload = (): void => {
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(new Error(`Failed to upload collaborative asset "${projectRelativePath}": HTTP ${xhr.status}`));
          return;
        }
        options.onProgress?.({ loadedBytes: bytes.byteLength, totalBytes });
        finish();
      };
      xhr.onerror = (): void => {
        finish(new Error(`Failed to upload collaborative asset "${projectRelativePath}": network error`));
      };
      xhr.onabort = (): void => {
        finish(createAssetTransferAbortError());
      };
      if (options.signal) {
        options.signal.addEventListener('abort', abort, { once: true });
      }
      options.onProgress?.({ loadedBytes: 0, totalBytes });
      xhr.send(toArrayBuffer(bytes));
    });
  }

  async downloadAssetFile(
    projectRelativePath: string,
    options: CollaborativeAssetFileTransferOptions = {},
  ): Promise<Uint8Array> {
    const url = `${this.endpoint}/assets/${encodeAssetPath(projectRelativePath)}`;
    const response = options.signal
      ? await this.fetchImpl(url, { signal: options.signal })
      : await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Failed to download collaborative asset "${projectRelativePath}": HTTP ${response.status}`);
    }
    const headerBytes = Number(response.headers.get('content-length'));
    const totalBytes = Number.isFinite(headerBytes) && headerBytes > 0
      ? headerBytes
      : options.totalBytes ?? 0;
    options.onProgress?.({ loadedBytes: 0, totalBytes });
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      options.onProgress?.({ loadedBytes: bytes.byteLength, totalBytes: totalBytes || bytes.byteLength });
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    while (true) {
      throwIfTransferAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loadedBytes += value.byteLength;
      options.onProgress?.({
        loadedBytes,
        totalBytes: totalBytes || loadedBytes,
      });
    }

    const bytes = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    options.onProgress?.({ loadedBytes, totalBytes: totalBytes || loadedBytes });
    return bytes;
  }

  connectRealtime(): void {
    this.realtimeChannel.connect();
  }

  transactState(
    mutator: (state: CollaborativeSceneStateV2) => CollaborativeSceneStateV2 | void,
    origin = 'local',
  ): CollaborativeSceneStateV2 {
    this.realtimeChannel.assertWritable();
    const current = this.getState();
    if (!current) {
      throw new Error('Cannot transact collaborative state before joining or seeding');
    }

    const draft = cloneJson(current);
    const next = mutator(draft) ?? draft;
    writeCollaborativeStateV2ToYDoc(this.ydoc, next, origin);
    this.emitState();
    return next;
  }

  dispose(): void {
    this.realtimeChannel.dispose();
    this.listeners.clear();
    this.presenceListeners.clear();
    this.realtimeConnectionListeners.clear();
    this.serverErrorListeners.clear();
  }

  private async applyServerYjsState(
    operation: 'join' | 'seed',
  ): Promise<CollaborativeSceneStateV2 | null> {
    const update = await this.fetchServerYjsUpdate(operation);
    Y.applyUpdate(this.ydoc, update, 'remote');
    this.emitState();
    return this.getState();
  }

  private async replaceWithServerYjsState(
    operation: 'join' | 'seed' | 'resync',
  ): Promise<CollaborativeSceneStateV2 | null> {
    const update = await this.fetchServerYjsUpdate(operation);
    const serverDoc = new Y.Doc();
    Y.applyUpdate(serverDoc, update, 'remote');
    const serverState = readCollaborativeStateV2FromYDoc(serverDoc);
    if (!serverState) return null;

    writeCollaborativeStateV2ToYDoc(this.ydoc, serverState, 'remote');
    this.emitState();
    return this.getState();
  }

  private async fetchServerYjsUpdate(operation: 'join' | 'seed' | 'resync'): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/yjs-state`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to ${operation} collaboration room at ${this.endpoint}: ${message}. `
        + 'Check that the tunnel forwards plain HTTP traffic to the host collaboration port.',
      );
    }
    if (response.status === 401) {
      throw new Error('协作密码或访问凭证缺失或失效，请向主持人确认密码或获取新的邀请链接。');
    }
    if (!response.ok) {
      throw new Error(`Failed to ${operation} collaboration room: HTTP ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  private emitState(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  private emitPresence(message: CollaborationPresenceServerMessageV2): void {
    this.presenceListeners.forEach((listener) => listener(message));
  }

  private emitLease(message: CollaborationLeaseServerMessageV2): void {
    this.leaseListeners.forEach((listener) => listener(message));
  }

  private emitServerError(error: Error): void {
    this.serverErrorListeners.forEach((listener) => listener(error));
  }

  private emitRealtimeConnection(): void {
    const isConnected = this.isRealtimeConnected();
    this.realtimeConnectionListeners.forEach((listener) => listener(isConnected));
  }
}
