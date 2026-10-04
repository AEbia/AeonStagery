// Semantic-source editor: camera statement controls, lens-filter template
// pickers, visualStyle target row, and the resource-motion conversion card
// (was renderSemanticSourcePanel).
import React from 'react';
import {
  InlineNumericInput,
  EaseSelect,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { SearchableSelect } from '../../../SearchableSelect';
import { InfoTip } from '../../../Tooltip';
import { IconPlus, IconTrash } from '../../../icons';
import { EASE_OPTIONS, normalizeEaseOptionValue } from '../../FormComponents';
import type { ActionInspectorProps } from '../../ActionInspector';
import type { TimelineAction, TimelineScene } from '../../semanticTimelineTypes';
import type { SemanticInspectorField } from '../../semanticInspectorFieldCatalog';
import { ensureCameraPathKeyframes } from '../../../../services/semantic-scene/SceneStatementDefinitionRegistry';
import { getLensFilterCategory } from '../../../../engine/visual-runtime/BuiltInVisualRecipeCatalog';
import { normalizeFilterSourceParams, LENS_FILTER_CATEGORY_LABELS } from '../filterSourceParams';
import type { CameraPoint } from '../cameraMotionZoom';
import { clampCameraCoordinate, readCameraPoint } from '../cameraMotionZoom';
import type { InspectorParamContext } from '../paramControls/context';

export interface SemanticSourcePanelProps {
  action: TimelineAction;
  actionType: string;
  actionId: string;
  actionParams: Record<string, any>;
  sourceParams: Record<string, any>;
  sceneData: TimelineScene;
  isIntegrationVisualAction: boolean;
  isLensFilterSourceAction: boolean;
  isRimLightVisualAction: boolean;
  visualTargetOptions: InspectorParamContext['visualTargetOptions'];
  rimLightTargetOptions: Array<{ value: string; label: string }>;
  characterVisualTargetOptions: Array<{ value: string; label: string }>;
  filterTemplateOptions: Array<{ value: string; label: string }>;
  activeFilterTemplateOptions: Array<{ value: string; label: string }>;
  semanticInspectorFields: readonly SemanticInspectorField[];
  isResourceMotion: boolean;
  customMotionAuthoring: ReturnType<typeof import('../useCustomMotionAuthoring').useCustomMotionAuthoring>['customMotionAuthoring'];
  characterAdapter: InspectorParamContext['characterAdapter'];
  openConversionDialog: () => void;
  updateParam: ActionInspectorProps['updateParam'];
  replaceSourceParams: ActionInspectorProps['replaceSourceParams'];
  updateSemanticSourceParam: InspectorParamContext['updateSemanticSourceParam'];
  renderParam: (key: string) => React.ReactNode;
}

export function SemanticSourcePanel(props: SemanticSourcePanelProps) {
  const {
    action, actionType, actionId, actionParams, sourceParams, sceneData,
    isIntegrationVisualAction, isLensFilterSourceAction, isRimLightVisualAction,
    visualTargetOptions, rimLightTargetOptions, characterVisualTargetOptions, filterTemplateOptions, activeFilterTemplateOptions,
    semanticInspectorFields, isResourceMotion, customMotionAuthoring, characterAdapter, openConversionDialog,
    updateParam, replaceSourceParams, updateSemanticSourceParam, renderParam,
  } = props;

  if (isIntegrationVisualAction) return null;
  const isLegacyCameraPath = actionType === 'cameraPath' && action.semanticType !== 'camera';
  if (action.semanticType === 'camera' || isLegacyCameraPath) {
    const mode = isLegacyCameraPath ? 'path' : String(actionParams.mode || 'move');
    const updateCameraParam = (key: string, value: unknown, isTransient?: boolean) => {
      updateParam(actionId, key, value, isTransient);
    };
    const renderCameraPoint = (
      label: string,
      point: CameraPoint,
      onChange: (nextPoint: CameraPoint, isTransient?: boolean) => void,
      bounds: { min: string; max: string } = { min: '0', max: '1' },
    ) => {
      const min = Number.parseFloat(bounds.min);
      const max = Number.parseFloat(bounds.max);
      return (
        <div className="inspector-row" key={label}>
          <span className="inspector-label">{label}</span>
          <div className="compound-input grid-row">
            <InlineNumericInput
              ariaLabel={`${label} X`}
              dragLabel="X"
              step="0.01"
              min={bounds.min}
              max={bounds.max}
              value={point[0]}
              onChange={(value, isTransient) => onChange([
                clampCameraCoordinate(value, min, max),
                point[1],
              ], isTransient)}
            />
            <InlineNumericInput
              ariaLabel={`${label} Y`}
              dragLabel="Y"
              step="0.01"
              min={bounds.min}
              max={bounds.max}
              value={point[1]}
              onChange={(value, isTransient) => onChange([
                point[0],
                clampCameraCoordinate(value, min, max),
              ], isTransient)}
            />
          </div>
        </div>
      );
    };
    const renderCameraNumber = (
      label: string,
      key: string,
      value: unknown,
      defaultValue: number,
      step = '0.05',
      min?: string,
      max?: string,
      popoverMin?: string,
      popoverMax?: string,
    ) => (
      <div className="inspector-row" key={key}>
        <span className="inspector-label">{label}</span>
        <InlineNumericInput
          ariaLabel={label}
          dragLabel="值"
          step={step}
          min={min}
          max={max}
          popoverMin={popoverMin}
          popoverMax={popoverMax}
          value={typeof value === 'number' && Number.isFinite(value) ? value : defaultValue}
          onChange={(nextValue, isTransient) => updateCameraParam(key, nextValue, isTransient)}
        />
      </div>
    );
    const renderCameraDuration = (label: string, value: unknown, defaultValue: number, min = '0', popoverMin = '0', popoverMax = '10') => (
      <div className="inspector-row" key="durationSeconds">
        <span className="inspector-label">{label}</span>
        <InlineNumericInput
          ariaLabel={label}
          dragLabel="秒"
          step="0.1"
          min={min}
          popoverMin={popoverMin}
          popoverMax={popoverMax}
          value={typeof value === 'number' && Number.isFinite(value) ? value : defaultValue}
          onChange={(nextValue, isTransient) => updateCameraParam(
            'durationSeconds',
            Math.max(Number.parseFloat(min), nextValue),
            isTransient,
          )}
        />
      </div>
    );
    const renderCameraBoolean = (label: string, key: string, value: unknown, defaultValue: boolean) => {
      const inputId = `action-${actionId}-camera-${key}`;
      return (
        <div className="inspector-row" key={key}>
          <div />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id={inputId}
              type="checkbox"
              checked={typeof value === 'boolean' ? value : defaultValue}
              onChange={(event) => updateCameraParam(key, event.target.checked)}
            />
            <label htmlFor={inputId} className="inspector-label" style={{ margin: 0, textAlign: 'left' }}>{label}</label>
          </div>
        </div>
      );
    };
    const renderCameraSelect = (
      label: string,
      key: string,
      value: unknown,
      options: readonly { value: string; label: string }[],
    ) => (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={`action-${actionId}-camera-${key}`}>{label}</label>
        <FormSelect
          id={`action-${actionId}-camera-${key}`}
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          options={options}
          onChange={(nextValue) => updateCameraParam(key, nextValue)}
        />
      </div>
    );
    const renderCameraTarget = (allowEmpty: boolean) => renderCameraSelect(
      '目标角色',
      'target',
      actionParams.target,
      [
        ...(allowEmpty ? [{ value: '', label: '固定坐标' }] : []),
        ...(sceneData.meta.characters ?? []).map((character) => ({ value: character.id, label: character.name })),
      ],
    );
    const renderCameraTargetPart = () => renderCameraSelect(
      '对焦部位',
      'targetPart',
      actionParams.targetPart || 'chest',
      [
        { value: 'head', label: '头部' },
        { value: 'chest', label: '胸部' },
        { value: 'feet', label: '脚部' },
        { value: 'center', label: '中心' },
      ],
    );
    const zoom = actionParams.zoom && typeof actionParams.zoom === 'object'
      ? actionParams.zoom as { kind?: string; value?: number }
      : { kind: 'absolute', value: 1 };
    const renderCameraZoom = (label: string) => (
      <div className="inspector-row" key="zoom">
        <span className="inspector-label">{label}</span>
        <div className="compound-input">
          <FormSelect
            aria-label={`${label}类型`}
            value={zoom.kind || 'absolute'}
            options={[
              { value: 'absolute', label: '绝对' },
              { value: 'delta', label: '增量' },
            ]}
            onChange={(nextKind) => updateCameraParam('zoom', { kind: nextKind, value: zoom.value ?? 1 })}
          />
          <InlineNumericInput
            ariaLabel={label}
            dragLabel="值"
            step="0.05"
            min={zoom.kind === 'absolute' ? '0' : undefined}
            popoverMin={zoom.kind === 'absolute' ? '0.1' : '-1'}
            popoverMax={zoom.kind === 'absolute' ? '3' : '1'}
            value={typeof zoom.value === 'number' ? zoom.value : 1}
            onChange={(nextValue, isTransient) => updateCameraParam(
              'zoom',
              { kind: zoom.kind || 'absolute', value: nextValue },
              isTransient,
            )}
          />
        </div>
      </div>
    );
    const renderCameraEase = (label: string, value: unknown) => (
      <EaseSelect
        label={label}
        value={typeof value === 'string' ? value : 'smooth'}
        onChange={(nextValue) => updateCameraParam('ease', nextValue)}
      />
    );
    const pathKeyframes = mode === 'path'
      ? ensureCameraPathKeyframes(actionParams.keyframes)
      : [];
    const updatePathKeyframe = (index: number, patch: Record<string, unknown>, isTransient?: boolean) => {
      const nextKeyframes = pathKeyframes.map((keyframe, keyframeIndex) => (
        keyframeIndex === index
          ? Object.fromEntries(
            Object.entries({ ...keyframe, ...patch }).filter(([, value]) => value !== undefined),
          )
          : keyframe
      ));
      updateCameraParam('keyframes', nextKeyframes, isTransient);
    };
    const addPathKeyframe = () => {
      const previous = pathKeyframes[pathKeyframes.length - 1] ?? { time: 0, position: [0.5, 0.5] as const };
      updateCameraParam('keyframes', [
        ...pathKeyframes,
        {
          ...previous,
          time: Math.max(0, (typeof previous.time === 'number' ? previous.time : 0) + 1),
        },
      ]);
    };
    const removePathKeyframe = (index: number) => {
      if (pathKeyframes.length <= 2) return;
      updateCameraParam('keyframes', pathKeyframes.filter((_, keyframeIndex) => keyframeIndex !== index));
    };
    const moveTo = readCameraPoint(actionParams.to ?? actionParams.position);
    const focusPosition = readCameraPoint(actionParams.position);
    const followOffset = readCameraPoint(actionParams.offset, [0, 0], -1, 1);
    return (
      <>
        {mode === 'focus' && (
          <>
            {renderCameraTarget(true)}
            {actionParams.target ? renderCameraTargetPart() : renderCameraPoint(
              '焦点坐标（标准化）',
              focusPosition,
              (nextPoint, isTransient) => updateCameraParam('position', nextPoint, isTransient),
            )}
            {renderCameraZoom('镜头缩放')}
            {renderCameraNumber('旋转角度', 'rotation', actionParams.rotation, 0, '1', undefined, undefined, '-180', '180')}
            {renderCameraDuration('对焦时长', actionParams.durationSeconds ?? actionParams.duration, 1)}
            {renderCameraEase('对焦缓动', actionParams.ease ?? actionParams.easing)}
          </>
        )}
        {mode === 'move' && (
          <>
            <div className="inspector-section-title">移动终点</div>
            {renderCameraPoint(
              '终点坐标（标准化）',
              moveTo,
              (nextPoint, isTransient) => updateCameraParam('to', nextPoint, isTransient),
            )}
            <div className="inspector-section-title">终点变换</div>
            {renderCameraZoom('终点变焦')}
            {renderCameraNumber('终点旋转', 'rotation', actionParams.rotation, 0, '1', undefined, undefined, '-180', '180')}
            {renderCameraDuration('移动时长', actionParams.durationSeconds ?? actionParams.duration, 1)}
            {renderCameraEase('移动缓动', actionParams.ease ?? actionParams.easing)}
          </>
        )}
        {mode === 'follow' && actionParams.operation !== 'stop' && (
          <>
            {renderCameraTarget(false)}
            {renderCameraPoint(
              '跟随偏移（标准化）',
              followOffset,
              (nextPoint, isTransient) => updateCameraParam('offset', nextPoint, isTransient),
              { min: '-1', max: '1' },
            )}
            {renderCameraNumber('跟随平滑度', 'smoothing', actionParams.smoothing, 0.85, '0.05', '0', '1')}
          </>
        )}
        {mode === 'path' && (
          <div style={{ padding: '4px 0 12px' }}>
            <div className="inspector-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span>路径关键帧（至少 2 个）</span>
              <button type="button" className="btn btn--icon" title="添加路径关键帧" aria-label="添加路径关键帧" onClick={addPathKeyframe}>
                <IconPlus width={13} height={13} />
              </button>
            </div>
            {pathKeyframes.map((keyframe, index) => {
              const position = readCameraPoint(keyframe.position);
              return (
                <div key={`${index}-${keyframe.time}`} className="inspector-row" style={{ alignItems: 'flex-start' }}>
                  <span className="inspector-label">关键帧 {index + 1}</span>
                  <div style={{ display: 'grid', gap: 6, minWidth: 0, flex: 1 }}>
                    <div className="compound-input grid-row">
                      <InlineNumericInput
                        ariaLabel={`关键帧 ${index + 1} 时间`}
                        dragLabel="时间"
                        step="0.1"
                        min="0"
                        popoverMin="0"
                        popoverMax="10"
                        value={typeof keyframe.time === 'number' ? keyframe.time : 0}
                        onChange={(value, isTransient) => updatePathKeyframe(index, { time: Math.max(0, value) }, isTransient)}
                      />
                      <InlineNumericInput
                        ariaLabel={`关键帧 ${index + 1} X`}
                        dragLabel="X"
                        step="0.01"
                        min="0"
                        max="1"
                        value={position[0]}
                        onChange={(value, isTransient) => updatePathKeyframe(index, { position: [clampCameraCoordinate(value), position[1]] }, isTransient)}
                      />
                      <InlineNumericInput
                        ariaLabel={`关键帧 ${index + 1} Y`}
                        dragLabel="Y"
                        step="0.01"
                        min="0"
                        max="1"
                        value={position[1]}
                        onChange={(value, isTransient) => updatePathKeyframe(index, { position: [position[0], clampCameraCoordinate(value)] }, isTransient)}
                      />
                    </div>
                    <div className="compound-input grid-row">
                      <InlineNumericInput
                        ariaLabel={`关键帧 ${index + 1} 变焦`}
                        dragLabel="Zoom"
                        step="0.05"
                        min="0"
                        popoverMin="0.1"
                        popoverMax="3"
                        value={typeof keyframe.zoom === 'number' ? keyframe.zoom : 1}
                        onChange={(value, isTransient) => updatePathKeyframe(index, { zoom: value }, isTransient)}
                      />
                      <InlineNumericInput
                        ariaLabel={`关键帧 ${index + 1} 旋转`}
                        dragLabel="旋转"
                        step="1"
                        popoverMin="-180"
                        popoverMax="180"
                        value={typeof keyframe.rotation === 'number' ? keyframe.rotation : 0}
                        onChange={(value, isTransient) => updatePathKeyframe(index, { rotation: value }, isTransient)}
                      />
                      {(() => {
                        const keyframeEase = normalizeEaseOptionValue(typeof keyframe.ease === 'string' ? keyframe.ease : '');
                        const keyframeEaseOptions = keyframeEase && !EASE_OPTIONS.some((opt) => opt.value === keyframeEase)
                          ? [{ value: keyframeEase, label: `${keyframeEase} (自定义)` }, ...EASE_OPTIONS]
                          : EASE_OPTIONS;
                        return (
                          <FormSelect
                            id={`action-${actionId}-path-${index}-ease`}
                            aria-label={`关键帧 ${index + 1} 缓动`}
                            placeholder="缓动"
                            value={keyframeEase}
                            options={keyframeEaseOptions}
                            onChange={(value) => updatePathKeyframe(index, { ease: value || undefined })}
                          />
                        );
                      })()}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: pathKeyframes.length > 2 ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)', gap: 6, alignItems: 'center' }}>
                      <input
                        className="form-input"
                        aria-label={`关键帧 ${index + 1} 标签`}
                        placeholder="标签（可选）"
                        value={typeof keyframe.label === 'string' ? keyframe.label : ''}
                        onChange={(event) => updatePathKeyframe(index, { label: event.target.value || undefined })}
                      />
                      {pathKeyframes.length > 2 && (
                        <button
                          type="button"
                          className="btn btn--icon"
                          title="删除路径关键帧"
                          aria-label={`删除关键帧 ${index + 1}`}
                          onClick={() => removePathKeyframe(index)}
                        >
                          <IconTrash width={13} height={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {renderCameraDuration('路径时长', actionParams.durationSeconds ?? actionParams.duration, 1)}
            {renderCameraEase('路径缓动', actionParams.ease ?? actionParams.easing)}
            {renderCameraNumber('重复次数', 'repeat', actionParams.repeat, 0, '1', '0')}
            {renderCameraBoolean('循环播放', 'loop', actionParams.loop, false)}
            {renderCameraBoolean('往返播放', 'yoyo', actionParams.yoyo, false)}
          </div>
        )}
        {mode === 'shake' && (
          <>
            {renderCameraNumber('震动强度', 'intensity', actionParams.intensity, 0.2, '0.05', '0')}
            {renderCameraNumber('震动频率', 'frequency', actionParams.frequency, 18, '1', '0')}
            {renderCameraDuration('震动时长', actionParams.durationSeconds ?? actionParams.duration, 0.6)}
            {renderCameraBoolean('衰减', 'decay', actionParams.decay, true)}
            {renderCameraSelect('震动方向', 'direction', actionParams.direction || 'both', [
              { value: 'both', label: '双向' },
              { value: 'horizontal', label: '水平' },
              { value: 'vertical', label: '垂直' },
            ])}
          </>
        )}
        {mode === 'hitchcock' && (
          <>
            {renderCameraTarget(false)}
            {renderCameraTargetPart()}
            {renderCameraPoint(
              '屏幕目标（标准化）',
              readCameraPoint(actionParams.screenTarget),
              (nextPoint, isTransient) => updateCameraParam('screenTarget', nextPoint, isTransient),
            )}
            {renderCameraNumber('起始变焦', 'zoomStart', actionParams.zoomStart, 1, '0.05', '0')}
            {renderCameraNumber('结束变焦', 'zoomEnd', actionParams.zoomEnd, 1.3, '0.05', '0')}
            {renderCameraNumber('起始缩放', 'scaleStart', actionParams.scaleStart, 1, '0.05', '0')}
            {renderCameraNumber('结束缩放', 'scaleEnd', actionParams.scaleEnd, 0.8, '0.05', '0')}
            {renderCameraDuration('变焦时长', actionParams.durationSeconds ?? actionParams.duration, 2, '0.01')}
            {renderCameraEase('变焦缓动', actionParams.ease ?? actionParams.easing)}
          </>
        )}
        {mode === 'reset' && (
          <>
            {renderCameraDuration('复位时长', actionParams.durationSeconds ?? actionParams.duration, 0.5)}
            {renderCameraEase('复位缓动', actionParams.ease ?? actionParams.easing)}
          </>
        )}
      </>
    );
  }

  if (isLensFilterSourceAction) {
    const selectedRecipeId = typeof actionParams.recipeId === 'string' ? actionParams.recipeId : '';
    const selectedCategory = selectedRecipeId
      ? getLensFilterCategory(sceneData.visual, selectedRecipeId)
      : null;
    const filterParameterKeys = semanticInspectorFields
      .filter((fieldDefinition) => ['intensity', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination', 'durationSeconds'].includes(fieldDefinition.key))
      .map((fieldDefinition) => fieldDefinition.key);
    const updateFilterRecipe = (recipeId: string) => {
      if (!recipeId) return;
      const nextParams = normalizeFilterSourceParams(sourceParams, sceneData.visual, recipeId);
      void Promise.resolve(replaceSourceParams(actionId, nextParams)).catch(() => undefined);
    };
    const currentFilterValue = typeof actionParams.fromRecipeId === 'string' ? actionParams.fromRecipeId : '';
    return (
      <>
          {action.semanticType === 'filterChange' && (
            <SearchableSelect
              label="当前滤镜"
              value={currentFilterValue}
              options={activeFilterTemplateOptions}
              placeholder="选择当前滤镜..."
              onChange={(value) => updateParam(actionId, 'fromRecipeId', value)}
            />
          )}
          {action.semanticType !== 'filterReset' && (
            <SearchableSelect
              label="滤镜模板"
              value={selectedRecipeId}
              options={filterTemplateOptions}
              placeholder="选择滤镜模板..."
              onChange={updateFilterRecipe}
            />
          )}
          {selectedCategory && (
            <div className="inspector-row" role="status">
              <span className="inspector-label">模板类别</span>
              <span className="inspector-value">{LENS_FILTER_CATEGORY_LABELS[selectedCategory] || selectedCategory}</span>
            </div>
          )}
        {filterParameterKeys.map((key) => <React.Fragment key={key}>{renderParam(key)}</React.Fragment>)}
      </>
    );
  }

  if (action.semanticType === 'visualStyle') {
    return (
      <>
        <div className="inspector-row"><label className="inspector-label" htmlFor={`action-${actionId}-visual-target`}>目标对象</label><FormSelect id={`action-${actionId}-visual-target`} value={actionParams.target || ''} options={isRimLightVisualAction ? rimLightTargetOptions : visualTargetOptions} disabled={isRimLightVisualAction && characterVisualTargetOptions.length === 0} onChange={(value) => updateSemanticSourceParam('target', value)} /></div>
      </>
    );
  }

  if (isResourceMotion) {
    const charId = actionParams.id || actionParams.target;
    const cubism2Loaded = !!charId && (characterAdapter.getCubism2SamplerTargets?.(charId)?.length ?? 0) > 0;
    const canConvert = !!customMotionAuthoring && !!charId && cubism2Loaded;
    return (
      <div className="inspector-section" data-testid="resource-motion-conversion">
        <div className="inspector-section-title">
          自定义动作
          {!cubism2Loaded && (
            <InfoTip content="需要角色已加载为 Cubism 2.1 模型才能转换。" />
          )}
        </div>
        <button type="button" className="btn btn--primary" style={{ width: '100%' }} onClick={openConversionDialog} disabled={!canConvert}>
          转为自定义动作…
        </button>
      </div>
    );
  }

  return null;
}
