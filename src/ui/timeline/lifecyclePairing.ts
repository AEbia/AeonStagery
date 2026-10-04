import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import {
  sceneStatementDefinitionRegistry,
  type SceneStatementDefinitionRegistry,
} from '../../services/semantic-scene';
import { getSceneDocumentCanonicalOrder } from '../../services/semantic-scene/SceneDocumentCanonicalOrder';

export type LifecyclePairStatus = 'paired' | 'open' | 'superseded-open' | 'orphan-end';

export interface LifecycleSupersession {
  readonly time: number;
  readonly statementOrder: number;
  readonly statementId: string;
}

export interface LifecyclePairRecord {
  readonly statementId: string;
  readonly role: 'start' | 'end';
  readonly typeKey: string;
  readonly stateKey: string;
  readonly time: number;
  readonly statementOrder: number;
  readonly peerId?: string;
  /** Present when a later same-key start replaced this unpaired start. */
  readonly supersededAt?: LifecycleSupersession;
  readonly status: LifecyclePairStatus;
}

export interface LifecyclePairTable {
  readonly byStatementId: ReadonlyMap<string, LifecyclePairRecord>;
  readonly records: readonly LifecyclePairRecord[];
  readonly statementOrderByStatementId: ReadonlyMap<string, number>;
}

export interface BuildLifecyclePairTableOptions {
  readonly registry?: SceneStatementDefinitionRegistry;
  readonly canonicalStatementOrder?: ReadonlyMap<string, number> | readonly string[];
}

export interface LifecycleEndInsertionOrderContext {
  /** Explicit order slot for a not-yet-inserted lifecycle end. Fractional slots are allowed. */
  readonly statementOrder?: number;
  /** Treat the not-yet-inserted lifecycle end as ordered immediately before this statement. */
  readonly beforeStatementId?: string;
  /** Treat the not-yet-inserted lifecycle end as ordered immediately after this statement. */
  readonly afterStatementId?: string;
}

export interface ListEndableLifecyclesAtOptions {
  /**
   * Optional insertion-order context for a pending end statement.
   *
   * Ordinary menu listing intentionally omits this context, so a superseded-open
   * start is not shown at the exact supersession timestamp unless a caller can
   * prove the end will be inserted before the superseding start.
   */
  readonly insertionOrder?: LifecycleEndInsertionOrderContext;
}

export interface ListActiveLifecycleWindowsAtOptions {
  /**
   * Optional insertion-order context for a pending state-span dependency.
   *
   * Ordinary target binding queries intentionally use exclusive peer/supersession
   * boundaries. A caller may provide this when the pending statement will be
   * inserted before the same-time peer end or superseding start.
   */
  readonly insertionOrder?: LifecycleEndInsertionOrderContext;
}

interface BoundaryEvent {
  readonly statement: SceneStatement;
  readonly statementOrder: number;
  readonly role: 'start' | 'end';
  readonly typeKey: string;
  readonly stateKey: string;
}

interface MutableStart {
  readonly statement: SceneStatement;
  readonly statementOrder: number;
  readonly typeKey: string;
  readonly stateKey: string;
  peerId?: string;
  supersededAt?: LifecycleSupersession;
}

function comparePosition(
  left: { time: number; statementOrder: number },
  right: { time: number; statementOrder: number },
): number {
  return left.time - right.time || left.statementOrder - right.statementOrder;
}

function isStrictlyBefore(
  left: { time: number; statementOrder: number },
  right: { time: number; statementOrder: number },
): boolean {
  return comparePosition(left, right) < 0;
}

function compareInsertionOrderToStatement(
  table: LifecyclePairTable,
  insertionOrder: LifecycleEndInsertionOrderContext | undefined,
  statement: { statementId: string; statementOrder: number },
): number | undefined {
  if (!insertionOrder) return undefined;
  if (typeof insertionOrder.statementOrder === 'number') {
    return insertionOrder.statementOrder - statement.statementOrder;
  }
  if (insertionOrder.beforeStatementId === statement.statementId) return -1;
  if (insertionOrder.afterStatementId === statement.statementId) return 1;

  if (insertionOrder.beforeStatementId) {
    const beforeOrder = table.statementOrderByStatementId.get(insertionOrder.beforeStatementId);
    if (beforeOrder !== undefined) {
      return beforeOrder <= statement.statementOrder ? -1 : 1;
    }
  }

  if (insertionOrder.afterStatementId) {
    const afterOrder = table.statementOrderByStatementId.get(insertionOrder.afterStatementId);
    if (afterOrder !== undefined) {
      return afterOrder >= statement.statementOrder ? 1 : -1;
    }
  }

  return undefined;
}

export function resolveLifecycleBoundaryInsertionOrderAt(
  table: LifecyclePairTable,
  startStatementId: string,
  timeSeconds: number,
): LifecycleEndInsertionOrderContext | undefined {
  const record = table.byStatementId.get(startStatementId);
  if (!record || record.role !== 'start') return undefined;

  if (record.status === 'paired' && record.peerId) {
    const peer = table.byStatementId.get(record.peerId);
    if (peer?.time === timeSeconds) return { beforeStatementId: peer.statementId };
  }

  if (record.supersededAt?.time === timeSeconds) {
    return { beforeStatementId: record.supersededAt.statementId };
  }

  return undefined;
}

