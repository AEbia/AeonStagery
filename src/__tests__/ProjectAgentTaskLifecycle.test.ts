import { describe, expect, it } from 'vitest';
import type { ProjectAgentHostWriteReceipt } from '../api/types/project-agent';
import {
  buildTurnAbortedProjection,
  ProjectAgentTask,
} from '../services/project-agent/ProjectAgentTask';

function receipt(version: number): ProjectAgentHostWriteReceipt {
  return {
    status: 'committed',
    version,
    counts: {
      insertedStatements: 1,
      insertedCompanions: 0,
      updatedStatements: 0,
      updatedCompanions: 0,
      deletedLines: 0,
      movedLines: 0,
      reorderedCompanionGroups: 0,
      inserted: 1,
      updated: 0,
      deleted: 0,
      moved: 0,
    },
    warnings: [],
    outcomes: [{ kind: 'inserted', statementId: 'st-1' }],
    changedObjects: [{ statementId: 'st-1', kind: 'inserted' }],
  };
}

describe('ProjectAgentTask lifecycle', () => {
  it('starts idle and enters running with lease token', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Polish dialogue',
    });
    expect(task.getExecutionRoundState()).toBe('idle');
    task.markRunning('lease-1');
    expect(task.getExecutionRoundState()).toBe('running');
    expect(task.getLeaseToken()).toBe('lease-1');
    expect(task.isSchedulingAllowed()).toBe(true);
  });

  it('queues user supplements ordered and verbatim without merging', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Do work',
    });
    task.markRunning('L');
    task.enqueueSupplement('first');
    task.enqueueSupplement('second also first');
    const pending = task.peekPendingSupplements();
    expect(pending.map((s) => s.text)).toEqual(['first', 'second also first']);
    task.markSupplementsDelivered([pending[0]!.id]);
    expect(task.peekPendingSupplements().map((s) => s.text)).toEqual(['second also first']);
  });

  it('pauses with recovery facts and releases scheduling', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Do work',
    });
    task.markRunning('L');
    task.requestStopScheduling();
    task.enterPaused('provider_unavailable', { discardedCurrentRound: true });
    expect(task.getExecutionRoundState()).toBe('suspended');
    expect(task.getPauseReason()).toBe('provider_unavailable');
    expect(task.isSchedulingAllowed()).toBe(false);
    expect(task.getLeaseToken()).toBeUndefined();
    expect(task.getPauseRecovery()?.discardedCurrentRound).toBe(true);
  });

  it('rejects zero-write complete without related read', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Check scene',
    });
    task.markRunning('L');
    const gate = task.canCompleteTask();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('zero_write_requires_related_read');
  });

  it('allows zero-write round settlement after related read and marks no_changes', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Check scene',
    });
    task.markRunning('L');
    task.recordSuccessfulRelatedRead();
    const report = task.complete({ summary: 'Already satisfied' });
    expect(task.getExecutionRoundState()).toBe('idle');
    expect(report.hostFacts.lifecycle).toBe('assistant_reply');
    expect(report.hostFacts.completeKind).toBe('no_changes');
    expect(report.hostFacts.zeroWriteComplete).toBe(true);
    expect(report.agentNarrative.summary).toBe('Already satisfied');
  });

  it('clears the prior round settlement when the conversation starts again', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Check scene',
    });
    task.markRunning('first-lease');
    task.recordSuccessfulRelatedRead();
    task.complete({ summary: 'First round complete' });
    expect(task.getSettlementReport()).toBeDefined();

    task.markRunning('second-lease');
    expect(task.getSettlementReport()).toBeUndefined();
    expect(task.getExecutionRoundState()).toBe('running');
  });

  it('requires write receipt round-trip before done settlement after a write', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Edit',
    });
    task.markRunning('L');
    task.recordCommittedWrite(receipt(2));
    expect(task.canCompleteTask().ok).toBe(false);
    task.markWriteReceiptsReturnedToModel();
    expect(task.canCompleteTask().ok).toBe(true);
    const report = task.complete({ summary: 'Done' });
    expect(report.hostFacts.completeKind).toBe('with_changes');
    expect(report.hostFacts.committedChangeCount).toBe(1);
  });

  it('suspends and cancels current execution rounds without terminal lifecycle', () => {
    const suspended = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'X',
    });
    suspended.markRunning('L');
    const br = suspended.block('version_conflict_exhausted', {
      blocker: 'v conflict',
      attemptedAlternatives: ['retry'],
    });
    expect(suspended.getExecutionRoundState()).toBe('suspended');
    expect(br.hostFacts.lifecycle).toBe('assistant_reply');
    expect(br.hostFacts.suspensionReason).toBe('version_conflict_exhausted');

    const cancelled = new ProjectAgentTask({
      taskId: 't2',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'Y',
    });
    cancelled.markRunning('L2');
    cancelled.beginCancelling();
    expect(cancelled.getExecutionRoundState()).toBe('cancelling');
    const cr = cancelled.cancel();
    expect(cancelled.getExecutionRoundState()).toBe('idle');
    expect(cr.hostFacts.lifecycle).toBe('user_cancelled');
  });

  it('distinguishes pause reasons from blocked terminal states', () => {
    const task = new ProjectAgentTask({
      taskId: 't1',
      projectId: 'p1',
      targetSceneIdentity: 'scene-a',
      originalTaskText: 'X',
    });
    task.markRunning('L');
    task.enterPaused('provider_configuration_required', { discardedCurrentRound: true });
    expect(task.isTerminal()).toBe(false);
    expect(task.getExecutionRoundState()).toBe('suspended');
  });

  it('turn_aborted projection describes the interrupted round truthfully for rounds without tool calls', () => {
    const projection = buildTurnAbortedProjection({
      reason: 'application_exit',
      committedDuringInterruption: [],
      unknownOutcome: false,
    });
    // The round may have had no tool calls at all; the wording must not claim
    // "tool results completed" (ADR0023).
    expect(projection).toMatch(/before the round completed/);
    expect(projection).toMatch(/unclosed round was discarded from recoverable history/);
    expect(projection).not.toMatch(/tool results completed/);
  });
});
