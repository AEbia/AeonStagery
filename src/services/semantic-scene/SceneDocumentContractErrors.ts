export class UnknownSceneFieldError extends Error {
  readonly record: Record<string, unknown>;
  readonly field: string;
  readonly path: string;

  constructor(
    record: Record<string, unknown>,
    field: string,
    path: string,
    allowed?: readonly string[],
  ) {
    super(`Unknown field at ${path}.${field}${allowed ? `. Allowed fields: ${allowed.join(', ')}` : ''}`);
    this.name = 'UnknownSceneFieldError';
    this.record = record;
    this.field = field;
    this.path = `${path}.${field}`;
  }
}

export class UnknownSceneDiscriminatorError extends Error {
  readonly path: string;
  readonly value: string;
  readonly expected?: readonly string[];

  constructor(
    path: string,
    value: string,
    expected?: readonly string[],
    message?: string,
  ) {
    super(message ?? `Invalid value at ${path}: "${value}". Expected ${expected?.join(', ') ?? 'a known discriminator'}`);
    this.name = 'UnknownSceneDiscriminatorError';
    this.path = path;
    this.value = value;
    this.expected = expected;
  }
}
