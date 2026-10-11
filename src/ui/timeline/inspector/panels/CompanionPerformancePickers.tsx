import { useMemo } from 'react';
import type { DialogueCompanion } from '../../../../api/types/semantic-scene';
import { useCharacterAdapter } from '../../../context/AppContext';
import type { TimelineAction, TimelineScene } from '../../semanticTimelineTypes';
import { characterPerformanceMotionKey } from '../dialogueCompanionModel';
import { resolveActiveModelPath } from '../entranceModelOptions';
import { Live2DResourceSelect } from '../Live2DResourceSelect';
import { useCharacterModelData } from '../useModelData';

interface CompanionPerformancePickersProps {
  companion: Extract<DialogueCompanion, { type: 'characterPerformance' }>;
  speakerId?: string;
  atTime: number;
  sceneData: TimelineScene;
  timelineActions: TimelineAction[];
  onChange: (key: string, value: unknown) => void;
}

export function CompanionPerformancePickers({
  companion, speakerId, atTime, sceneData, timelineActions, onChange,
}: CompanionPerformancePickersProps) {
  const characterAdapter = useCharacterAdapter();
  const charId = companion.params.target === '$speaker' ? speakerId : companion.params.target;
  const character = sceneData.meta.characters?.find((item) => item.id === charId);
  const modelPath = useMemo(
    () => charId ? resolveActiveModelPath(sceneData, timelineActions, charId, atTime) : undefined,
    [sceneData, timelineActions, charId, atTime],
  );
  const { modelData, isModelDataLoading } = useCharacterModelData(characterAdapter, modelPath);
  const isCustomMotion = typeof companion.params.motion === 'object' && companion.params.motion?.kind === 'custom';

  return (
    <div className="inspector-grid companion-performance-pickers">
      {isCustomMotion ? (
        <div className="inspector-row">
          <span className="inspector-label">动作</span>
          <span className="inspector-label">自定义动作（选中伴随语句以编辑）</span>
        </div>
      ) : (
        <Live2DResourceSelect
          label="动作"
          value={characterPerformanceMotionKey(companion.params.motion) || ''}
          options={modelData.motions}
          loading={isModelDataLoading}
          charId={charId} character={character} modelPath={modelPath}
          placeholder="选择动作..." clearable clearLabel="（无动作）"
          onChange={(key) => onChange('motion', key ? { kind: 'resource', key } : undefined)}
          onPreview={charId ? (key) => {
            if (key) characterAdapter.playMotion(charId, key);
            else characterAdapter.stopAllMotions(charId);
          } : undefined}
        />
      )}
      <Live2DResourceSelect
        label="表情"
        value={companion.params.expression || ''}
        options={modelData.expressions}
        loading={isModelDataLoading}
        charId={charId} character={character} modelPath={modelPath}
        placeholder="选择表情..." clearable clearLabel="（无表情）"
        onChange={(key) => onChange('expression', key || undefined)}
        onPreview={charId ? (key) => characterAdapter.setExpression(charId, key || '') : undefined}
      />
    </div>
  );
}
