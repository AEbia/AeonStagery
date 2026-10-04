import type { CollaborativeSceneStateV2 } from '../../api/types/collaboration';
import type {
  CollaborativeCompanionChanges,
  CollaborativeStatementChanges,
} from './CollaborativeYDocStore';
import {
  filterTombstonedCollaborativeRecordsV2,
  type CollaborativeStateTransactionPlanV2,
} from './CollaborativeStateTransactionPlannerV2';

export interface CollaborativeStatePublishPortsV2 {
  publishState(state: CollaborativeSceneStateV2): Promise<void> | void;
  publishStatementChanges?(changes: CollaborativeStatementChanges): Promise<void> | void;
  publishCompanionChanges?(changes: CollaborativeCompanionChanges): Promise<void> | void;
  getState?(): CollaborativeSceneStateV2 | null;
}

export async function executeCollaborativeStatePublishPlanV2(
  plan: CollaborativeStateTransactionPlanV2,
  ports: CollaborativeStatePublishPortsV2,
): Promise<CollaborativeSceneStateV2> {
  switch (plan.kind) {
    case 'noop':
      return plan.state;
    case 'full':
      await ports.publishState(plan.state);
      return plan.state;
    case 'entity':
      switch (plan.entity) {
        case 'statements':
          if (!ports.publishStatementChanges) return publishFullFallbackV2(plan, ports);
          await ports.publishStatementChanges(plan.changes);
          break;
        case 'companions':
          if (!ports.publishCompanionChanges) return publishFullFallbackV2(plan, ports);
          await ports.publishCompanionChanges(plan.changes);
          break;
      }
      return filterTombstonedCollaborativeRecordsV2(ports.getState?.() ?? plan.state);
  }
}

async function publishFullFallbackV2(
  plan: Extract<CollaborativeStateTransactionPlanV2, { kind: 'entity' }>,
  ports: CollaborativeStatePublishPortsV2,
): Promise<CollaborativeSceneStateV2> {
  await ports.publishState(plan.state);
  return plan.state;
}
