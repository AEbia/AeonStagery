import { describe, expect, it } from 'vitest';
import {
  actionIdListFromSelection,
  itemPlansFromAgreementProposal,
  buildSemanticCollaborationPresencePatch,
  normalizePresencePlayheadTime,
  shouldPublishPresencePlayhead,
} from '../ui/useSemanticCollaborationSession';

describe('semantic collaboration selection normalization', () => {
  it('converts editor selection maps to selected action ids', () => {
    expect(actionIdListFromSelection({ action_1: true, action_2: false, action_3: true }))
      .toEqual(['action_1', 'action_3']);
  });

  it('keeps iterable action id selections compatible', () => {
    expect(actionIdListFromSelection(new Set(['action_1', 'action_2'])))
      .toEqual(['action_1', 'action_2']);
  });

  it('builds CTI presence patches without clearing timeline pointer presence', () => {
    const patch = buildSemanticCollaborationPresencePatch({
      selectedStatementIds: ['line_1'],
      currentPlayheadTime: 3.25,
      patch: { playheadTime: 3.3 },
    });

    expect(patch).toEqual({
      selectedStatementIds: ['line_1'],
      editingTarget: null,
      playheadTime: 3.3,
    });
    expect(patch).not.toHaveProperty('pointer');
  });

  it('only clears timeline pointer presence when pointer is explicitly patched', () => {
    expect(buildSemanticCollaborationPresencePatch({
      selectedStatementIds: [],
      currentPlayheadTime: 1,
      patch: { pointer: null },
    })).toEqual({
      selectedStatementIds: [],
      editingTarget: null,
      playheadTime: 1,
      pointer: null,
    });
  });

  it('normalizes and throttles CTI presence updates', () => {
    expect(normalizePresencePlayheadTime(1.24)).toBe(1.2);
    expect(normalizePresencePlayheadTime(-1)).toBe(0);
    expect(shouldPublishPresencePlayhead({
      previous: null,
      nextTime: 1,
      now: 100,
    })).toBe(true);
    expect(shouldPublishPresencePlayhead({
      previous: { time: 1, sentAt: 100 },
      nextTime: 1.05,
      now: 150,
    })).toBe(false);
    expect(shouldPublishPresencePlayhead({
      previous: { time: 1, sentAt: 100 },
      nextTime: 1.1,
      now: 150,
    })).toBe(true);
    expect(shouldPublishPresencePlayhead({
      previous: { time: 1, sentAt: 100 },
      nextTime: 1,
      now: 1100,
    })).toBe(true);
  });

  it('converts agreement proposal items into handshake plans', () => {
    const proposal = {
      items: [{
        assetKey: 'background/livehouse.png',
        sourceKind: 'server',
        operation: 'replace',
        problem: {
          severity: 'warning',
          message: '本地同路径文件内容不同',
        },
        filePlans: [{
          relativePath: 'background/livehouse.png',
          sourceKind: 'server',
          operation: 'replace',
        }],
      }],
    } as unknown as import('../services/collaboration/CollaborationAssetHandshake').CollaborationAssetAgreementProposal;

    expect(itemPlansFromAgreementProposal(proposal)).toEqual({
      'background/livehouse.png': {
        sourceKind: 'server',
        operation: 'replace',
        problem: {
          severity: 'warning',
          message: '本地同路径文件内容不同',
        },
        filePlans: [{
          relativePath: 'background/livehouse.png',
          sourceKind: 'server',
          operation: 'replace',
        }],
      },
    });
  });
});
