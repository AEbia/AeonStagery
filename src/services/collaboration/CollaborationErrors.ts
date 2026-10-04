export class CollaborationTransientTransportError extends Error {
  readonly originalError?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CollaborationTransientTransportError';
    this.originalError = cause;
  }
}

export class CollaborationRemoteStateRejectedError extends Error {
  readonly originalError?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CollaborationRemoteStateRejectedError';
    this.originalError = cause;
  }
}