export function resolvePreferredLifecycleBoundaryInsertionOrderAt(
  table: LifecyclePairTable,
  preferredStartStatementIds: ReadonlySet<string>,
  timeSeconds: number,
): LifecycleEndInsertionOrderContext | undefined {
  if (preferredStartStatementIds.size !== 1) return undefined;
  const [startStatementId] = preferredStartStatementIds;
  if (!startStatementId) return undefined;
  return resolveLifecycleBoundaryInsertionOrderAt(table, startStatementId, timeSeconds);
}

export function createLifecycleStatementOrderMap(
  document: CurrentSceneDocument,
  explicitOrder?: ReadonlyMap<string, number> | readonly string[],
): ReadonlyMap<string, number> {
  const attachedOrder = getSceneDocumentCanonicalOrder(document);
  const requestedOrder = explicitOrder ?? attachedOrder;
  const statementOrderByStatementId = new Map<string, number>();
  const statementIds = new Set(document.statements.map((statement) => statement.id));

  if (requestedOrder && typeof (requestedOrder as ReadonlyMap<string, number>).get === 'function') {
    for (const statement of document.statements) {
      const order = (requestedOrder as ReadonlyMap<string, number>).get(statement.id);
      if (order !== undefined) statementOrderByStatementId.set(statement.id, order);
    }
  } else if (requestedOrder) {
    for (const [order, statementId] of (requestedOrder as readonly string[]).entries()) {
      if (statementIds.has(statementId) && !statementOrderByStatementId.has(statementId)) {
        statementOrderByStatementId.set(statementId, order);
      }
    }
  }

  document.statements.forEach((statement, sourceStatementOrder) => {
    if (!statementOrderByStatementId.has(statement.id)) {
      statementOrderByStatementId.set(statement.id, sourceStatementOrder);
    }
  });
  return statementOrderByStatementId;
}

function startRecord(start: MutableStart): LifecyclePairRecord {
  if (start.peerId) {
    return {
      statementId: start.statement.id,
      role: 'start',
      typeKey: start.typeKey,
      stateKey: start.stateKey,
      time: start.statement.time,
      statementOrder: start.statementOrder,
      peerId: start.peerId,
      ...(start.supersededAt ? { supersededAt: start.supersededAt } : {}),
      status: 'paired',
    };
  }
  return {
    statementId: start.statement.id,
    role: 'start',
    typeKey: start.typeKey,
    stateKey: start.stateKey,
    time: start.statement.time,
    statementOrder: start.statementOrder,
    ...(start.supersededAt ? { supersededAt: start.supersededAt } : {}),
    status: start.supersededAt ? 'superseded-open' : 'open',
  };
}

export function buildLifecyclePairTable(
  document: CurrentSceneDocument | null,
  options: BuildLifecyclePairTableOptions = {},
): LifecyclePairTable {
  if (!document) {
    return {
      byStatementId: new Map(),
      records: [],
      statementOrderByStatementId: new Map(),
    };
  }

  const registry = options.registry ?? sceneStatementDefinitionRegistry;
  const statementOrderByStatementId = createLifecycleStatementOrderMap(
    document,
    options.canonicalStatementOrder,
  );

  const groups = new Map<string, BoundaryEvent[]>();
  for (const statement of document.statements) {
    const lifecycle = registry.timelineLifecyclePresentation(statement);
    if (!lifecycle) continue;
    const typeKey = lifecycle.definition.presentationTypeKey;
    const groupKey = `${typeKey}\0${lifecycle.stateKey}`;
    const list = groups.get(groupKey) ?? [];
    list.push({
      statement,
      statementOrder: statementOrderByStatementId.get(statement.id)!,
      role: lifecycle.boundary,
      typeKey,
      stateKey: lifecycle.stateKey,
    });
    groups.set(groupKey, list);
  }

  const byStatementId = new Map<string, LifecyclePairRecord>();

  for (const events of groups.values()) {
    events.sort((left, right) => (
      comparePosition(
        { time: left.statement.time, statementOrder: left.statementOrder },
        { time: right.statement.time, statementOrder: right.statementOrder },
      ) || left.statement.id.localeCompare(right.statement.id)
    ));

    // All unpaired starts in this key group (replacement/last-writer windows).
    const unpairedStarts: MutableStart[] = [];

    for (const event of events) {
      if (event.role === 'start') {
        const previous = unpairedStarts[unpairedStarts.length - 1];
        if (previous && !previous.peerId) {
          previous.supersededAt = {
            time: event.statement.time,
            statementOrder: event.statementOrder,
            statementId: event.statement.id,
          };
        }
        unpairedStarts.push({
          statement: event.statement,
          statementOrder: event.statementOrder,
          typeKey: event.typeKey,
          stateKey: event.stateKey,
        });
        continue;
      }

      const endPos = { time: event.statement.time, statementOrder: event.statementOrder };
      // Latest unpaired start that can accept this end (last-writer within window).
      let matchIndex = -1;
      for (let i = unpairedStarts.length - 1; i >= 0; i -= 1) {
        const candidate = unpairedStarts[i];
        if (candidate.peerId) continue;
        const startPos = { time: candidate.statement.time, statementOrder: candidate.statementOrder };
        if (!isStrictlyBefore(startPos, endPos)) continue;
        if (candidate.supersededAt && !isStrictlyBefore(endPos, candidate.supersededAt)) continue;
        matchIndex = i;
        break;
      }

      if (matchIndex < 0) {
        byStatementId.set(event.statement.id, {
          statementId: event.statement.id,
          role: 'end',
          typeKey: event.typeKey,
          stateKey: event.stateKey,
          time: event.statement.time,
          statementOrder: event.statementOrder,
          status: 'orphan-end',
        });
        continue;
      }

      const matched = unpairedStarts[matchIndex];
      matched.peerId = event.statement.id;
      byStatementId.set(matched.statement.id, startRecord(matched));
      byStatementId.set(event.statement.id, {
        statementId: event.statement.id,
        role: 'end',
        typeKey: event.typeKey,
        stateKey: event.stateKey,
        time: event.statement.time,
        statementOrder: event.statementOrder,
        peerId: matched.statement.id,
        status: 'paired',
      });
    }

    for (const start of unpairedStarts) {
      if (byStatementId.has(start.statement.id)) continue;
      byStatementId.set(start.statement.id, startRecord(start));
    }
  }

  const records = [...byStatementId.values()].sort((left, right) => (
    comparePosition(left, right) || left.statementId.localeCompare(right.statementId)
  ));

  return {
    byStatementId,
    records,
    statementOrderByStatementId,
  };
}

