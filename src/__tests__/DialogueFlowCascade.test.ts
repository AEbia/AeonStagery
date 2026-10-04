import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
  type SceneStatement,
} from '../api/types/semantic-scene';
import {
  applyDialogueFlowShift,
  deleteDialogueFlow,
  insertDialogueInChain,
  reorderDialogueFlow,
  reorderDialogueManual,
  insertDialogueFragmentFlow,
  moveDialogueFragmentFlow,
} from '../services/sequential-flow/DialogueFlowCascade';
import { getSceneDocumentCanonicalOrder } from '../services/semantic-scene/SceneDocumentCanonicalOrder';

function makeDocument(statements: SceneStatement[]): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'flow_cascade',
    meta: {
      title: 'Test',
      characters: [{ id: 'tomori', name: '灯' }],
    },
    statements,
  };
}

function dialogue(id: string, time: number, text: string, durationSeconds: number): SceneStatement {
  return {
    id,
    time,
    type: 'dialogue',
    params: { text, durationSeconds, style: 'typewriter' },
  };
}

describe('dialogue fragment cascade', () => {
  it('opens one slot for a fragment while retaining its internal spacing', () => {
    const before = makeDocument([
      dialogue('before', 0, 'Before', 1),
      dialogue('after', 8, 'After', 1),
    ]);
    const inserted = makeDocument([
      before.statements[0],
      dialogue('first', 3, 'First', 1),
      dialogue('second', 5, 'Second', 2),
      before.statements[1],
    ]);
    const result = insertDialogueFragmentFlow(before, inserted, ['first', 'second'], 'normal');
    expect(result.statements.map((statement) => statement.time)).toEqual([0, 3, 5, 12.5]);
    expect(before.statements[1].time).toBe(8);
  });

  it('moves selected dialogues and every downstream statement by the same delta', () => {
    const before = makeDocument([
      dialogue('first', 0, 'First', 1),
      dialogue('second', 3, 'Second', 1),
      dialogue('downstream', 8, 'After', 1),
    ]);
    const result = moveDialogueFragmentFlow(before, ['first', 'second'], 6, 'normal');
    expect(result.statements.map((statement) => [statement.id, statement.time])).toEqual([
      ['first', 6], ['second', 9], ['downstream', 14],
    ]);
    expect(getSceneDocumentCanonicalOrder(result)).toEqual(['first', 'second', 'downstream']);
    expect(result.statements[1].time - result.statements[0].time).toBe(3);
  });

  it('cascades content that follows the moved dialogue', () => {
    const before = makeDocument([
      dialogue('first', 0, 'First', 2),
      { id: 'camera', time: 1, type: 'camera', params: { mode: 'focus', target: 'tomori' } },
      dialogue('last', 7, 'Last', 1),
    ]);
    const result = moveDialogueFragmentFlow(before, ['first'], 5, 'normal');
    expect(result.statements.map((statement) => [statement.id, statement.time])).toEqual([
      ['first', 5], ['camera', 6], ['last', 12],
    ]);
  });

  it('ignores non-dialogue fragments', () => {
    const before = makeDocument([dialogue('first', 0, 'First', 1)]);
    expect(insertDialogueFragmentFlow(before, before, ['unknown'], 'normal')).toBe(before);
  });
});

describe('applyDialogueFlowShift', () => {
  it('shifts all following statements by the slot-end delta when a dialogue duration changes', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '继续。', 2),
    ]);

    const next = applyDialogueFlowShift(
      document,
      'dlg_1',
      dialogue('dlg_1', 0, '你好。', 2.5),
      'normal',
    );

    expect(next.statements.map((statement) => statement.time)).toEqual([0, 4, 7]);
    expect((next.statements[0].params as any).durationSeconds).toBe(2.5);
  });

  it('keeps statements before the edited dialogue untouched', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '第一句。', 1.5),
      dialogue('dlg_2', 3, '第二句。', 1),
      dialogue('dlg_3', 6, '第三句。', 1),
    ]);

    const next = applyDialogueFlowShift(
      document,
      'dlg_2',
      dialogue('dlg_2', 3, '第二句。', 3),
      'normal',
    );

    expect(next.statements[0]).toEqual(document.statements[0]);
    expect(next.statements[1].time).toBe(3);
    expect(next.statements[2].time).toBe(8);
  });

  it('shifts downstream by the time delta when the dialogue time changes', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 3, '第二句。', 1),
      dialogue('dlg_3', 6, '第三句。', 1),
    ]);

    const next = applyDialogueFlowShift(
      document,
      'dlg_2',
      dialogue('dlg_2', 5, '第二句。', 1),
      'normal',
    );

    expect(next.statements[1].time).toBe(5);
    expect(next.statements[2].time).toBe(8);
  });

  it('replaces the statement without shifting when the slot end does not change', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 3, '第二句。', 1),
    ]);

    const next = applyDialogueFlowShift(
      document,
      'dlg_2',
      dialogue('dlg_2', 3, '改成这句。', 1),
      'normal',
    );

    expect(next).not.toBe(document);
    expect(next.statements.map((statement) => statement.time)).toEqual([0, 3]);
    expect((next.statements[1].params as any).text).toBe('改成这句。');
  });

  it('never re-times statements when the edited statement is not dialogue', () => {
    const camera = {
      id: 'cam_1',
      time: 3,
      type: 'camera' as const,
      params: { mode: 'focus' as const, target: 'tomori', durationSeconds: 0.5 },
    };
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      camera,
      dialogue('dlg_2', 6, '继续。', 2),
    ]);

    const next = applyDialogueFlowShift(
      document,
      'cam_1',
      { ...camera, time: 9 },
      'normal',
    );

    expect(next).toBe(document);
  });

  it('returns the same document when the statement id is unknown', () => {
    const document = makeDocument([dialogue('dlg_1', 0, '你好。', 1.5)]);

    const next = applyDialogueFlowShift(
      document,
      'missing',
      dialogue('missing', 0, '你好。', 2),
      'normal',
    );

    expect(next).toBe(document);
  });
});

