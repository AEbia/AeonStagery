import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SceneMeta } from '../../api/types/scene-common';
import type { CharacterDirectoryCommand } from '../../api/types/character-directory';
import {
  useCharacterAdapter,
  useSemanticAuthoringService,
  usePlaybackAdapter,
  usePlaybackStore,
} from '../context/AppContext';
import { AssetBrowserModal } from '../AssetBrowserModal';
import { ColorPickerInput } from '../ColorPickerInput';
import { IconFolder, IconPlus, IconTrash, IconUser } from '../icons';
import { showToast } from '../Toast';

type CharacterDirectoryCommandInput = CharacterDirectoryCommand extends infer Command
  ? Command extends { origin: unknown }
    ? Omit<Command, 'origin'>
    : never
  : never;

type VariantPickerTarget = {
  charId: string;
  variantIndex?: number;
};

const LIVE2D_MODEL_FILTERS = [{ name: 'Live2D Model', extensions: ['json', 'wmdl'] }];

function createVariantModelCommand(
  target: VariantPickerTarget,
  model: string,
): CharacterDirectoryCommandInput {
  if (target.variantIndex === undefined) {
    return {
      kind: 'add-character-variant',
      charId: target.charId,
      model,
    };
  }

  return {
    kind: 'update-character-variant-model',
    charId: target.charId,
    variantIndex: target.variantIndex,
    nextModel: model,
  };
}

const CharParamSliders: React.FC<{ charId: string }> = ({ charId }) => {
  const characterAdapter = useCharacterAdapter();
  const playbackStore = usePlaybackStore();
  const core = characterAdapter.getCoreModel(charId);
  const model = characterAdapter.getModel(charId);
  if (!core || !model) return null;

  const values = core.getParameterValues?.() || core.paramValues || [];
  const settings = model.internalModel?.settings;

  return (
    <div className="character-directory__parameters">
      {Array.from({ length: Math.min(values.length, 20) }, (_, index) => {
        const name = settings?.parameters?.[index]?.name || `Param_${index}`;
        const value = values[index] as number;
        return (
          <label className="character-directory__parameter" key={index}>
            <span>{name}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value}
              disabled={playbackStore.playing}
              onChange={(event) => {
                characterAdapter.getCoreModel(charId)?.setParamFloat(index, Number(event.target.value));
              }}
            />
          </label>
        );
      })}
    </div>
  );
};

export interface CharacterDirectoryPanelProps {
  sceneMeta: SceneMeta;
}

