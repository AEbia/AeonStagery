/** Shared Cubism 2 clock coordination owned by the Live2D runtime. */

export interface Live2DRuntimeClock {
  getUserTimeMSec(): number;
  setUserTimeMSec(ms: number): void;
}

export interface Live2DClockTransaction {
  readonly token: symbol;
}

interface MutexRequest {
  resolve: () => void;
}

const lockQueue: MutexRequest[] = [];
let isLocked = false;
let activeTransaction: Live2DClockTransaction | null = null;
let activeClock: Live2DRuntimeClock | null = null;
let sharedClockProvider: (() => Live2DRuntimeClock | null) | null = null;

export function registerSharedRuntimeClockProvider(provider: () => Live2DRuntimeClock | null): void {
  sharedClockProvider = provider;
}

export function getSharedRuntimeClock(): Live2DRuntimeClock | null {
  return sharedClockProvider?.() ?? null;
}

export function isSharedRuntimeClockLocked(): boolean {
  return isLocked;
}

export function isSharedRuntimeClockTransactionActive(transaction?: Live2DClockTransaction): boolean {
  return !!transaction && isLocked && activeTransaction?.token === transaction.token;
}

/** Internal runtime access to the clock owned by an active opaque transaction. */
export function getSharedRuntimeClockForTransaction(
  transaction?: Live2DClockTransaction | null,
): Live2DRuntimeClock | null {
  return isSharedRuntimeClockTransactionActive(transaction ?? undefined) ? activeClock : null;
}

export async function acquireSharedRuntimeClockLock(): Promise<void> {
  if (!isLocked) {
    isLocked = true;
    return;
  }
  await new Promise<void>(resolve => lockQueue.push({ resolve }));
}

export function releaseSharedRuntimeClockLock(): void {
  activeTransaction = null;
  activeClock = null;
  const next = lockQueue.shift();
  if (next) next.resolve();
  else isLocked = false;
}

/**
 * Run a Cubism 2 operation against the shared clock. A current transaction
 * token opts into the existing lock; ordinary callers queue behind it.
 */
export async function withSharedRuntimeClock<T>(
  clock: Live2DRuntimeClock | null,
  isCurrent: () => boolean,
  operation: (transaction: Live2DClockTransaction | null) => Promise<T> | T,
  transaction?: Live2DClockTransaction,
): Promise<T | undefined> {
  if (transaction && activeTransaction?.token === transaction.token) {
    if (!isCurrent()) return undefined;
    return operation(transaction);
  }

  await acquireSharedRuntimeClockLock();
  if (!isCurrent()) {
    releaseSharedRuntimeClockLock();
    return undefined;
  }
  const acquired: Live2DClockTransaction = Object.freeze({ token: Symbol('live2d-clock-transaction') });
  activeTransaction = acquired;
  activeClock = clock;
  try {
    return await operation(acquired);
  } finally {
    releaseSharedRuntimeClockLock();
  }
}

/** Advance the shared SDK clock once per ordinary stage frame when available. */
export function advanceSharedRuntimeClock(deltaMs: number): void {
  if (isLocked || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
  const clock = getSharedRuntimeClock();
  if (!clock) return;
  clock.setUserTimeMSec(clock.getUserTimeMSec() + deltaMs);
}

/** Compatibility surface for Bake and legacy runtime helpers during migration. */
export function acquireUtSystemLock(): Promise<void> {
  return acquireSharedRuntimeClockLock();
}

export function releaseUtSystemLock(): void {
  releaseSharedRuntimeClockLock();
}

export function isUtSystemLockActive(): boolean {
  return isSharedRuntimeClockLocked();
}
