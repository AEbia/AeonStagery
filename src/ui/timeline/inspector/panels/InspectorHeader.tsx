// Action inspector header: back/close, title + time scrubber, lifecycle-peer
// jump, issue badge, seek/copy/delete tools, collaboration warning.
// Pure move of the header JSX from ActionInspector's return block.
import { InlineNumericInput } from '../../FormComponents';
import { IconArrowLeft, IconCopy, IconInfo, IconPlay, IconTrash, IconUsers, IconX } from '../../../icons';
import type { ActionInspectorProps } from '../../ActionInspector';
import type { computeLifecyclePeerInfo } from '../lifecyclePeer';

export interface InspectorHeaderProps {
  presentation?: 'panel' | 'inline';
  closeMode: 'back' | 'close';
  onClose: ActionInspectorProps['onClose'];
  actionId: string;
  actionDisplayName: string;
  inspectorTitle: string;
  actionStart: number;
  actionEnd: number;
  lifecyclePeer: ReturnType<typeof computeLifecyclePeerInfo>;
  jumpToLifecyclePeer: () => void;
  actionIssues: readonly { severity?: string }[];
  actionIssueSeverity: 'error' | 'warning' | null;
  handleSeekToAction: () => void;
  handleCopyAction: () => void;
  deleteAction: ActionInspectorProps['deleteAction'];
  updateAction: ActionInspectorProps['updateAction'];
  collaborationEditingSummary: string | null;
}

export function InspectorHeader(props: InspectorHeaderProps) {
  const {
    closeMode, onClose, actionId, actionDisplayName, inspectorTitle,
    actionStart, actionEnd, lifecyclePeer, jumpToLifecyclePeer,
    actionIssues, actionIssueSeverity, handleSeekToAction, handleCopyAction,
    deleteAction, updateAction, collaborationEditingSummary,
  } = props;
  const isInline = props.presentation === 'inline';
  const effectSummary = actionDisplayName && (
    <div className="selected-action-header__intent">
      当前效果: {actionDisplayName}
    </div>
  );
  const timingMeta = (
    <div className="selected-action-header__meta">
      <InlineNumericInput
        dragLabel="时间"
        step="0.1"
        min="0"
        popoverMin="0"
        popoverMax="60"
        value={actionStart}
        onChange={(v, isTransient) => {
          updateAction(actionId, { time: Math.max(0, v) }, isTransient);
        }}
        className="selected-action-header__time"
      />
      <span>{actionEnd.toFixed(1)}s 结束</span>
      {lifecyclePeer && (
        <>
          <span className="selected-action-header__divider" />
          <button
            type="button"
            className="btn btn--link selected-action-header__peer-jump"
            onClick={jumpToLifecyclePeer}
            title={`${lifecyclePeer.peerLabel} @ ${lifecyclePeer.peerTime.toFixed(1)}s`}
          >
            {lifecyclePeer.peerLabel} · {lifecyclePeer.peerTime.toFixed(1)}s
          </button>
        </>
      )}
      {actionIssueSeverity && (
        <span className={`selected-action-header__issue selected-action-header__issue--${actionIssueSeverity}`}>
          <IconInfo width={11} height={11} />
          {actionIssues.length}
        </span>
      )}
    </div>
  );

  return (
    <>
    <div className="selected-action-header">
      <button
        className="btn btn--icon selected-action-header__back"
        onClick={() => { void onClose(); }}
        title={closeMode === 'back' ? '返回动作列表' : '关闭详情'}
        aria-label={closeMode === 'back' ? '返回动作列表' : '关闭详情'}
      >
        {closeMode === 'back' ? <IconArrowLeft width={16} height={16} /> : <IconX width={16} height={16} />}
      </button>
      <div className="selected-action-header__main">
        {isInline && effectSummary}
        <div className="selected-action-header__title">
          {inspectorTitle}
        </div>
        {isInline ? timingMeta : effectSummary}
      </div>
      <div className="selected-action-header__tools">
        <button className="btn btn--icon" onClick={handleSeekToAction} title="跳到动作起点" aria-label="跳到动作起点">
          <IconPlay width={14} height={14} />
        </button>
        <button className="btn btn--icon" onClick={handleCopyAction} title="复制动作" aria-label="复制动作">
          <IconCopy width={14} height={14} />
        </button>
      </div>
      <button className="btn btn--icon selected-action-header__delete" onClick={() => deleteAction(actionId)} title="删除" aria-label="删除动作">
        <IconTrash width={16} height={16} />
      </button>
      {!isInline && timingMeta}
    </div>

    {collaborationEditingSummary && (
      <div className="selected-action-collaboration-warning" role="status">
        <IconUsers width={13} height={13} />
        <span>{collaborationEditingSummary}</span>
      </div>
    )}
    </>
  );
}