export const CharacterDirectoryPanel: React.FC<CharacterDirectoryPanelProps> = ({ sceneMeta }) => {
  const characterAdapter = useCharacterAdapter();
  const semanticAuthoring = useSemanticAuthoringService();
  const playbackAdapter = usePlaybackAdapter();
  const playbackStore = usePlaybackStore();
  const characters = useMemo(() => sceneMeta.characters ?? [], [sceneMeta.characters]);
  const charactersById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters],
  );

  // The selection is a slot in the character list, not an id: renaming a
  // character id must not move the selection onto another character.
  const [selectedCharacterIndex, setSelectedCharacterIndex] = useState(0);
  const [showParameters, setShowParameters] = useState(false);
  const [modelPickerTarget, setModelPickerTarget] = useState<string | null>(null);
  const [variantPickerTarget, setVariantPickerTarget] = useState<VariantPickerTarget | null>(null);
  const [nameDraft, setNameDraft] = useState(() => characters[0]?.name ?? '');
  const [idDraft, setIdDraft] = useState(() => characters[0]?.id ?? '');
  const [idError, setIdError] = useState<string | null>(null);
  const characterOptionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const nameDraftOwnerRef = React.useRef(-1);
  const nameDraftValueRef = React.useRef(nameDraft);
  const nameDraftDirtyRef = React.useRef(false);
  const nameCompositionRef = React.useRef(false);
  const lastSubmittedNameRef = React.useRef<string | null>(null);
  const idDraftOwnerRef = React.useRef(-1);
  const idDraftValueRef = React.useRef(idDraft);
  const idDraftDirtyRef = React.useRef(false);
  const lastSubmittedIdRef = React.useRef(characters[0]?.id ?? '');

  useEffect(() => {
    if (selectedCharacterIndex < characters.length) return;
    setSelectedCharacterIndex(characters.length > 0 ? characters.length - 1 : 0);
    setShowParameters(false);
  }, [characters.length, selectedCharacterIndex]);

  const applyCommand = useCallback((command: CharacterDirectoryCommandInput): Promise<boolean> => {
    if (!semanticAuthoring) return Promise.resolve(false);
    return semanticAuthoring.applyCharacterCommand({
      ...command,
      origin: 'workspace-tools-panel',
    }).then(
      () => true,
      (error) => {
        showToast(`角色修改失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return false;
      },
    );
  }, [semanticAuthoring]);

  const selectedCharacter = characters[selectedCharacterIndex];
  const charactersRef = React.useRef(characters);
  const selectedCharacterIndexRef = React.useRef(selectedCharacterIndex);
  charactersRef.current = characters;
  selectedCharacterIndexRef.current = selectedCharacterIndex;

  useEffect(() => {
    const nextOwnerIndex = selectedCharacterIndex;
    const nextName = selectedCharacter?.name ?? '';

    if (nameDraftOwnerRef.current !== nextOwnerIndex) {
      nameDraftOwnerRef.current = nextOwnerIndex;
      nameDraftDirtyRef.current = false;
      nameCompositionRef.current = false;
      lastSubmittedNameRef.current = null;
      nameDraftValueRef.current = nextName;
      setNameDraft(nextName);
      return;
    }

    if (nameCompositionRef.current) return;

    if (nameDraftValueRef.current === nextName) {
      nameDraftDirtyRef.current = false;
      return;
    }

    if (!nameDraftDirtyRef.current) {
      nameDraftValueRef.current = nextName;
      lastSubmittedNameRef.current = null;
      setNameDraft(nextName);
      return;
    }

    if (lastSubmittedNameRef.current === nextName) {
      nameDraftDirtyRef.current = false;
    }
  }, [selectedCharacter?.id, selectedCharacter?.name, selectedCharacterIndex]);

  useEffect(() => {
    const committedId = selectedCharacter?.id ?? '';

    if (idDraftOwnerRef.current !== selectedCharacterIndex) {
      idDraftOwnerRef.current = selectedCharacterIndex;
      idDraftDirtyRef.current = false;
      idDraftValueRef.current = committedId;
      lastSubmittedIdRef.current = committedId;
      setIdError(null);
      setIdDraft(committedId);
      return;
    }

    if (idDraftValueRef.current === committedId) {
      idDraftDirtyRef.current = false;
      lastSubmittedIdRef.current = committedId;
      return;
    }

    // A local edit is still ahead of the (asynchronous) scene writeback.
    if (idDraftDirtyRef.current) return;

    idDraftValueRef.current = committedId;
    lastSubmittedIdRef.current = committedId;
    setIdError(null);
    setIdDraft(committedId);
  }, [selectedCharacter?.id, selectedCharacterIndex]);

  const updateNameDraft = (nextName: string) => {
    nameDraftValueRef.current = nextName;
    nameDraftDirtyRef.current = true;
    setNameDraft(nextName);
  };

  const commitCharacterName = (nextName: string) => {
    if (lastSubmittedNameRef.current === nextName || !selectedCharacter) return;
    lastSubmittedNameRef.current = nextName;
    void applyCommand({
      kind: 'update-character-name',
      charId: selectedCharacter.id,
      nextName,
    });
  };

  /**
   * Commits an edited character id. While the user is typing the draft may be
   * an intermediate value (empty, or equal to another character) — such a value
   * is simply not committed, and the reason is reported once the field settles.
   */
  const commitCharacterId = (rawId: string) => {
    if (!selectedCharacter) return;
    const nextId = rawId.trim();
    const currentId = lastSubmittedIdRef.current;

    if (nextId === '' || nextId === currentId) return;
    if (characters.some((character, index) => index !== selectedCharacterIndex && character.id === nextId)) {
      return;
    }

    if (idError) setIdError(null);
    lastSubmittedIdRef.current = nextId;
    void applyCommand({
      kind: 'update-character-id',
      currentCharId: currentId,
      nextCharId: nextId,
    }).then((succeeded) => {
      if (succeeded || lastSubmittedIdRef.current !== nextId) return;
      // The command was rejected: fall back to the id still present in the scene.
      const fallbackId = charactersRef.current[selectedCharacterIndexRef.current]?.id ?? '';
      lastSubmittedIdRef.current = fallbackId;
      idDraftValueRef.current = fallbackId;
      idDraftDirtyRef.current = false;
      setIdDraft(fallbackId);
    });
  };

  const updateIdDraft = (nextId: string) => {
    idDraftValueRef.current = nextId;
    idDraftDirtyRef.current = true;
    setIdDraft(nextId);
    if (idError) setIdError(null);
    commitCharacterId(nextId);
  };

  /** Validates the finished draft and keeps the field on the accepted id. */
  const settleIdDraft = () => {
    const draftId = idDraftValueRef.current.trim();
    const currentId = lastSubmittedIdRef.current;
    const takenByOther = draftId !== '' && draftId !== currentId
      && characters.some((character, index) => (
        index !== selectedCharacterIndex && character.id === draftId
      ));

    if (draftId === '') {
      setIdError('角色 ID 不能为空');
    } else if (takenByOther) {
      setIdError(`角色 ID「${draftId}」已被其他角色占用`);
    } else {
      setIdError(null);
    }

    const settledId = draftId !== '' && !takenByOther ? draftId : currentId;
    idDraftDirtyRef.current = false;
    idDraftValueRef.current = settledId;
    lastSubmittedIdRef.current = settledId;
    setIdDraft(settledId);
  };

  const selectCharacterAt = (index: number) => {
    setSelectedCharacterIndex(index);
    setShowParameters(false);
  };

  const handleCharacterKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || characters.length === 0) return;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? characters.length - 1
          : (index + direction + characters.length) % characters.length;
      const nextCharacter = characters[nextIndex];
      if (!nextCharacter) return;
      selectCharacterAt(nextIndex);
      characterOptionRefs.current[nextIndex]?.focus();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      const character = characters[index];
      if (character) selectCharacterAt(index);
    }
  };

  return (
    <div className="character-directory" data-testid="character-directory">
      <header className="character-directory__header">
        <div>
          <strong>角色管理</strong>
          <span>{characters.length} 个角色</span>
        </div>
        <button
          className="btn btn--primary btn--sm"
          data-testid="character-add-button"
          onClick={() => applyCommand({ kind: 'add-character' })}
        >
          <IconPlus width={13} height={13} />
          添加角色
        </button>
      </header>

      <div className="character-directory__list" role="listbox" aria-label="角色列表" aria-orientation="horizontal">
        {characters.map((character, index) => (
          <button
            className="character-directory__list-item"
            data-testid="character-list-item"
            data-character-id={character.id}
            data-active={index === selectedCharacterIndex}
            key={character.id}
            ref={(element) => { characterOptionRefs.current[index] = element; }}
            tabIndex={index === selectedCharacterIndex ? 0 : -1}
            onClick={() => selectCharacterAt(index)}
            onKeyDown={(event) => handleCharacterKeyDown(event, index)}
            role="option"
            aria-selected={index === selectedCharacterIndex}
          >
            <span
              className="character-directory__swatch"
              style={{ background: character.color || '#FFD700' }}
            />
            <span className="character-directory__list-name">{character.name || character.id}</span>
            <span className="character-directory__list-id">{character.id}</span>
          </button>
        ))}
        {characters.length === 0 && (
          <div className="character-directory__empty">
            <IconUser width={24} height={24} />
            <span>尚未添加角色</span>
          </div>
        )}
      </div>

      {selectedCharacter && (
        <div className="character-directory__detail" key={selectedCharacterIndex}>
          <section className="character-directory__section">
            <div className="character-directory__section-title">基础信息</div>
            <div className="character-directory__field-grid">
              <label>
                <span>角色 ID</span>
                <input
                  data-testid="character-id-input"
                  value={idDraft}
                  aria-invalid={idError ? true : undefined}
                  className={idError ? 'character-directory__id-input character-directory__id-input--invalid' : 'character-directory__id-input'}
                  onChange={(event) => updateIdDraft(event.target.value)}
                  onBlur={settleIdDraft}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                {idError && (
                  <small className="character-directory__field-error" role="alert">{idError}</small>
                )}
              </label>
              <label>
                <span>显示名称</span>
                <input
                  data-testid="character-name-input"
                  value={nameDraft}
                  onCompositionStart={() => {
                    nameCompositionRef.current = true;
                  }}
                  onCompositionEnd={(event) => {
                    nameCompositionRef.current = false;
                    const nextName = event.currentTarget.value;
                    updateNameDraft(nextName);
                    commitCharacterName(nextName);
                  }}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    updateNameDraft(nextName);
                    if (nameCompositionRef.current || (event.nativeEvent as InputEvent).isComposing) return;
                    commitCharacterName(nextName);
                  }}
                />
              </label>
            </div>
            <label className="character-directory__color-field">
              <span>主题色</span>
              <div className="compound-input">
                <ColorPickerInput
                  value={selectedCharacter.color || '#FFD700'}
                  onChange={(color) => applyCommand({
                    kind: 'set-character-color',
                    charId: selectedCharacter.id,
                    color,
                  })}
                />
                <input
                  type="text"
                  value={selectedCharacter.color || ''}
                  placeholder="#FFD700"
                  onChange={(event) => applyCommand({
                    kind: 'set-character-color',
                    charId: selectedCharacter.id,
                    color: event.target.value || undefined,
                  })}
                />
              </div>
            </label>
          </section>

          <section className="character-directory__section">
            <div className="character-directory__section-title">模型</div>
            <div className="character-directory__model-row">
              <div title={selectedCharacter.model || ''}>
                {selectedCharacter.model || '未选择模型'}
              </div>
              <button
                className="btn btn--icon"
                title="选择模型文件"
                aria-label="选择模型文件"
                onClick={() => setModelPickerTarget(selectedCharacter.id)}
              >
                <IconFolder width={14} height={14} />
              </button>
            </div>
            {selectedCharacter.model && characterAdapter.hasCharacter(selectedCharacter.id) && (
              <div className="character-directory__inline-actions">
                <button
                  className="btn btn--sm"
                  disabled={playbackStore.playing}
                  onClick={async () => {
                    const entry = characterAdapter.getAllCharacters().get(selectedCharacter.id);
                    if (!entry) return;
                    const currentTime = playbackAdapter.getCurrentTime();
                    characterAdapter.remove(selectedCharacter.id);
                    await characterAdapter.add(selectedCharacter.id, entry.modelPath, entry.config);
                    await playbackAdapter.seek(currentTime);
                  }}
                >
                  重新加载
                </button>
                <button
                  className="btn btn--sm"
                  onClick={() => setShowParameters((current) => !current)}
                >
                  {showParameters ? '隐藏参数' : 'Live2D 参数'}
                </button>
              </div>
            )}
            {showParameters && selectedCharacter.model && characterAdapter.hasCharacter(selectedCharacter.id) && (
              <CharParamSliders charId={selectedCharacter.id} />
            )}
          </section>

          <section className="character-directory__section">
            <div className="character-directory__section-header">
              <div className="character-directory__section-title">副模型</div>
              <button
                className="btn btn--sm"
                onClick={() => setVariantPickerTarget({ charId: selectedCharacter.id })}
              >
                <IconPlus width={11} height={11} />
                添加
              </button>
            </div>
            <div className="character-directory__variants">
              {(selectedCharacter.variants || []).map((variant, variantIndex) => (
                <div className="character-directory__variant" key={`${selectedCharacter.id}-${variantIndex}`}>
                  <input
                    value={variant.name}
                    placeholder="副模型名称"
                    onChange={(event) => applyCommand({
                      kind: 'update-character-variant-name',
                      charId: selectedCharacter.id,
                      variantIndex,
                      nextName: event.target.value,
                    })}
                  />
                  <div title={variant.model || ''}>{variant.model || '未选择文件'}</div>
                  <button
                    className="btn btn--icon"
                    title="选择副模型文件"
                    aria-label={`选择副模型 ${variant.name || variantIndex + 1} 文件`}
                    onClick={() => setVariantPickerTarget({ charId: selectedCharacter.id, variantIndex })}
                  >
                    <IconFolder width={12} height={12} />
                  </button>
                  <button
                    className="btn btn--icon"
                    title="删除副模型"
                    aria-label={`删除副模型 ${variant.name || variantIndex + 1}`}
                    onClick={() => applyCommand({
                      kind: 'remove-character-variant',
                      charId: selectedCharacter.id,
                      variantIndex,
                    })}
                  >
                    <IconTrash width={12} height={12} />
                  </button>
                </div>
              ))}
              {(selectedCharacter.variants || []).length === 0 && (
                <div className="character-directory__empty-row">没有副模型</div>
              )}
            </div>
          </section>

          <button
            className="btn btn--danger character-directory__delete"
            onClick={() => applyCommand({
              kind: 'remove-character',
              charId: selectedCharacter.id,
            })}
          >
            <IconTrash width={13} height={13} />
            删除角色
          </button>
        </div>
      )}

      {modelPickerTarget && (
        <AssetBrowserModal
          value={charactersById.get(modelPickerTarget)?.model || 'figure'}
          filters={LIVE2D_MODEL_FILTERS}
          onClose={() => setModelPickerTarget(null)}
          onSelect={(model) => {
            applyCommand({
              kind: 'set-character-model',
              charId: modelPickerTarget,
              model,
            });
            setModelPickerTarget(null);
          }}
        />
      )}

      {variantPickerTarget && (
        <AssetBrowserModal
          value={
            (variantPickerTarget.variantIndex === undefined
              ? undefined
              : charactersById.get(variantPickerTarget.charId)?.variants?.[variantPickerTarget.variantIndex]?.model)
            || 'figure'
          }
          filters={LIVE2D_MODEL_FILTERS}
          onClose={() => setVariantPickerTarget(null)}
          onSelect={(model) => {
            applyCommand(createVariantModelCommand(variantPickerTarget, model));
            setVariantPickerTarget(null);
          }}
        />
      )}
    </div>
  );
};