describe('insertDialogueInChain', () => {
  it('places the new dialogue after the previous slot end and shifts everything downstream', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '继续。', 2),
    ]);

    const next = insertDialogueInChain(
      document,
      dialogue('dlg_new', 0, '插入句。', 1),
      'dlg_2',
      'normal',
    );

    expect(next.statements.map((statement) => statement.time)).toEqual([0, 2, 7.5]);
    expect(next.statements[1].id).toBe('dlg_new');
    expect((next.statements[2].params as any).text).toBe('继续。');
  });

  it('anchors an insertion at the head slot and shifts the old head forward', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 3, '第二句。', 1),
    ]);

    const next = insertDialogueInChain(
      document,
      dialogue('dlg_new', 0, '开头句。', 1.5),
      'dlg_1',
      'normal',
    );

    expect(next.statements[0].id).toBe('dlg_new');
    expect(next.statements.map((statement) => statement.time)).toEqual([0, 2, 5]);
  });

  it('packs the new dialogue right after a non-dialogue statement', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '继续。', 2),
    ]);

    const next = insertDialogueInChain(
      document,
      dialogue('dlg_new', 0, '插入句。', 1),
      'dlg_2',
      'normal',
    );

    expect(next.statements[2].id).toBe('dlg_new');
    expect(next.statements[2].time).toBe(3.5);
    expect(next.statements[3].time).toBe(7.5);
  });

  it('appends after the last slot end when no beforeStatementId is given', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
    ]);

    const next = insertDialogueInChain(
      document,
      dialogue('dlg_new', 0, '末尾句。', 1),
      undefined,
      'normal',
    );

    expect(next.statements[2].id).toBe('dlg_new');
    expect(next.statements[2].time).toBe(3.5);
  });

  it('refuses non-dialogue statements', () => {
    const document = makeDocument([dialogue('dlg_1', 0, '你好。', 1.5)]);

    const next = insertDialogueInChain(
      document,
      {
        id: 'cam_new',
        time: 0,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      undefined,
      'normal',
    );

    expect(next).toBe(document);
  });
});

describe('deleteDialogueFlow', () => {
  it('shifts statements after the deleted dialogue back by its slot span', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '第二句。', 2),
      dialogue('dlg_3', 11, '第三句。', 1),
    ]);

    const next = deleteDialogueFlow(document, ['dlg_2'], 'normal');

    expect(next.statements.map((statement) => statement.id)).toEqual(['dlg_1', 'dlg_3']);
    expect(next.statements.map((statement) => statement.time)).toEqual([0, 8.5]);
  });

  it('shifts by the sum of the deleted spans for multiple deletions', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '第二句。', 2),
      dialogue('dlg_3', 11, '第三句。', 1),
      dialogue('dlg_4', 16, '第四句。', 1.5),
    ]);

    const next = deleteDialogueFlow(document, ['dlg_2', 'dlg_4'], 'normal');

    expect(next.statements.map((statement) => statement.id)).toEqual(['dlg_1', 'dlg_3']);
    expect(next.statements.map((statement) => statement.time)).toEqual([0, 8.5]);
  });

  it('shifts non-dialogue statements downstream of a deleted dialogue', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '继续。', 2),
    ]);

    const next = deleteDialogueFlow(document, ['dlg_1'], 'normal');

    expect(next.statements.map((statement) => statement.time)).toEqual([1, 4]);
  });

  it('ignores non-dialogue and unknown ids', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
    ]);

    const next = deleteDialogueFlow(document, ['cam_1', 'missing'], 'normal');

    expect(next).toBe(document);
  });
});

