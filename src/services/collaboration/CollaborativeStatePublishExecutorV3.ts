import type { CollaborativeSceneStateV3 } from '../../api/types/collaboration';
import type {
  CollaborativeCompanionChanges,
  CollaborativeStatementChanges,
} from './CollaborativeYDocStore';
import {
  filterTombstonedCollaborativeRecordsV3,
  type CollaborativeStateTransactionPlanV3,
} from './CollaborativeStateTransactionPlannerV3';

export interface CollaborativeStatePublishPortsV3 {
  publishState(state: CollaborativeSceneStateV3): Promise<void> | void;
  publishStatementChanges?(changes: CollaborativeStatementChanges): Promise<void> | void;
  publishCompanionChanges?(changes: CollaborativeCompanionChanges): Promise<void> | void;
  getState?(): CollaborativeSceneStateV3 | null;
}

export async function executeCollaborativeStatePublishPlanV3(
  plan: CollaborativeStateTransactionPlanV3,
  ports: CollaborativeStatePublishPortsV3,
): Promise<CollaborativeSceneStateV3> {
  switch (plan.kind) {
    case 'noop':
      return plan.state;
    case 'full':
      await ports.publishState(plan.state);
      return plan.state;
    case 'entity':
      switch (plan.entity) {
        case 'statements':
          if (!ports.publishStatementChanges) return publishFullFallbackV3(plan, ports);
          await ports.publishStatementChanges(plan.changes);
          break;
        case 'companions':
          if (!ports.publishCompanionChanges) return publishFullFallbackV3(plan, ports);
          await ports.publishCompanionChanges(plan.changes);
          break;
      }
      return filterTombstonedCollaborativeRecordsV3(ports.getState?.() ?? plan.state);
  }
}

async function publishFullFallbackV3(
  plan: Extract<CollaborativeStateTransactionPlanV3, { kind: 'entity' }>,
  ports: CollaborativeStatePublishPortsV3,
): Promise<CollaborativeSceneStateV3> {
  await ports.publishState(plan.state);
  return plan.state;
}
