import type React from 'react';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { DraftSession } from '../../services/ai-authoring/AiProseDraftSession';
import { IconPlus, IconX } from '../icons';
import { TabIntro } from './StageControls';
import { EmptyStage } from './WorkbenchFeedback';

export function CharactersStage({
  draft,
  names,
  document,
  onNamesChange,
  onBindingChange,
  busy,
}: {
  draft: DraftSession;
  names: string[];
  document: CurrentSceneDocument;
  onNamesChange: React.Dispatch<React.SetStateAction<string[]>>;
  onBindingChange: (name: string, characterId: string) => void;
  busy: boolean;
}) {
  const characters = document.meta.characters ?? [];
  const addName = () => onNamesChange((current) => [...current, '']);
  const removeName = (index: number) => onNamesChange((current) => current.filter((_, itemIndex) => itemIndex !== index));
  return (
    <section className="ai-prose-tab-panel is-active">
      <TabIntro
        title="人物确认"
        action={<button className="ai-prose-button ai-prose-button--secondary" type="button" onClick={addName} disabled={busy}><IconPlus size={14} /> 添加人物</button>}
      />
      <div className="ai-prose-character-list">
        <div className="ai-prose-list-heading">
          <span>
            主要人物 ·
            {' '}
            {names.length}
          </span>
          <small>
            AI 建议
            {' '}
            {draft.characterExtraction.suggestedNames.length}
            {draft.characterExtraction.status === 'failed' ? ' · 提取失败' : ''}
          </small>
        </div>
        {names.map((name, index) => {
          const matches = characters.filter((character) => character.name === name);
          return (
            <div className="ai-prose-character-row" key={index}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <input
                aria-label={`主要人物 ${index + 1}`}
                value={name}
                onChange={(event) => onNamesChange((current) => current.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                disabled={busy}
              />
              <button
                className="ai-prose-button ai-prose-button--icon"
                type="button"
                onClick={() => removeName(index)}
                disabled={busy}
                aria-label={`删除人物 ${index + 1}`}
              >
                <IconX size={14} />
              </button>
              {draft.mainCharactersConfirmed && matches.length > 1 && (
                <select
                  aria-label={`${name} 的角色绑定`}
                  value={draft.characterBindings[name] ?? ''}
                  disabled={busy}
                  onChange={(event) => onBindingChange(name, event.target.value)}
                >
                  <option value="">选择绑定角色</option>
                  {matches.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}
                      {' · '}
                      {character.id}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        {names.length === 0 && <EmptyStage message="没有主要人物" />}
      </div>
    </section>
  );
}

