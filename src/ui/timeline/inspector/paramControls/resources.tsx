// Resource / file picker region: audio/image/model/animation source fields,
// with dialogue voice-workbench shortcut.
import React from 'react';
import { FileInput } from '../../FormComponents';
import { InlineFilePicker } from '../../../InlineFilePicker';
import { IconVolume2 } from '../../../icons';
import { eventBus } from '../../../../api/events';
import { sceneStatementDefinitionRegistry } from '../../../../services/semantic-scene';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveResourceParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;
  const actionType = ctx.actionType;
  const item = ctx.semanticItem;

  if (!['model', 'image', 'audio', 'bgm', 'se', 'file', 'voice', 'animation'].includes(key)) return undefined;

  const sourceAssetSlot = item
    ? sceneStatementDefinitionRegistry.sourceAssetSlot(item.source, `params.${key}`)
    : undefined;
  const isSemanticImageFile =
    key === 'image' ||
    (key === 'file' && (
      ctx.action.semanticType === 'environmentLayer' ||
      (ctx.action.semanticType === 'graphicLayer' && ctx.actionParams.kind === 'image')
    ));
  const isSemanticAudioFile = key === 'file' && ctx.action.semanticType === 'audio';
  const isSemanticAnimationResource =
    (key === 'file' || key === 'animation') && ctx.action.semanticType === 'customAnimation';
  let filters = [{ name: '所有文件', extensions: ['*'] }];
  if (isSemanticImageFile) filters = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
  if (key === 'model') filters = [{ name: 'Live2D 模型', extensions: ['json', 'wmdl'] }];
  if (isSemanticAudioFile || key.includes('audio') || key === 'bgm' || key === 'se' || key === 'voice') filters = [{ name: '音频', extensions: ['mp3', 'wav', 'ogg'] }];
  if (isSemanticAnimationResource) filters = [{ name: 'HTML 动画', extensions: ['html'] }];
  const isDialogueVoiceResource = (ctx.action.semanticType === 'dialogue' || actionType === 'dialogue') && key === 'voice';
  const importKind = isSemanticAnimationResource
    ? 'animation'
    : isDialogueVoiceResource
      ? 'vocal'
      : ctx.action.semanticType === 'environmentLayer' && (key === 'file' || key === 'image')
        ? 'background'
        : ctx.action.semanticType === 'graphicLayer' && key === 'file' && ctx.actionParams.kind === 'image'
          ? 'images'
          : ctx.action.semanticType === 'audio' && key === 'file'
            ? ctx.actionParams.role === 'bgm' ? 'bgm' : 'generic'
            : actionType === 'setBGM' || key === 'bgm'
              ? 'bgm'
              : actionType === 'playAudio' || key === 'se'
                ? 'generic'
                : key === 'model'
                  ? 'figure'
                  : undefined;
  const initialDir = isSemanticAnimationResource
    ? 'animation'
    : isDialogueVoiceResource
      ? 'vocal'
      : ctx.action.semanticType === 'environmentLayer' && (key === 'file' || key === 'image')
        ? 'background'
        : ctx.action.semanticType === 'graphicLayer' && key === 'file' && ctx.actionParams.kind === 'image'
          ? 'images'
          : ctx.action.semanticType === 'audio' && key === 'file'
            ? ctx.actionParams.role === 'bgm' ? 'bgm' : 'sfx'
            : actionType === 'setBGM' || key === 'bgm'
              ? 'bgm'
              : actionType === 'playAudio' || key === 'se'
                ? 'sfx'
                : key === 'model'
                  ? 'figure'
                  : undefined;
  const placeholder = ctx.action.semanticType === 'audio' && key === 'file'
    ? ctx.actionParams.role === 'bgm' ? '选择背景音乐...' : '选择音效文件...'
    : isSemanticAnimationResource
      ? '选择 HTML 动画...'
      : ctx.action.semanticType === 'environmentLayer' && (key === 'file' || key === 'image')
        ? '选择背景图片...'
        : ctx.action.semanticType === 'graphicLayer' && key === 'file' && ctx.actionParams.kind === 'image'
          ? '选择图片文件...'
          : isDialogueVoiceResource
            ? '选择语音文件...'
            : undefined;
  if (isDialogueVoiceResource) {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label">{base.label}</label>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
          <InlineFilePicker
            presentation="asset"
            value={val || ''}
            onChange={(v) => ctx.updateResourceParam(key, v)}
            filters={filters}
            placeholder={placeholder || '选择语音文件...'}
            importKindOverride={importKind}
            initialDirOverride={initialDir}
          />
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => {
              const character = ctx.sceneData.meta.characters?.find((item) => item.id === ctx.actionParams.speakerId);
              void eventBus.emit('ui:openVoiceWorkbench', {
                mode: 'dialogue',
                statementId: item?.statementId,
                sceneId: ctx.sceneData.sceneId,
                characterId: ctx.actionParams.speakerId,
                characterName: character?.name,
                voiceProfileId: character?.voiceProfileId,
                text: ctx.actionParams.text || '',
              });
            }}
            title="语音工作台（生成、试听并选择候选）"
            aria-label="语音工作台"
            style={{
              width: 28,
              height: 28,
              flexShrink: 0,
              border: '1px solid var(--border-default)',
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <IconVolume2 width={14} height={14} />
          </button>
        </div>
      </div>
    );
  }
  return (
    <FileInput
      presentation="asset"
      key={key}
      label={base.label}
      value={val}
      onChange={(v) => ctx.updateResourceParam(key, v)}
      filters={filters}
      importKind={sourceAssetSlot?.kind ?? importKind}
      initialDir={initialDir}
      placeholder={placeholder}
    />
  );
}
