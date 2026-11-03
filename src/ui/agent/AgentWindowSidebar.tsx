import { useMemo, useState } from 'react';
import {
  conversationDisplayTitle,
  type ProjectAgentProjectContext,
  type ProjectAgentTaskStatusPayload,
} from '../../api/types/project-agent-ipc';
import type { ProjectAgentJournalRecord } from '../../services/project-agent/ProjectAgentJournal';
import {
  IconPlus,
  IconSearch,
  IconFolder,
  IconCheck,
  IconX,
  IconTrash,
  IconPencil,
  IconSettings,
} from '../icons';
import { conversationDotClass, conversationUpdatedAt, formatRelativeTime } from './agentWindowPresentation';

interface AgentWindowSidebarProps {
  context: ProjectAgentProjectContext | null;
  records: readonly ProjectAgentJournalRecord[];
  statuses: ReadonlyMap<string, ProjectAgentTaskStatusPayload>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  newConversation: () => void;
  openSettings: () => void;
  onClearError: () => void;
  commitRename: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<boolean>;
}
export function AgentWindowSidebar({
  context,
  records,
  statuses,
  selectedId,
  setSelectedId,
  newConversation,
  openSettings,
  onClearError,
  commitRename,
  deleteConversation,
}: AgentWindowSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const filteredRecords = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return records;
    return records.filter((record) => (
      conversationDisplayTitle(record).toLowerCase().includes(query)
    ));
  }, [records, searchQuery]);

  const saveRename = async (id: string) => {
    await commitRename(id, renameDraft);
    setRenamingId(null);
    setRenameDraft('');
  };

  const confirmDelete = async (id: string) => {
    if (await deleteConversation(id)) setDeleteConfirmId(null);
  };

  return (
    <aside className="agent-sidebar">
      <div className="agent-sidebar__top">
        <button
          type="button"
          className="agent-sidebar__action agent-sidebar__action--new"
          onClick={() => {
            setSearchOpen(false);
            setSearchQuery('');
            setDeleteConfirmId(null);
            setRenamingId(null);
            newConversation();
          }}
          title="发起新对话"
        >
          <IconPlus width={15} height={15} />
          <span>新对话</span>
        </button>
        <button
          type="button"
          className={`agent-sidebar__action agent-sidebar__action--icon ${searchOpen ? 'agent-sidebar__action--active' : ''}`}
          onClick={() => setSearchOpen((open) => !open)}
          title="搜索对话"
          aria-label="搜索"
        >
          <IconSearch width={15} height={15} />
        </button>
      </div>

      {searchOpen && (
        <div className="agent-sidebar__search">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索对话…"
            aria-label="搜索对话"
          />
        </div>
      )}

      <div className="agent-sidebar__section">
        <h3 className="agent-sidebar__section-title">项目</h3>
        {context ? (
          <div className="agent-sidebar__project agent-sidebar__project--active">
            <span className="agent-sidebar__project-icon" aria-hidden="true">
              <IconFolder width={15} height={15} />
            </span>
            <span className="agent-sidebar__project-text">
              <strong>{context.projectName}</strong>
              {context.sceneName && <em>{context.sceneName}</em>}
            </span>
          </div>
        ) : (
          <p className="agent-sidebar__empty">未打开项目</p>
        )}
      </div>

      <div className="agent-sidebar__section agent-sidebar__section--grow">
        <h3 className="agent-sidebar__section-title">对话</h3>
        <ul className="agent-sidebar__convs" aria-label="对话列表">
          {filteredRecords.map((record) => {
            const id = record.identity.taskId;
            const status = statuses.get(id) ?? null;
            const active = id === selectedId;
            const renaming = id === renamingId;
            const deleting = id === deleteConfirmId;
            return (
              <li
                key={id}
                className={`agent-sidebar__conv ${active ? 'agent-sidebar__conv--active' : ''}`}
              >
                {renaming ? (
                  <div className="agent-sidebar__conv-rename">
                    <input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          void saveRename(id);
                        } else if (event.key === 'Escape') {
                          setRenamingId(null);
                          }
                      }}
                      onFocus={(event) => event.target.select()}
                      placeholder="对话名称"
                      aria-label="对话名称"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="agent-sidebar__conv-iconbtn"
                      onClick={() => void saveRename(id)}
                      aria-label="保存名称"
                      title="保存"
                    >
                      <IconCheck width={13} height={13} />
                    </button>
                    <button
                      type="button"
                      className="agent-sidebar__conv-iconbtn"
                      onClick={() => setRenamingId(null)}
                      aria-label="取消重命名"
                      title="取消"
                    >
                      <IconX width={13} height={13} />
                    </button>
                  </div>
                ) : deleting ? (
                  <div className="agent-sidebar__conv-delete">
                    <span>删除此对话？</span>
                    <button
                      type="button"
                      className="agent-sidebar__conv-iconbtn agent-sidebar__conv-iconbtn--danger"
                      onClick={() => void confirmDelete(id)}
                      title="确认删除"
                    >
                      <IconTrash width={13} height={13} />
                    </button>
                    <button
                      type="button"
                      className="agent-sidebar__conv-iconbtn"
                      onClick={() => setDeleteConfirmId(null)}
                      title="取消"
                    >
                      <IconX width={13} height={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="agent-sidebar__conv-row"
                    onClick={() => {
                      setSelectedId(id);
                      onClearError();
                    }}
                  >
                    <span
                      className={`agent-sidebar__conv-dot ${conversationDotClass(status)}`}
                      aria-hidden="true"
                    />
                    <span className="agent-sidebar__conv-text" title={conversationDisplayTitle(record)}>
                      {conversationDisplayTitle(record)}
                    </span>
                    <span className="agent-sidebar__conv-time">
                      {formatRelativeTime(conversationUpdatedAt(record, status))}
                    </span>
                    <span className="agent-sidebar__conv-actions">
                      <span
                        role="button"
                        tabIndex={0}
                        className="agent-sidebar__conv-iconbtn"
                        aria-label="重命名对话"
                        title="重命名"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRenameDraft(conversationDisplayTitle(record));
                          setRenamingId(id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.stopPropagation();
                            setRenameDraft(conversationDisplayTitle(record));
                            setRenamingId(id);
                            }
                        }}
                      >
                        <IconPencil width={13} height={13} />
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className="agent-sidebar__conv-iconbtn"
                        aria-label="删除对话"
                        title="删除对话"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeleteConfirmId(id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.stopPropagation();
                            setDeleteConfirmId(id);
                            }
                        }}
                      >
                        <IconTrash width={13} height={13} />
                      </span>
                    </span>
                  </button>
                )}
              </li>
              );
          })}
        </ul>
        {filteredRecords.length === 0 && (
          <p className="agent-sidebar__empty">
            {searchQuery ? '没有匹配的对话' : '暂无对话，发起第一个吧'}
          </p>
        )}
      </div>

      <div className="agent-sidebar__footer">
        <button
          type="button"
          className="agent-sidebar__action agent-sidebar__action--footer"
          onClick={openSettings}
        >
          <IconSettings width={15} height={15} />
          <span>设置</span>
        </button>
      </div>
    </aside>

  );
}
