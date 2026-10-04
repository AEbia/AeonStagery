import React from 'react';
import { eventBus } from '../../api/events';
import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import type { CollaborationConnectionStatus } from '../../api/types/collaboration';
import type { ResourceImportKind } from '../../api/types/project';
import { templateAuthoringComboToSemanticIntent } from '../../services/template-package';
import { showToast } from '../Toast';
import { getTemplateResourceFileService } from '../TemplateResourceFiles';
import type { TemplateResourceFileReference } from '../../services/template-package/TemplateResourceFileService';
import { useCollaborationStatus, useSceneAssetService, useSemanticAuthoringService, useTemplatePackageCatalog } from '../context/AppContext';
import { createSemanticTimelineCorrelationId } from './semanticTimelineEditing';
import { createSemanticStatementDraftForResource } from './semanticStatementBlocks';
import type { TimelineScene } from './semanticTimelineTypes';

interface TimelineDropOptions {
  areaRef: React.RefObject<HTMLDivElement | null>;
  trackRefs: React.RefObject<Map<string, HTMLDivElement>>;
  sceneData: TimelineScene | null;
  pps: number;
}

export function useTimelineDrop({
  areaRef,
  trackRefs,
  sceneData,
  pps,
}: TimelineDropOptions) {
  const semanticAuthoring = useSemanticAuthoringService();
  const sceneAssetService = useSceneAssetService();
  const templateCatalog = useTemplatePackageCatalog();
  const collaborationStatus = useCollaborationStatus();
  const collaborationStatusRef = React.useRef(collaborationStatus);
  collaborationStatusRef.current = collaborationStatus;
  const templatePackageSnapshot = React.useSyncExternalStore(
    templateCatalog ? (listener) => templateCatalog.subscribe(listener) : () => () => {},
    templateCatalog ? () => templateCatalog.getPackages() : getStableEmptyPackages,
    getStableEmptyPackages,
  );
  const availableTemplates = React.useMemo(
    () => {
      // The external-store snapshot invalidates this memo when packages change;
      // the catalog remains the source of truth for combo derivation.
      void templatePackageSnapshot;
      return templateCatalog?.getSemanticAuthoringCombos() ?? [];
    },
    [templateCatalog, templatePackageSnapshot],
  );

  const getDropCharId = (clientY: number): string | null => {
    if (!areaRef.current) return null;
    let best: { id: string | null; dist: number } = { id: null, dist: Infinity };

    trackRefs.current?.forEach((rowEl, trackId) => {
      if (!rowEl) return;
      const r = rowEl.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        const center = (r.top + r.bottom) / 2;
        const dist = Math.abs(clientY - center);
        if (dist < best.dist) {
          best = { id: trackId.startsWith('char:') ? trackId.slice(5) : null, dist };
        }
      }
    });
    return best.id;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = isSharedEditingPaused(collaborationStatusRef.current) ? 'none' : 'copy';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const json = e.dataTransfer.getData('application/json');
    if (!json || !sceneData) return;

    let payload: { type: string; actionType?: string; templateId?: string; filePath?: string; sourcePath?: string; sourceKind?: string; templateResource?: TemplateResourceFileReference };
    try {
      payload = JSON.parse(json);
    } catch {
      return;
    }

    if (payload.type !== 'action' && payload.type !== 'template' && payload.type !== 'resource') return;
    if (isSharedEditingPaused(collaborationStatusRef.current)) {
      showToast(getSharedEditingPausedMessage(collaborationStatusRef.current), 'warning');
      return;
    }

    const areaEl = areaRef.current;
    if (!areaEl) return;

    const areaRect = areaEl.getBoundingClientRect();
    const labelWidth = 100;
    const offsetX = e.clientX - areaRect.left - labelWidth;
    const dropTime = Math.max(0, Math.round(offsetX / pps * 10) / 10);

    const charId = getDropCharId(e.clientY);
    const scope = charId
      ? { kind: 'inferred-character' as const, charId, source: 'drop-target' as const }
      : { kind: 'none' as const };

    if (!semanticAuthoring) return;

    if (payload.type === 'resource' || payload.type === 'action') {
      const requestedFilePath = payload.filePath ?? payload.sourcePath ?? '';
      const sourcePath = requestedFilePath.replace(/\\/g, '/');
      const sourceKind = inferDraftSourceKind(payload.sourceKind, sourcePath);
      let authoredFilePath = sourcePath;
      if (payload.templateResource) {
        try {
          const templates = getTemplateResourceFileService();
          if (!templates) throw new Error('模板资源服务不可用，请重新打开项目后重试。');
          authoredFilePath = await templates.importFile(payload.templateResource, sourcePath, inferResourceImportKind(payload.sourceKind, sourcePath));
        } catch (error) {
          showToast(`模板资源导入失败，未插入语句：${error instanceof Error ? error.message : String(error)}`, 'error');
          return;
        }
      } else if (sceneAssetService) {
        try {
          const importedPath = await sceneAssetService.importAssetPath(
            sourcePath,
            inferResourceImportKind(payload.sourceKind, sourcePath),
          );
          if (importedPath?.trim()) {
            authoredFilePath = importedPath;
          } else {
            showToast('资源导入未返回路径；已插入待确认资源语句，请在检查器中修正。', 'warning');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : '资源导入失败';
          showToast(`资源导入失败，已插入待确认资源语句：${message}`, 'warning');
        }
      } else {
        showToast('资源服务不可用；已插入待确认资源语句，请在检查器中修正。', 'warning');
      }
      const statement = createSemanticStatementDraftForResource({
        sceneMeta: sceneData.meta,
        charId,
        filePath: authoredFilePath,
        sourceKind,
      });
      if (!statement) {
        showToast('无法识别该资源，未插入语句；请检查文件类型和路径。', 'warning');
        return;
      }
      if (isSharedEditingPaused(collaborationStatusRef.current)) {
        showToast(`${getSharedEditingPausedMessage(collaborationStatusRef.current)}资源未插入语句。`, 'warning');
        return;
      }
      await semanticAuthoring.author({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: createSemanticTimelineCorrelationId('timeline_drop_resource'),
        origin: 'timeline-drop',
        scope,
        kind: 'insert-statement',
        anchorTime: dropTime,
        statement,
      });
    }

    if (payload.type === 'template' && payload.templateId) {
      const combo = availableTemplates.find((candidate) => candidate.id === payload.templateId);
      const intent = combo
        ? templateAuthoringComboToSemanticIntent(combo, {
            anchorTime: dropTime,
            correlationId: createSemanticTimelineCorrelationId('timeline_drop_template'),
            origin: 'timeline-drop',
            scope,
          })
        : null;
      if (!intent) return;
      await semanticAuthoring.author(intent);
    }

    eventBus.emit('ui:switchTab', { tab: 'timeline' });
  };

  return { handleDragOver, handleDrop, getDropCharId };
}

