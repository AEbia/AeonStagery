import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  useStageAdapter,
  useCharacterAdapter,
  useDocumentStore,
  useEditorStore,
  useSemanticAuthoringService,
} from './context/AppContext';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { usePointerDrag } from './hooks/usePointerDrag';
import { useEditorSettings } from './store/storeHooks';
import { buildSemanticTimelineReadModel } from './timeline/semanticTimelineReadModel';

const headPoint = { x: 0, y: 0 };
const chestPoint = { x: 0, y: 0 };

function createStageOverlayCorrelationId(): string {
  return `stage_overlay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function StageOverlay() {
  const { gizmosVisible } = useEditorSettings();
  const stageAdapter = useStageAdapter();
  const characterAdapter = useCharacterAdapter();
  const documentStore = useDocumentStore();
  const editorStore = useEditorStore();
  const selectedActionIds = editorStore.selectedActionIds;
  const semanticAuthoring = useSemanticAuthoringService();
  const [activeCharacters, setActiveCharacters] = useState<string[]>([]);
  const [dragOverrides, setDragOverrides] = useState<{ [idx: number]: [number, number] }>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const markersContainerRef = useRef<SVGGElement>(null);

  useEffect(() => {
    setActiveCharacters(characterAdapter.listCharacters());

    const charInterval = setInterval(() => {
      const newList = characterAdapter.listCharacters();
      setActiveCharacters(prev => {
        if (prev.length !== newList.length || prev.some((v, i) => v !== newList[i])) {
          return newList;
        }
        return prev;
      });
    }, 500);

    return () => clearInterval(charInterval);
  }, [characterAdapter]);

  const selIds = Object.keys(selectedActionIds).filter(id => selectedActionIds[id]);
  const selectedActionId = selIds.length === 1 ? selIds[0] : null;
  const semanticTimelineItems = useMemo(
    () => buildSemanticTimelineReadModel(
      documentStore.getCurrentSceneDocumentSnapshot(),
      documentStore.getCompiledSceneSnapshot(),
    ),
    [documentStore],
  );
  const timelineActions = semanticTimelineItems.map((item) => item.displayAction);
  const selectedAction = selectedActionId
    ? timelineActions.find((action) => action._id === selectedActionId)
    : null;

  const dragKeyframeIdxRef = useRef<number | null>(null);

  const keyframeDragHook = usePointerDrag({
    getKeys: () => {
      const idx = dragKeyframeIdxRef.current;
      if (idx === null || !selectedAction) return { x: 0.5, y: 0.5 };
      const kf = selectedAction.params.keyframes?.[idx];
      let x = 0.5;
      let y = 0.5;
      if (kf) {
        if (Array.isArray(kf.position) && kf.position.length >= 2) {
          x = kf.position[0] ?? 0.5;
          y = kf.position[1] ?? 0.5;
        } else if (kf.position && typeof kf.position.x === 'number') {
          x = kf.position.x;
          y = kf.position.y ?? 0.5;
        }
      }
      return { x, y };
    },
    getSnapConfig: () => ({
      gridStep: 0,
      thresholdPx: 0,
      pixelsPerUnit: 1,
    }),
    deltaMapper: (dx, dy) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: dx / rect.width,
        y: dy / rect.height,
      };
    },
    onDragUpdate: (_snappedDeltas, finalValues, _isFinal) => {
      const idx = dragKeyframeIdxRef.current;
      if (idx === null) return;
      const finalX = Math.max(0, Math.min(1, finalValues.x ?? 0.5));
      const finalY = Math.max(0, Math.min(1, finalValues.y ?? 0.5));

      setDragOverrides(prev => ({
        ...prev,
        [idx]: [finalX, finalY],
      }));
    },
    onDragEnd: (_finalDeltas, finalValues) => {
      const idx = dragKeyframeIdxRef.current;
      if (idx === null || !selectedActionId) return;

      const finalX = Math.max(0, Math.min(1, finalValues.x ?? 0.5));
      const finalY = Math.max(0, Math.min(1, finalValues.y ?? 0.5));

      const compiledAction = documentStore.getCompiledSceneSnapshot()?.actions.find((action) => action.id === selectedActionId);
      const sourceDocument = documentStore.getCurrentSceneDocumentSnapshot();
      const sourceStatement = sourceDocument?.statements.find((statement) => statement.id === compiledAction?.source.statementId);
      if (
        semanticAuthoring &&
        compiledAction?.source.outputKey === 'primary' &&
        sourceStatement?.type === 'camera' &&
        sourceStatement.params.mode === 'path'
      ) {
        const keyframes = [...sourceStatement.params.keyframes];
        if (keyframes[idx]) {
          keyframes[idx] = { ...keyframes[idx], position: [finalX, finalY] };
          void semanticAuthoring.author({
            version: AUTHORING_SCHEMA_VERSION,
            correlationId: createStageOverlayCorrelationId(),
            origin: 'timeline-editor',
            kind: 'update-statement',
            statementId: sourceStatement.id,
            patch: {
              params: {
                ...sourceStatement.params,
                keyframes,
              },
            },
          }).catch((error) => {
            console.warn('[StageOverlay] Failed to update semantic camera path', error);
          });
        }
      }

      setDragOverrides(prev => {
        const next = { ...prev };
        delete next[idx];
        return next;
      });
      dragKeyframeIdxRef.current = null;
    },
  });

  // ─── High Performance Loop ───
  useEffect(() => {
    if (!gizmosVisible) return;

    let frameId: number;
    const isLowPerf = document.documentElement.getAttribute('data-perf') === 'low';
    let lastUpdate = 0;

    const updatePositions = (time: number) => {
      frameId = requestAnimationFrame(updatePositions);

      const throttleMs = isLowPerf ? 66 : 0;
      if (time - lastUpdate < throttleMs) return;
      lastUpdate = time;

      const markers = markersContainerRef.current?.children;
      if (!markers) return;

      for (let i = 0; i < markers.length; i++) {
        const group = markers[i] as SVGGElement;
        const charId = group.getAttribute('data-char-id');
        if (!charId) continue;

        const head = characterAdapter.getPoint(charId, 'head', headPoint);
        const chest = characterAdapter.getPoint(charId, 'chest', chestPoint);

        if (head && chest) {
          const headCircle = group.querySelector('.head-marker') as SVGCircleElement;
          const headText = group.querySelector('.head-text') as SVGTextElement;
          if (headCircle) {
            headCircle.setAttribute('cx', String(head.x * 1920));
            headCircle.setAttribute('cy', String(head.y * 1080));
            headCircle.setAttribute('visibility', 'visible');
          }
          if (headText) {
            headText.setAttribute('x', String(head.x * 1920));
            headText.setAttribute('y', String(head.y * 1080 - 15));
            headText.setAttribute('visibility', 'visible');
          }

          const chestCircle = group.querySelector('.chest-marker') as SVGCircleElement;
          if (chestCircle) {
            chestCircle.setAttribute('cx', String(chest.x * 1920));
            chestCircle.setAttribute('cy', String(chest.y * 1080));
            chestCircle.setAttribute('visibility', 'visible');
          }

          const focusGroup = group.querySelector('.focus-group') as SVGGElement;
          if (focusGroup) {
            const focusX = parseFloat(focusGroup.getAttribute('data-focus-x') || '0');
            const focusY = parseFloat(focusGroup.getAttribute('data-focus-y') || '0');
            const targetX = (head.x + focusX * 0.1) * 1920;
            const targetY = (head.y - focusY * 0.1) * 1080;
            
            const line = focusGroup.querySelector('line');
            const circle = focusGroup.querySelector('circle');
            if (line) {
              line.setAttribute('x1', String(head.x * 1920));
              line.setAttribute('y1', String(head.y * 1080));
              line.setAttribute('x2', String(targetX));
              line.setAttribute('y2', String(targetY));
            }
            if (circle) {
              circle.setAttribute('cx', String(targetX));
              circle.setAttribute('cy', String(targetY));
            }
          }
        }
      }
    };

    frameId = requestAnimationFrame(updatePositions);
    return () => cancelAnimationFrame(frameId);
  }, [activeCharacters, characterAdapter, gizmosVisible, selectedAction]);

  if (!gizmosVisible) return null;

  const handleStageClick = (e: React.MouseEvent) => {
    if (!selectedAction || selectedAction.action !== 'characterLookAt' || !selectedActionId) return;

    const canvas = stageAdapter.getCanvas();
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();

    const stageX = (e.clientX - canvasRect.left) / canvasRect.width;
    const stageY = (e.clientY - canvasRect.top) / canvasRect.height;

    const charId = selectedAction.params.id;
    const headPoint = characterAdapter.getPoint(charId, 'head');
    if (!headPoint) return;

    const focusX = Math.max(-1, Math.min(1, (stageX - headPoint.x) * 4));
    const focusY = Math.max(-1, Math.min(1, (headPoint.y - stageY) * 4));

    const compiledAction = documentStore.getCompiledSceneSnapshot()?.actions.find((action) => action.id === selectedActionId);
    const sourceDocument = documentStore.getCurrentSceneDocumentSnapshot();
    const sourceStatement = sourceDocument?.statements.find((statement) => statement.id === compiledAction?.source.statementId);
    if (
      semanticAuthoring &&
      compiledAction?.source.outputKey === 'lookAt' &&
      sourceStatement?.type === 'characterPerformance'
    ) {
      const point = [parseFloat(focusX.toFixed(2)), parseFloat(focusY.toFixed(2))] as [number, number];
      void semanticAuthoring.author({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: createStageOverlayCorrelationId(),
        origin: 'timeline-editor',
        kind: 'update-statement',
        statementId: sourceStatement.id,
        patch: {
          params: {
            ...sourceStatement.params,
            lookAt: {
              ...(sourceStatement.params.lookAt ?? {}),
              point,
            },
          },
        },
      }).catch((error) => {
        console.warn('[StageOverlay] Failed to update semantic lookAt point', error);
      });
    }

    characterAdapter.lookAt(charId, focusX, focusY, 0.1);
  };

  return (
    <div 
      ref={containerRef}
      className="stage-overlay"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 99999,
        overflow: 'visible',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onClick={handleStageClick}
    >
      <svg 
        ref={svgRef}
        style={{ 
          width: '100%', 
          height: '100%', 
          position: 'absolute',
          pointerEvents: 'none',
          overflow: 'visible' 
        }} 
        viewBox="0 0 1920 1080" 
        preserveAspectRatio="xMidYMid meet"
      >
        <g ref={markersContainerRef}>
          {activeCharacters.map(id => {
            const isSelectedChar = selectedAction?.params.id === id || selectedAction?.params.speakerId === id;
            return (
              <g key={id} data-char-id={id} style={{ opacity: isSelectedChar ? 1 : 0.3 }}>
                <circle className="head-marker" r="10" fill="#3b82f6" stroke="white" strokeWidth="2" visibility="hidden" />
                <text className="head-text" textAnchor="middle" fill="#3b82f6" fontSize="14" fontWeight="bold" stroke="white" strokeWidth="0.5" visibility="hidden">HEAD</text>
                <circle className="chest-marker" r="10" fill="#10b981" stroke="white" strokeWidth="2" visibility="hidden" />
              </g>
            );
          })}
        </g>

        {selectedAction?.action === 'cameraMove' && (
          <g className="camera-group"
             data-tx={(selectedAction.params.target?.x ?? selectedAction.params.target?.[0] ?? selectedAction.params.position?.x ?? 0.5) * 1920}
             data-ty={(selectedAction.params.target?.y ?? selectedAction.params.target?.[1] ?? selectedAction.params.position?.y ?? 0.5) * 1080}
          >
            <circle r="15" fill="none" stroke="var(--color-camera)" strokeWidth="3" />
            <line stroke="var(--color-camera)" strokeWidth="2" />
            <line stroke="var(--color-camera)" strokeWidth="2" />
          </g>
        )}

        {/* Camera Path Visual Editor */}
        {selectedAction?.action === 'cameraPath' && (() => {
          const keyframes: any[] = selectedAction?.params?.keyframes || [];
          if (keyframes.length < 2) return null;

          const stageW = 1920;
          const stageH = 1080;

          // Build positioned keyframe points, preserving original array index
          const points = keyframes
            .map((kf: any, idx: number) => {
              let pos: [number, number] | null = null;
              if (dragOverrides[idx]) {
                pos = dragOverrides[idx];
              } else if (Array.isArray(kf.position) && kf.position.length >= 2) {
                pos = [kf.position[0] ?? 0.5, kf.position[1] ?? 0.5];
              } else if (kf.position && typeof kf.position.x === 'number') {
                pos = [kf.position.x, kf.position.y ?? 0.5];
              }
              if (!pos) return null;
              return {
                x: pos[0] * stageW,
                y: pos[1] * stageH,
                time: kf.time ?? 0,
                zoom: kf.zoom,
                rotation: kf.rotation,
                keyframeIndex: idx,
              };
            })
            .filter((p): p is NonNullable<typeof p> => p != null);

          if (points.length < 2) return null;

          const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

          const handleDragStart = (keyframeIdx: number) => (e: React.PointerEvent<SVGGElement>) => {
            e.stopPropagation();
            e.preventDefault();
            dragKeyframeIdxRef.current = keyframeIdx;
            keyframeDragHook.handlePointerDown(e);
          };

          return (
            <g className="camera-path-overlay">
              <path
                d={pathD}
                stroke="rgba(99, 102, 241, 0.5)"
                strokeWidth={2}
                fill="none"
                strokeDasharray="6 3"
                style={{ pointerEvents: 'none' }}
              />
              {points.map((p, i) => (
                <g key={i} style={{ cursor: 'move' }} onPointerDown={handleDragStart(p.keyframeIndex)}>
                  {p.zoom !== undefined && (
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={8 + (p.zoom ?? 1) * 6}
                      fill="none"
                      stroke="rgba(99, 102, 241, 0.4)"
                      strokeWidth={1.5}
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                  {p.rotation !== undefined && (
                    <line
                      x1={p.x}
                      y1={p.y}
                      x2={p.x + Math.cos((p.rotation - 90) * Math.PI / 180) * 20}
                      y2={p.y + Math.sin((p.rotation - 90) * Math.PI / 180) * 20}
                      stroke="rgba(245, 158, 11, 0.7)"
                      strokeWidth={2}
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                  <circle cx={p.x} cy={p.y} r={8} fill="rgba(99, 102, 241, 0.8)" stroke="white" strokeWidth={2} />
                  <text
                    x={p.x + 12}
                    y={p.y + 4}
                    fill="white"
                    fontSize={10}
                    style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)', pointerEvents: 'none' }}
                  >
                    {p.time.toFixed(1)}s
                  </text>
                </g>
              ))}
            </g>
          );
        })()}
      </svg>
    </div>
  );
}
