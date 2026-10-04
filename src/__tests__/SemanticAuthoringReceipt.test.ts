import { describe, expect, it } from 'vitest';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { createSemanticAuthorReceipt } from '../services/timeline-authoring/SemanticAuthoringReceipt';

describe('SemanticAuthoringReceipt', () => {
  it('emits statement and companion locators without legacy action id fields', () => {
    const receipt = createSemanticAuthorReceipt({
      correlationId: 'intent_v2',
      intentType: 'insert-dialogue-companion',
      origin: 'timeline-editor',
      historyDescriptor: {
        key: 'timeline.author.insertCompanion',
        args: { statementId: 'line_1' },
        fallbackLabel: 'Insert companion',
      },
      resolvedScope: { kind: 'character', charId: 'tomori' },
      createdStatements: [
        {
          id: 'line_1',
          time: 1,
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: 'Hello',
            durationSeconds: 2,
          },
        },
      ],
      updatedStatements: [
        {
          id: 'camera_1',
          time: 4,
          type: 'camera',
          params: {
            mode: 'focus',
            position: [0.5, 0.5],
            durationSeconds: 0.5,
          },
        },
      ],
      createdCompanions: [
        {
          statementId: 'line_1',
          companion: {
            id: 'focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
            },
          },
        },
      ],
      deletedCompanions: [
        {
          statementId: 'line_1',
          companion: {
            id: 'old_expression',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: '$speaker',
              expression: 'neutral',
            },
          },
        },
      ],
      createdMarkers: [
        { markerId: 'm1', time: 3, label: 'Beat' },
      ],
    });

    expect(receipt).toEqual(expect.objectContaining({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: 'intent_v2',
      intentType: 'insert-dialogue-companion',
      createdStatementIds: ['line_1'],
      updatedStatementIds: ['camera_1'],
      deletedStatementIds: [],
      createdCompanionLocators: [{ statementId: 'line_1', companionId: 'focus' }],
      deletedCompanionLocators: [{ statementId: 'line_1', companionId: 'old_expression' }],
      createdMarkerIds: ['m1'],
      timeRange: { start: 3, end: 4.5 },
    }));
    expect(receipt).not.toHaveProperty('createdActionIds');
    expect(receipt).not.toHaveProperty('updatedActionIds');
    expect(receipt).not.toHaveProperty('deletedActionIds');
  });
});
