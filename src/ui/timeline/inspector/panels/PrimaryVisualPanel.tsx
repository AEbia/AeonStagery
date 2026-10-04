// "Quick adjust" section of primary visual intent blocks (was renderPrimaryVisualPanel).
import React, { type Dispatch, type SetStateAction } from 'react';
import type { ActionInspectorProps } from '../../ActionInspector';
import type { TimelineAction, TimelineScene } from '../../semanticTimelineTypes';
import { recommendVisualIntentInitialParams } from '../../visualIntentAuthoring';

export interface PrimaryVisualPanelProps {
  isPrimaryVisualIntentBlock: boolean;
  isIntegrationVisualAction: boolean;
  actionType: string;
  action: TimelineAction;
  sceneData: TimelineScene;
  actionParams: Record<string, any>;
  actionId: string;
  updateAction: ActionInspectorProps['updateAction'];
  actionDisplayName: string;
  primaryVisualDescription: string;
  visualTargetLabel: string;
  primaryVisualQuickKeys: string[];
  showVisualAdvanced: boolean;
  setShowVisualAdvanced: Dispatch<SetStateAction<boolean>>;
  isAutoMatchingVisual: boolean;
  setIsAutoMatchingVisual: Dispatch<SetStateAction<boolean>>;
  renderParam: (key: string) => React.ReactNode;
}

export function PrimaryVisualPanel(props: PrimaryVisualPanelProps) {
  const {
    isPrimaryVisualIntentBlock, isIntegrationVisualAction, actionType, action, sceneData,
    actionParams, actionId, updateAction, actionDisplayName, primaryVisualDescription,
    visualTargetLabel, primaryVisualQuickKeys, showVisualAdvanced, setShowVisualAdvanced,
    isAutoMatchingVisual, setIsAutoMatchingVisual, renderParam,
  } = props;

const handleAutoMatchPrimaryVisual = async () => {
  if (!isPrimaryVisualIntentBlock || actionType !== 'setCompositeRecipe') {
    return;
  }

  setIsAutoMatchingVisual(true);
  try {
    const nextParams = await recommendVisualIntentInitialParams({
      sceneData,
      actionType,
      anchorTime: action.time || 0,
      baseParams: actionParams,
      scopeCharId:
        actionType === 'setCompositeRecipe' && actionParams.targetId !== 'background'
          ? actionParams.targetId
          : undefined,
    });
    updateAction(actionId, {
      params: {
        ...actionParams,
        ...nextParams,
      },
    });
  } finally {
    setIsAutoMatchingVisual(false);
  }
};


  if (!isPrimaryVisualIntentBlock || isIntegrationVisualAction) return null;

  return (
    <div className="inspector-section">
      <div className="inspector-section-title" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8, marginBottom: 16 }}>
        快速调整
      </div>
      <div style={{
        marginBottom: 16,
        padding: 12,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              {actionDisplayName}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              {primaryVisualDescription}
            </div>
          </div>
          <div style={{ flexShrink: 0, fontSize: 10, color: 'var(--accent-primary)', fontWeight: 700 }}>
            {actionType === 'setCompositeRecipe' ? `对象: ${visualTargetLabel}` : '范围: 全画面'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn--sm"
            onClick={() => { void handleAutoMatchPrimaryVisual(); }}
            disabled={isAutoMatchingVisual}
          >
            {isAutoMatchingVisual ? '正在重新匹配...' : '重新匹配背景'}
          </button>
          <button
            className="btn btn--sm"
            style={{ background: showVisualAdvanced ? 'var(--accent-glow)' : 'transparent' }}
            onClick={() => setShowVisualAdvanced((current) => !current)}
          >
            {showVisualAdvanced ? '收起高级参数' : '显示高级参数'}
          </button>
        </div>
      </div>
      {primaryVisualQuickKeys.map((key) => (
        <React.Fragment key={key}>{renderParam(key)}</React.Fragment>
      ))}
    </div>
  );
}
