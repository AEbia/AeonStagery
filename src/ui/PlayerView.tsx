/**
 * AeonStagery — Player View (Scene Info Panel)
 *
 * Shows current scene information and script loading status.
 * Will be expanded into a full timeline editor in Phase 4.
 */

import { useState, useCallback } from 'react';
import { useSceneFileService } from './context/AppContext';
import { IconFileText, IconFilm, IconFolder } from './icons';

export function PlayerView() {
  const [sceneInfo, setSceneInfo] = useState<string>('');
  const sceneFileService = useSceneFileService();
  const [sceneContent, setSceneContent] = useState<string>('');

  const handleLoadScene = useCallback(async () => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: 'Load Scene Script',
      filters: [{ name: 'Scene Script', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (!result.canceled && result.filePaths?.[0]) {
      try {
        const fileResult = await window.aeonStageryAPI.fs.readTextFile(result.filePaths[0]);
        if (fileResult.success && fileResult.data) {
          setSceneContent(fileResult.data);
          const parsed = JSON.parse(fileResult.data);
          setSceneInfo(`${parsed.meta?.title ?? 'Untitled'} — ${parsed.timeline?.length ?? 0} actions`);
          await sceneFileService?.loadFromPath(result.filePaths[0]);
        }
      } catch (err: any) {
        setSceneInfo(`Error: ${err.message}`);
      }
    }
  }, [sceneFileService]);

  return (
    <div>
      <button className="btn" onClick={handleLoadScene} style={{ width: '100%', marginBottom: 12 }}>
        <IconFolder width={14} height={14} /> Load Scene JSON
      </button>

      {sceneInfo && (
        <div className="character-card">
          <div className="character-card__name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconFilm width={14} height={14} />
            {sceneInfo}
          </div>
          {sceneContent && (
            <pre style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              maxHeight: 300,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              marginTop: 8,
            }}>
              {sceneContent.slice(0, 2000)}
              {sceneContent.length > 2000 ? '\n...(truncated)' : ''}
            </pre>
          )}
        </div>
      )}

      {!sceneInfo && (
        <div className="empty-state">
          <IconFileText className="empty-state__icon" width={28} height={28} />
          <div className="empty-state__text">
            No scene loaded.<br />
            Load a JSON scene script to begin.
          </div>
        </div>
      )}
    </div>
  );
}

export default PlayerView;
