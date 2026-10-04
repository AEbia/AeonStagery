// Paired-lifecycle peer resolution for the inspector header: given the current
// semantic document snapshot and the selected statement, find the paired
// start/end statement to jump to. Pure move of an IIFE from ActionInspector.
import { buildLifecyclePairTable, resolveLifecyclePair } from '../lifecyclePairing';

export function computeLifecyclePeerInfo(
  document: Parameters<typeof buildLifecyclePairTable>[0] | null,
  statementId: string | undefined,
) {
  if (!document || !statementId) return null;
  const table = buildLifecyclePairTable(document);
  const record = resolveLifecyclePair(table, statementId);
  if (!record?.peerId || record.status !== 'paired') return null;
  const peerStatement = document.statements.find((statement) => statement.id === record.peerId);
  if (!peerStatement) return null;
  return {
    peerId: record.peerId,
    role: record.role,
    peerTime: peerStatement.time,
    peerLabel: record.role === 'start' ? '配对结束语句' : '配对开始语句',
  };
}
