import { useEffect, useId, useMemo, useState } from 'react';
import type { PerformanceProfileCharacterV1, PerformanceProfileSourceV1, SceneCharacterIdentity } from '../../services/ai-authoring/performance';
import type {
  EditablePerformanceProfileTarget,
  PerformanceProfileEntryKind,
  PerformanceProfileTemplateDraft,
  TemplatePerformanceProfileAuthoringService,
} from '../../services/template-package';
import {
  getPerformanceProfileFingerprint,
  getPerformanceProfileTargetIdentity,
  createTemplatePackageView,
} from '../../services/template-package';
import { IconPlus, IconSave, IconTrash } from '../icons';
import { FormSelect } from '../FormSelect';
import { getTemplateCharacterMatches, UNMATCHED_TEMPLATE_CHARACTER, type TemplateCharacterMatch } from './TemplatePerformanceProfileMatches';
import './template-performance-profile-editor.css';

interface TemplatePerformanceProfileEditorProps {
  readonly service: TemplatePerformanceProfileAuthoringService;
  readonly packages: readonly import('../../services/template-package').LoadedTemplatePackage[];
  readonly revision: number;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly enabledTemplateIds?: readonly string[];
  readonly sceneCharacters?: readonly SceneCharacterIdentity[];
}

interface DraftSession {
  readonly draft: PerformanceProfileTemplateDraft;
  readonly baseline: string;
  readonly originalTemplateId?: string;
  readonly originalProfileId?: string;
  readonly sourceFingerprint?: string;
}

type EntryField = 'key' | 'description';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function draftFingerprint(draft: PerformanceProfileTemplateDraft): string {
  return JSON.stringify(draft);
}

function sessionFromTarget(
  service: TemplatePerformanceProfileAuthoringService,
  target: EditablePerformanceProfileTarget,
): DraftSession {
  const draft = service.createDraft(target);
  return {
    draft,
    baseline: draftFingerprint(draft),
    originalTemplateId: target.templateId,
    originalProfileId: target.profileId,
    sourceFingerprint: getPerformanceProfileFingerprint(target),
  };
}

function newSession(service: TemplatePerformanceProfileAuthoringService): DraftSession {
  const draft = service.createEmptyDraft();
  return { draft, baseline: '' };
}

function parseAliases(value: string): string[] {
  return value.split(/[，,\n]/);
}

function createCharacter(index: number): PerformanceProfileCharacterV1 {
  return {
    id: `character.${index + 1}`,
  };
}