describe('reorderDialogueFlow', () => {
  it('shifts downstream back at the old slot and forward at the new slot', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '第二句。', 2),
      dialogue('dlg_3', 11, '第三句。', 1),
    ]);

    const next = reorderDialogueFlow(
      document,
      ['dlg_3', 'dlg_1', 'dlg_2'],
      'dlg_3',
      'normal',
    );

    expect(next.statements.map((statement) => statement.id)).toEqual([
      'dlg_3', 'dlg_1', 'cam_1', 'dlg_2',
    ]);
    expect(next.statements[0].time).toBe(0);
    expect(next.statements[1].time).toBe(1.5);
    expect(next.statements[2].time).toBe(4.5);
    expect(next.statements[3].time).toBe(7.5);
  });

  it('shifts the block back by the dragged span when dragging the head to the end', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 3, '第二句。', 2),
      dialogue('dlg_3', 8, '第三句。', 1),
    ]);

    const next = reorderDialogueFlow(
      document,
      ['dlg_2', 'dlg_3', 'dlg_1'],
      'dlg_1',
      'normal',
    );

    expect(next.statements.map((statement) => statement.time)).toEqual([1, 6, 7.5]);
  });

  it('returns the same document for an invalid permutation', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 3, '第二句。', 2),
    ]);

    const missing = reorderDialogueFlow(document, ['dlg_1'], 'dlg_1', 'normal');
    expect(missing).toBe(document);

    const extra = reorderDialogueFlow(
      document,
      ['dlg_1', 'dlg_2', 'dlg_ghost'],
      'dlg_1',
      'normal',
    );
    expect(extra).toBe(document);
  });

  it('keeps non-dialogue statements in the remaining timeline when moving a dialogue to the tail', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '第一句。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '第二句。', 2),
      dialogue('dlg_3', 11, '第三句。', 1),
    ]);

    const next = reorderDialogueFlow(
      document,
      ['dlg_2', 'dlg_3', 'dlg_1'],
      'dlg_1',
      'normal',
    );

    expect(next.statements.map((statement) => statement.id)).toEqual([
      'cam_1', 'dlg_2', 'dlg_3', 'dlg_1',
    ]);
    expect(next.statements.map((statement) => statement.time)).toEqual([1, 4, 9, 10.5]);
  });

  it('does not change a document when the dialogue order is already unchanged', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '第一句。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '第二句。', 2),
    ]);

    expect(reorderDialogueFlow(document, ['dlg_1', 'dlg_2'], 'dlg_2', 'normal')).toBe(document);
  });
});

describe('reorderDialogueManual', () => {
  it('moves the dragged dialogue to the midpoint between its new neighbours', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '第二句。', 2),
      dialogue('dlg_3', 11, '第三句。', 1),
    ]);

    const next = reorderDialogueManual(document, ['dlg_1', 'dlg_3', 'dlg_2'], 'dlg_3');

    expect(next.statements.map((statement) => statement.id)).toEqual(['dlg_1', 'dlg_3', 'dlg_2']);
    expect(next.statements[1].time).toBe((2 + 6) / 2);
    expect(next.statements[0].time).toBe(0);
    expect(next.statements[2].time).toBe(6);
  });

  it('packs the dragged dialogue right before the next statement when dragged to the head', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '第二句。', 2),
    ]);

    const next = reorderDialogueManual(document, ['dlg_2', 'dlg_1'], 'dlg_2');

    expect(next.statements[0].id).toBe('dlg_2');
    expect(next.statements[0].time).toBe(0);
    expect(next.statements[1].time).toBe(0);
  });

  it('packs the dragged dialogue right after the previous slot end when dragged to the tail', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '第二句。', 2),
    ]);

    const next = reorderDialogueManual(document, ['dlg_2', 'dlg_1'], 'dlg_1');

    expect(next.statements[1].id).toBe('dlg_1');
    expect(next.statements[1].time).toBe(6 + 2 + 0.5);
    expect(next.statements[0].time).toBe(6);
  });

  it('returns the same document for an invalid permutation', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '你好。', 1.5),
      dialogue('dlg_2', 6, '第二句。', 2),
    ]);

    expect(reorderDialogueManual(document, ['dlg_1'], 'dlg_1')).toBe(document);
    expect(reorderDialogueManual(document, ['dlg_1', 'dlg_ghost'], 'dlg_1')).toBe(document);
  });

  it('places a moved dialogue after non-dialogue statements when moving it to the tail', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '第一句。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '第二句。', 2),
    ]);

    const next = reorderDialogueManual(document, ['dlg_2', 'dlg_1'], 'dlg_1');

    expect(next.statements.map((statement) => statement.id)).toEqual(['cam_1', 'dlg_2', 'dlg_1']);
    expect(next.statements.map((statement) => statement.time)).toEqual([3, 6, 8.5]);
  });

  it('does not move a dialogue when its requested order is unchanged', () => {
    const document = makeDocument([
      dialogue('dlg_1', 0, '第一句。', 1.5),
      {
        id: 'cam_1',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', target: 'tomori', durationSeconds: 0.5 },
      },
      dialogue('dlg_2', 6, '第二句。', 2),
    ]);

    expect(reorderDialogueManual(document, ['dlg_1', 'dlg_2'], 'dlg_2')).toBe(document);
  });
});
