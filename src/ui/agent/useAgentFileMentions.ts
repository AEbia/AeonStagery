import React, { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

const EXCLUDED_FILE_DIRS = new Set([
  '.git',
  '.generated',
  '.impeccable',
  '.scratch',
  '.superpowers',
  'node_modules',
  'dist',
  'dist-electron',
  'coverage',
  'test-results',
  'release',
]);

async function listProjectFiles(root: string): Promise<string[]> {
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
    if (depth > 4 || seen.size >= 500) return;
    const result = await window.aeonStageryAPI?.fs.readDir(dir);
    if (!result?.success || !result.data) return;
    for (const entry of result.data) {
      if (seen.size >= 500) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (EXCLUDED_FILE_DIRS.has(entry.name)) continue;
        await walk(entry.path, depth + 1, relative);
      } else {
        seen.add(relative);
      }
    }
  };
  await walk(root, 1, '');
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function useAgentFileMentions(draft: string, setDraft: Dispatch<SetStateAction<string>>, projectRoot: string | undefined, clearError: () => void) {
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionFilesRef = useRef<string[]>([]);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const handleDraftChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setDraft(next);
    clearError();
    const cursor = event.target.selectionStart ?? next.length;
    const before = next.slice(0, cursor);
    const match = /(^|\s)(@[^\s]*)$/.exec(before);
    if (match) {
      const wordStart = cursor - match[2].length;
      mentionRangeRef.current = { start: wordStart, end: cursor };
      setMentionFilter(match[2].slice(1).toLowerCase());
      setMentionIndex(0);
      if (!mentionOpen) {
        setMentionOpen(true);
        if (projectRoot && mentionFilesRef.current.length === 0) {
          void listProjectFiles(projectRoot).then((files) => {
            mentionFilesRef.current = files;
            setMentionFiles(files);
          });
        }
      }
    } else {
      mentionRangeRef.current = null;
      setMentionOpen(false);
    }
  };

  const insertMention = (path: string) => {
    const range = mentionRangeRef.current;
    const textarea = draftRef.current;
    if (!range || !textarea) {
      setMentionOpen(false);
      return;
    }
    const next = `${draft.slice(0, range.start)}@${path}${draft.slice(range.end)}`;
    setDraft(next);
    setMentionOpen(false);
    mentionRangeRef.current = null;
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = range.start + path.length + 1;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const mentionCandidates = useMemo(() => {
    if (!mentionFilter) return mentionFiles;
    return mentionFiles.filter((path) => {
      const name = path.split('/').pop()?.toLowerCase() ?? '';
      return path.toLowerCase().includes(mentionFilter) || name.includes(mentionFilter);
    });
  }, [mentionFiles, mentionFilter]);

  return {
    draftRef,
    mentionOpen,
    setMentionOpen,
    mentionIndex,
    setMentionIndex,
    mentionFiles,
    mentionCandidates,
    handleDraftChange,
    insertMention,
  };
}

export type AgentFileMentions = ReturnType<typeof useAgentFileMentions>;