export function TemplatePerformanceProfileEditor({
  service,
  packages,
  revision,
  onDirtyChange,
  enabledTemplateIds,
  sceneCharacters,
}: TemplatePerformanceProfileEditorProps) {
  const targetInputs = useMemo(() => ({ packages, revision }), [packages, revision]);
  const targets = useMemo(() => service.listTargets(targetInputs.packages), [service, targetInputs]);
  const [selectedIdentity, setSelectedIdentity] = useState(() => (
    targets[0] ? getPerformanceProfileTargetIdentity(targets[0]) : ''
  ));
  const [session, setSession] = useState<DraftSession | null>(() => (
    targets[0] ? sessionFromTarget(service, targets[0]) : null
  ));
  const [selectedCharacterId, setSelectedCharacterId] = useState(() => targets[0]?.profile.characters[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [entryKind, setEntryKind] = useState<PerformanceProfileEntryKind>('motions');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const editorId = useId();

  const selectedTarget = targets.find((target) => getPerformanceProfileTargetIdentity(target) === selectedIdentity);
  const draft = session?.draft ?? null;
  const hasSession = session !== null;
  const originalTemplateId = session?.originalTemplateId;
  const originalProfileId = session?.originalProfileId;
  const dirty = !!session && draftFingerprint(session.draft) !== session.baseline;
  const selectedCharacter = draft?.characters.find((character) => character.id === selectedCharacterId)
    ?? draft?.characters[0];
  const currentTemplateEnabled = !enabledTemplateIds
    || (!!draft && enabledTemplateIds.includes(draft.templateId));
  const templateOptions = useMemo(() => [
    ...(!selectedIdentity ? [{ value: '', label: '未保存的新模板' }] : []),
    ...targets.map((target) => ({
      value: getPerformanceProfileTargetIdentity(target),
      label: target.templateName,
    })),
  ], [selectedIdentity, targets]);

  const projectProfileSources = useMemo<readonly PerformanceProfileSourceV1[]>(() => (
    createTemplatePackageView([...targetInputs.packages], { enabledTemplateIds: enabledTemplateIds ? [...enabledTemplateIds] : undefined })
      .performanceProfiles.map((profile) => ({
        profile,
        priority: profile.priority,
        templateId: profile.source.templateId,
      }))
  ), [targetInputs, enabledTemplateIds]);
  const characterMatches = useMemo(() => {
    if (!draft || !sceneCharacters) return new Map<string, TemplateCharacterMatch>();
    const draftProfile = {
      schemaVersion: 1 as const,
      id: draft.profileId,
      name: draft.profileName,
      characters: draft.characters.map((character) => ({ ...character, id: character.id.trim() })),
    };
    const sources = projectProfileSources.map((source) => (
      source.templateId === draft.templateId && source.profile.id === draft.profileId
        ? { ...source, profile: draftProfile }
        : source
    ));
    if (currentTemplateEnabled && !sources.some((source) => source.profile.id === draft.profileId)) {
      sources.push({ profile: draftProfile, priority: 0, templateId: draft.templateId });
    }
    return getTemplateCharacterMatches(draft.templateId, draft.profileId, sceneCharacters, sources);
  }, [draft, sceneCharacters, projectProfileSources, currentTemplateEnabled]);
  const selectedMatch = characterMatches.get(selectedCharacter?.id.trim() ?? '') ?? UNMATCHED_TEMPLATE_CHARACTER;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (dirty) return;
    if (!hasSession) {
      const firstTarget = targets[0];
      if (!firstTarget) return;
      const next = sessionFromTarget(service, firstTarget);
      setSession(next);
      setSelectedIdentity(getPerformanceProfileTargetIdentity(firstTarget));
      setSelectedCharacterId(next.draft.characters[0]?.id ?? '');
      return;
    }
    if (!originalTemplateId) return;
    const target = targets.find((candidate) => (
      candidate.templateId === originalTemplateId
      && candidate.profileId === originalProfileId
    ));
    if (!target) {
      const firstTarget = targets[0];
      if (!firstTarget) {
        setSession(null);
        setSelectedIdentity('');
        setSelectedCharacterId('');
        return;
      }
      const next = sessionFromTarget(service, firstTarget);
      setSession(next);
      setSelectedIdentity(getPerformanceProfileTargetIdentity(firstTarget));
      setSelectedCharacterId(next.draft.characters[0]?.id ?? '');
      return;
    }
    const next = sessionFromTarget(service, target);
    setSession(next);
    setSelectedIdentity(getPerformanceProfileTargetIdentity(target));
    setSelectedCharacterId((current) => (
      next.draft.characters.some((character) => character.id === current)
        ? current
        : next.draft.characters[0]?.id ?? ''
    ));
  }, [dirty, hasSession, originalProfileId, originalTemplateId, revision, service, targets]);

  useEffect(() => {
    if (!draft) return;
    setSelectedCharacterId((current) => (
      draft.characters.some((character) => character.id === current)
        ? current
        : draft.characters[0]?.id ?? ''
    ));
  }, [draft]);

  const setDraft = (update: (current: PerformanceProfileTemplateDraft) => PerformanceProfileTemplateDraft) => {
    setSession((current) => current ? { ...current, draft: update(current.draft) } : current);
    setMessage(null);
  };

  const confirmDiscard = (): boolean => (
    !dirty || window.confirm('当前模板有未保存修改。继续会丢弃这些修改，是否继续？')
  );

  const chooseTarget = (target: EditablePerformanceProfileTarget) => {
    if (!confirmDiscard()) return;
    setSelectedIdentity(getPerformanceProfileTargetIdentity(target));
    setSession(sessionFromTarget(service, target));
    setSelectedCharacterId(target.profile.characters[0]?.id ?? '');
    setSearch('');
    setMessage(null);
  };

  const createTemplate = () => {
    if (!confirmDiscard()) return;
    const next = newSession(service);
    setSelectedIdentity('');
    setSession(next);
    setSelectedCharacterId('');
    setSearch('');
    setMessage(null);
  };

  const addCharacter = () => {
    if (!draft) return;
    const usedIds = new Set(draft.characters.map((character) => character.id));
    let index = 1;
    while (usedIds.has(`character.${index}`)) index += 1;
    const character = createCharacter(index - 1);
    setDraft((current) => ({ ...current, characters: [...current.characters, character] }));
    setSelectedCharacterId(character.id);
    setSearch('');
  };

  const updateCharacter = (update: (character: PerformanceProfileCharacterV1) => PerformanceProfileCharacterV1) => {
    if (!selectedCharacter) return;
    setDraft((current) => ({
      ...current,
      characters: current.characters.map((character) => (
        character === selectedCharacter ? update(character) : character
      )),
    }));
  };

  const removeCharacter = () => {
    if (!selectedCharacter || !window.confirm(`删除角色“${selectedCharacter.id}”及其全部动作和表情？`)) return;
    setDraft((current) => ({
      ...current,
      characters: current.characters.filter((character) => character !== selectedCharacter),
    }));
  };

  const addEntry = (kind: PerformanceProfileEntryKind) => {
    if (!selectedCharacter) return;
    const existing = selectedCharacter[kind] ?? [];
    const prefix = kind === 'motions' ? 'motion' : 'expression';
    let index = existing.length + 1;
    let key = `${selectedCharacter.id}/${prefix}.${index}`;
    const known = new Set(existing.map((entry) => entry.key));
    while (known.has(key)) {
      index += 1;
      key = `${selectedCharacter.id}/${prefix}.${index}`;
    }
    updateCharacter((character) => ({
      ...character,
      [kind]: [...(character[kind] ?? []), { key }],
    }));
    setSearch('');
  };

  const updateEntry = (
    kind: PerformanceProfileEntryKind,
    entryIndex: number,
    field: EntryField,
    value: string,
  ) => {
    updateCharacter((character) => ({
      ...character,
      [kind]: (character[kind] ?? []).map((entry, index) => (
        index === entryIndex
          ? { ...entry, [field]: value || (field === 'description' ? undefined : value) }
          : entry
      )),
    }));
  };

  const removeEntry = (kind: PerformanceProfileEntryKind, entryIndex: number) => {
    updateCharacter((character) => ({
      ...character,
      [kind]: (character[kind] ?? []).filter((_, index) => index !== entryIndex),
    }));
  };

  const handleSave = async () => {
    if (!session || !dirty || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await service.saveTemplate({
        draft: session.draft,
        originalTemplateId: session.originalTemplateId,
        originalProfileId: session.originalProfileId,
        expectedProfileFingerprint: session.sourceFingerprint,
      });
      setSelectedIdentity(`${result.templateId}\u0000${result.profileId}`);
      setSession({
        draft: clone(result.draft),
        baseline: draftFingerprint(result.draft),
        originalTemplateId: result.templateId,
        originalProfileId: result.profileId,
        sourceFingerprint: JSON.stringify({
          schemaVersion: 1,
          id: result.profileId,
          name: result.draft.profileName,
          characters: result.draft.characters,
        }),
      });
      setSelectedCharacterId((current) => (
        result.draft.characters.some((character) => character.id === current)
          ? current
          : result.draft.characters[0]?.id ?? ''
      ));
      setMessage({ kind: 'success', text: '模板已保存' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const visibleEntries = (kind: PerformanceProfileEntryKind) => {
    const term = search.trim().toLocaleLowerCase();
    return (selectedCharacter?.[kind] ?? [])
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (
        !term || `${entry.key} ${entry.description ?? ''}`.toLocaleLowerCase().includes(term)
      ));
  };
  const entries = visibleEntries(entryKind);
  const entryLabel = entryKind === 'motions' ? '动作' : '表情';

  return (
    <section className="template-performance-editor" aria-labelledby={`${editorId}-title`}>
      <header className="template-performance-editor__header">
        <div className="template-performance-editor__heading">
          <h3 id={`${editorId}-title`}>AI 表演模板</h3>
          {draft && enabledTemplateIds && (
            <span className="template-performance-editor__project-status">
              {currentTemplateEnabled ? '项目已启用' : '项目未启用'}
            </span>
          )}
        </div>
        <div className="template-performance-editor__header-actions">
          {draft && (
            <>
              {dirty && <span className="template-performance-editor__dirty" role="status">未保存</span>}
              <button className="btn" type="button" onClick={createTemplate} disabled={saving}>
                <IconPlus width={14} height={14} /> 新建模板
              </button>
              <button className="btn btn--primary" type="button" onClick={() => void handleSave()} disabled={!dirty || saving}>
                <IconSave width={15} height={15} /> {saving ? '正在保存…' : '保存模板'}
              </button>
            </>
          )}
        </div>
      </header>

      {draft ? (
        <fieldset className="template-performance-editor__form" disabled={saving} aria-label="表演模板编辑">
          <div className="template-performance-editor__selectors">
            <label className="template-performance-editor__field">
              <span>选择模板</span>
              <FormSelect
                value={selectedIdentity}
                options={templateOptions}
                aria-label="选择模板"
                disabled={saving}
                onChange={(value) => {
                  const target = targets.find((candidate) => getPerformanceProfileTargetIdentity(candidate) === value);
                  if (target) chooseTarget(target);
                }}
              />
            </label>
            <label className="template-performance-editor__field">
              <span>模板名称</span>
              <input className="form-input" value={draft.templateName} onChange={(event) => setDraft((current) => ({ ...current, templateName: event.target.value }))} />
            </label>
          </div>

          {selectedTarget && !selectedTarget.editable && <div className="template-performance-editor__read-only" role="note">{selectedTarget.readOnlyReason}</div>}
          {message && <div className={`template-performance-editor__message is-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}

          <div className="template-performance-editor__workspace">
            <aside className="template-performance-editor__characters" aria-label="模板角色">
              <div className="template-performance-editor__section-header">
                <h4>角色 <span className="template-performance-editor__count">{draft.characters.length}</span></h4>
                <button className="btn btn--icon" type="button" title="添加角色" aria-label="添加角色" onClick={addCharacter}>
                  <IconPlus width={14} height={14} />
                </button>
              </div>
              <div className="template-performance-editor__character-list">
                {draft.characters.map((character) => (
                  <button
                    key={character.id}
                    className={`template-performance-editor__character${character.id === selectedCharacter?.id ? ' is-active' : ''}`}
                    type="button"
                    aria-pressed={character.id === selectedCharacter?.id}
                    title={character.id}
                    onClick={() => {
                      setSelectedCharacterId(character.id);
                      setSearch('');
                    }}
                  >
                    <strong>{character.id}</strong>{' '}
                    {sceneCharacters && (
                      <span className={`template-performance-editor__match is-${(characterMatches.get(character.id.trim()) ?? UNMATCHED_TEMPLATE_CHARACTER).status}`}>
                        {(characterMatches.get(character.id.trim()) ?? UNMATCHED_TEMPLATE_CHARACTER).label}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </aside>

            <div className="template-performance-editor__character-editor">
              {selectedCharacter ? (
                <>
                  <div className="template-performance-editor__section-header">
                    <div className="template-performance-editor__heading">
                      <h4>角色信息</h4>
                      {sceneCharacters && (
                        <span className={`template-performance-editor__match is-${selectedMatch.status}`} role="status" aria-label="角色匹配结果">
                          {selectedMatch.label}
                        </span>
                      )}
                    </div>
                    <button className="btn template-performance-editor__delete-character" type="button" onClick={removeCharacter}>
                      <IconTrash width={14} height={14} /> 删除角色
                    </button>
                  </div>
                  <div className="template-performance-editor__character-meta">
                    <label className="template-performance-editor__field">
                      <span>角色 ID</span>
                      <input className="form-input" value={selectedCharacter.id} onChange={(event) => {
                        const previousId = selectedCharacter.id;
                        const nextId = event.target.value;
                        updateCharacter((character) => ({ ...character, id: nextId }));
                        setSelectedCharacterId((current) => current === previousId ? nextId : current);
                      }} />
                    </label>
                    <label className="template-performance-editor__field">
                      <span>别名（逗号分隔）</span>
                      <input
                        className="form-input"
                        value={(selectedCharacter.aliases ?? []).join('，')}
                        onChange={(event) => updateCharacter((character) => ({
                          ...character,
                          aliases: parseAliases(event.target.value),
                        }))}
                      />
                    </label>
                  </div>
                  <div className="template-performance-editor__entry-toolbar">
                    <div className="settings-dialog__segmented" role="tablist" aria-label="表演词条">
                      {(['motions', 'expressions'] as const).map((kind) => (
                        <button
                          key={kind}
                          id={`${editorId}-${kind}-tab`}
                          className={`btn settings-dialog__segmented-option${entryKind === kind ? ' is-active' : ''}`}
                          type="button"
                          role="tab"
                          aria-selected={entryKind === kind}
                          aria-controls={`${editorId}-${kind}-panel`}
                          tabIndex={entryKind === kind ? 0 : -1}
                          onClick={() => setEntryKind(kind)}
                          onKeyDown={(event) => {
                            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                            event.preventDefault();
                            const nextKind = event.key === 'Home' ? 'motions' : event.key === 'End' ? 'expressions' : kind === 'motions' ? 'expressions' : 'motions';
                            setEntryKind(nextKind);
                            document.getElementById(`${editorId}-${nextKind}-tab`)?.focus();
                          }}
                        >
                          {kind === 'motions' ? '动作' : '表情'}
                          <span className="template-performance-editor__count">{visibleEntries(kind).length}</span>
                        </button>
                      ))}
                    </div>
                    <input
                      className="form-input template-performance-editor__search"
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      aria-label="搜索动作或表情"
                      placeholder="搜索键名或描述"
                    />
                  </div>

                  <section id={`${editorId}-${entryKind}-panel`} className="template-performance-editor__entries" role="tabpanel" aria-labelledby={`${editorId}-${entryKind}-tab`} tabIndex={0}>
                    <div className="template-performance-editor__section-header">
                      <h4>{entryLabel}词条</h4>
                      <button className="btn" type="button" onClick={() => addEntry(entryKind)}>
                        <IconPlus width={13} height={13} /> 添加{entryLabel}
                      </button>
                    </div>
                    {entries.length > 0 ? (
                      <div className="template-performance-editor__entry-list">
                        <div className="template-performance-editor__entry-columns" aria-hidden="true">
                          <span>资源键</span><span>AI 描述</span>
                        </div>
                        {entries.map(({ entry, index }) => (
                          <div key={`${entryKind}:${index}`} className="template-performance-editor__entry">
                            <input
                              className="form-input template-performance-editor__entry-key"
                              value={entry.key}
                              onChange={(event) => updateEntry(entryKind, index, 'key', event.target.value)}
                              aria-label={`${entryLabel}键`}
                            />
                            <textarea
                              className="form-input template-performance-editor__description"
                              value={entry.description ?? ''}
                              rows={2}
                              onChange={(event) => updateEntry(entryKind, index, 'description', event.target.value)}
                              aria-label={`${entry.key} 的 AI 描述`}
                            />
                            <button className="btn btn--icon" type="button" title="删除词条" aria-label={`删除 ${entry.key}`} onClick={() => removeEntry(entryKind, index)}>
                              <IconTrash width={13} height={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="template-performance-editor__empty">
                        <span>{search.trim() ? '没有匹配的词条' : `暂无${entryLabel}`}</span>
                        {search.trim() && <button className="btn" type="button" onClick={() => setSearch('')}>清除搜索</button>}
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <div className="template-performance-editor__empty template-performance-editor__empty--large">
                  <strong>这个模板还没有角色</strong>
                  <button className="btn btn--primary" type="button" onClick={addCharacter}><IconPlus width={14} height={14} /> 添加第一个角色</button>
                </div>
              )}
            </div>
          </div>
        </fieldset>
      ) : (
        <div className="template-performance-editor__empty template-performance-editor__empty--large">
          <strong>还没有 AI 表演模板</strong>
          <button className="btn btn--primary" type="button" onClick={createTemplate}><IconPlus width={14} height={14} /> 新建模板</button>
        </div>
      )}
    </section>
  );
}
