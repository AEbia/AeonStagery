import { useState } from 'react';
import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import { useSemanticAuthoringService } from '../context/AppContext';
import { createSemanticTimelineCorrelationId } from './semanticTimelineEditing';

export function useMarkerManager(documentStore: any) {
  const [markerPrompt, setMarkerPrompt] = useState<{ time: number } | null>(null);
  const semanticAuthoring = useSemanticAuthoringService();

  const handleAddMarker = (time: number) => {
    setMarkerPrompt({ time });
  };

  const completeAddMarker = async (time: number, label: string) => {
    setMarkerPrompt(null);
    if (!label || !semanticAuthoring || !documentStore.getCurrentSceneDocumentSnapshot?.()) return;
    await semanticAuthoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('timeline_marker_add'),
      origin: 'marker-prompt',
      kind: 'add-marker',
      time,
      label,
    });
  };

  const handleRemoveMarker = async (markerId: string) => {
    if (!semanticAuthoring || !documentStore.getCurrentSceneDocumentSnapshot?.()) return;
    await semanticAuthoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('timeline_marker_remove'),
      origin: 'marker-prompt',
      kind: 'remove-marker',
      markerId,
    });
  };

  return {
    markerPrompt,
    handleAddMarker,
    completeAddMarker,
    handleRemoveMarker,
    setMarkerPrompt,
  };
}