const stableEmptyPackages: never[] = [];
const getStableEmptyPackages = () => stableEmptyPackages;

function isSharedEditingPaused(status: CollaborationConnectionStatus): boolean {
  return status === 'offline' || status === 'reconnecting';
}

function getSharedEditingPausedMessage(status: CollaborationConnectionStatus): string {
  return status === 'reconnecting'
    ? '共享编辑已暂停；实时通道恢复后才能继续编辑。'
    : '共享编辑已暂停；请手动重连后才能继续编辑。';
}

function normalizeResourceKind(sourceKind: string | undefined): string | undefined {
  const normalized = typeof sourceKind === 'string'
    ? sourceKind.trim().replace(/\\/g, '/').split('/')[0]
    : '';
  return normalized || undefined;
}

function inferDraftSourceKind(sourceKind: string | undefined, filePath: string): string | undefined {
  const normalized = normalizeResourceKind(sourceKind);
  if (normalized) return normalized;

  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(lower)) return 'images';
  if (/\.(mp3|wav|ogg|flac|m4a)$/.test(lower)) return 'sfx';
  if (/\.(model3?\.json|wmdl|json)$/.test(lower)) return 'figure';
  if (/\.html?$/.test(lower)) return 'animation';
  return undefined;
}

function inferResourceImportKind(sourceKind: string | undefined, filePath: string): ResourceImportKind {
  const topLevel = normalizeResourceKind(sourceKind);
  if (topLevel === 'figure') return 'figure';
  if (topLevel === 'background') return 'background';
  if (topLevel === 'bgm') return 'bgm';
  if (topLevel === 'vocal') return 'vocal';
  if (topLevel === 'animation') return 'animation';
  if (topLevel === 'images') return 'images';
  if (topLevel === 'project') return 'project';
  if (topLevel === 'template') return 'template';
  if (topLevel === 'sfx') return 'generic';

  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg)$/.test(lower)) return 'images';
  if (/\.(mp3|wav|ogg|flac|m4a)$/.test(lower)) return 'bgm';
  if (/\.(model3?\.json|wmdl|json)$/.test(lower)) return 'figure';
  if (/\.html?$/.test(lower)) return 'animation';
  return 'generic';
}