export function resolveLifecyclePair(
  table: LifecyclePairTable,
  statementId: string,
): LifecyclePairRecord | undefined {
  return table.byStatementId.get(statementId);
}

/**
 * End commands: open or superseded-open starts endable at T.
 * Menu listing uses time only: T must be strictly before supersededAt.time when present.
 * Equal-time order anchors are handled by insertLifecycleEnd helper.
 */
export function listEndableLifecyclesAt(
  table: LifecyclePairTable,
  timeSeconds: number,
  options: ListEndableLifecyclesAtOptions = {},
): readonly LifecyclePairRecord[] {
  return table.records.filter((record) => {
    if (record.role !== 'start') return false;
    if (record.status !== 'open' && record.status !== 'superseded-open') return false;
    if (record.time > timeSeconds) return false;
    if (record.time === timeSeconds) {
      const comparedToStart = compareInsertionOrderToStatement(
        table,
        options.insertionOrder,
        record,
      );
      if (comparedToStart !== undefined && comparedToStart <= 0) return false;
    }
    if (record.supersededAt) {
      if (timeSeconds > record.supersededAt.time) return false;
      if (timeSeconds === record.supersededAt.time) {
        const comparedToSupersedingStart = compareInsertionOrderToStatement(
          table,
          options.insertionOrder,
          record.supersededAt,
        );
        if (comparedToSupersedingStart === undefined || comparedToSupersedingStart >= 0) {
          return false;
        }
      }
    }
    return true;
  });
}

/**
 * Target binding: paired until peer end, plus open/superseded-open windows.
 */
export function listActiveLifecycleWindowsAt(
  table: LifecyclePairTable,
  timeSeconds: number,
  options: ListActiveLifecycleWindowsAtOptions = {},
): readonly LifecyclePairRecord[] {
  return table.records.filter((record) => {
    if (record.role !== 'start') return false;
    if (record.time > timeSeconds) return false;
    if (record.time === timeSeconds) {
      const comparedToStart = compareInsertionOrderToStatement(
        table,
        options.insertionOrder,
        record,
      );
      if (comparedToStart !== undefined && comparedToStart <= 0) return false;
    }

    if (record.status === 'paired') {
      if (!record.peerId) return false;
      const peer = table.byStatementId.get(record.peerId);
      if (!peer) return false;
      if (timeSeconds < peer.time) return true;
      if (timeSeconds === peer.time) {
        const comparedToPeerEnd = compareInsertionOrderToStatement(
          table,
          options.insertionOrder,
          peer,
        );
        return comparedToPeerEnd !== undefined && comparedToPeerEnd < 0;
      }
      return false;
    }

    if (record.status === 'open') return true;

    if (record.status === 'superseded-open') {
      if (!record.supersededAt) return false;
      if (timeSeconds < record.supersededAt.time) return true;
      if (timeSeconds === record.supersededAt.time) {
        const comparedToSupersedingStart = compareInsertionOrderToStatement(
          table,
          options.insertionOrder,
          record.supersededAt,
        );
        return comparedToSupersedingStart !== undefined && comparedToSupersedingStart < 0;
      }
      return false;
    }

    return false;
  });
}
